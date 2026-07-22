'use strict';
/**
 * outreachScheduler — фоновый планировщик кампаний.
 * Каждые 60 минут проверяет активные кампании и запускает
 * сбор лидов + постановку писем в очередь.
 *
 * Паттерн: аналогичен seoBrainScheduler.js
 */
const crypto = require('crypto');
const db = require('../../config/db');
const { expandNicheToGeo } = require('./nicheExpander');
const { scoreProspect, isCorporateEmail } = require('./prospectScorer');
const { composeEmail } = require('./emailComposer');
const { emailQueue } = require('./emailQueue');
const { precheckRecipient } = require('./emailSender');
const { processSerpB2bTask } = require('../serpB2b/pipeline');

const POLL_MS = 60 * 60 * 1000; // 1 час
let _timer = null;
let _schemaReady = null;

/**
 * Идемпотентно гарантирует наличие колонок модуля Outreach, добавленных
 * поздними миграциями (122, 123). Планировщик может стартовать раньше, чем
 * основной ensureSchema успеет применить миграции на проде, либо бэкенд мог
 * не перезапускаться после деплоя — тогда INSERT в outreach_prospects падал
 * с «column "dynamics_detail" ... does not exist». Эта функция самовосстанавливает
 * схему прямо из планировщика (безопасно выполнять на каждый старт).
 */
function ensureOutreachSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    // Миграция 122: числовая динамика keys.so + разделение токенов/отписок.
    await db.query(`ALTER TABLE outreach_prospects ADD COLUMN IF NOT EXISTS dynamics_detail JSONB`);
    await db.query(`ALTER TABLE outreach_unsubscribes ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ`);
    // Миграция 123: полный HTML письма, стратегия темы, флаг ручной проверки.
    await db.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS html_full TEXT`);
    await db.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS subject_strategy TEXT`);
    await db.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN DEFAULT FALSE`);
  })().catch((e) => {
    // Не кэшируем ошибку — дадим следующему тику попробовать снова.
    _schemaReady = null;
    throw e;
  });
  return _schemaReady;
}

async function runTick() {
  await ensureOutreachSchema();

  // Находим кампании, которым пора запуститься
  const { rows: campaigns } = await db.query(
    `SELECT * FROM outreach_campaigns
      WHERE status = 'active'
        AND (next_run_at IS NULL OR next_run_at <= NOW())
      ORDER BY next_run_at ASC NULLS FIRST
      LIMIT 5`
  );

  for (const campaign of campaigns) {
    try {
      await runCampaignCycle(campaign);
    } catch (err) {
      console.error(`[outreach] Ошибка кампании ${campaign.id}:`, err.message);
      await db.query(
        `UPDATE outreach_campaigns SET status = 'error', error_message = $1 WHERE id = $2`,
        [err.message, campaign.id],
      );
    }
  }
}

async function runCampaignCycle(campaign) {
  const appUrl = process.env.APP_URL || 'https://localhost:3000';
  const fromEmail = process.env.OUTREACH_FROM_EMAIL || campaign.sender_email;
  const fromName = process.env.OUTREACH_FROM_NAME || campaign.sender_name || 'SEO Team';

  await log(campaign.id, 'info', `Запуск цикла кампании: ${campaign.name}`);

  // 1. Определяем дневной лимит по расписанию прогрева
  const { rows: warmup } = await db.query(
    `SELECT daily_limit FROM outreach_warmup_schedule WHERE week_number = $1`,
    [campaign.warmup_week],
  );
  const dailyLimit = Math.min(
    campaign.daily_limit,
    warmup[0]?.daily_limit || 10,
  );

  // 2. Считаем сколько уже отправили сегодня
  const { rows: todaySent } = await db.query(
    `SELECT COUNT(*) as cnt FROM outreach_emails
      WHERE campaign_id = $1
        AND sent_at > NOW() - INTERVAL '24 hours'`,
    [campaign.id],
  );
  const sentToday = parseInt(todaySent[0]?.cnt || 0);
  const canSendToday = dailyLimit - sentToday;

  if (canSendToday <= 0) {
    await log(campaign.id, 'info', `Дневной лимит исчерпан (${dailyLimit} писем). Следующий запуск завтра.`);
    await db.query(
      `UPDATE outreach_campaigns SET next_run_at = NOW() + INTERVAL '24 hours' WHERE id = $1`,
      [campaign.id],
    );
    return;
  }

  // 3. Берём лиды с высоким score, которым ещё не отправляли
  const { rows: prospects } = await db.query(
    `SELECT * FROM outreach_prospects
      WHERE campaign_id = $1
        AND status = 'new'
        AND array_length(emails, 1) > 0
        AND score >= 50
      ORDER BY score DESC
      LIMIT $2`,
    [campaign.id, canSendToday],
  );

  if (prospects.length === 0) {
    // Нет лидов — запускаем новый сбор
    await log(campaign.id, 'info', 'Нет новых лидов, запускаем сбор...');
    await collectNewProspects(campaign);
    await db.query(
      `UPDATE outreach_campaigns SET next_run_at = NOW() + INTERVAL '2 hours' WHERE id = $1`,
      [campaign.id],
    );
    return;
  }

  // 4. Генерируем письма и ставим в очередь
  let queued = 0;
  for (const prospect of prospects) {
    try {
      const email = prospect.emails.find(isCorporateEmail) || prospect.emails[0];
      if (!email) continue;

      // Предпроверка получателя ДО генерации/постановки в очередь: отсекаем
      // бесплатные провайдеры, реальные отписки и домены на cooldown, чтобы
      // не тратить LLM-вызов и не засорять очередь непроходными письмами.
      const precheck = await precheckRecipient(email);
      if (!precheck.ok) {
        await log(campaign.id, 'info', `Пропуск ${email}: ${precheck.reason}`);
        await db.query(
          `UPDATE outreach_prospects SET status = 'rejected' WHERE id = $1`,
          [prospect.id],
        );
        continue;
      }

      // Генерируем письмо
      const unsubToken = crypto.randomBytes(16).toString('hex');
      const unsubUrl = `${appUrl}/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubToken}`;

      const composed = await composeEmail({
        prospect: { ...prospect, niche: campaign.niche, dynamics_detail: prospect.dynamics_detail },
        senderName: fromName,
        senderCompany: fromName,
        unsubscribeUrl: unsubUrl,
      });

      // Создаём запись письма в БД. Храним ПОЛНЫЙ HTML (html_full) для
      // корректного превью в UI + короткий html_preview для списков.
      const { rows: emailRows } = await db.query(
        `INSERT INTO outreach_emails
           (prospect_id, campaign_id, user_id, recipient_email, recipient_domain,
            subject, html_preview, html_full, subject_strategy, manual_review_required, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued')
         RETURNING id`,
        [
          prospect.id, campaign.id, campaign.user_id,
          email, email.split('@')[1],
          composed.subject, composed.html.slice(0, 500), composed.html,
          composed.strategy || null, composed.manual_review_required === true,
        ],
      );
      const emailId = emailRows[0].id;

      // Сохраняем токен отписки
      await db.query(
        `INSERT INTO outreach_unsubscribes (email, domain, token)
         VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
        [email.toLowerCase(), email.split('@')[1], unsubToken],
      );

      // Ставим в очередь с задержкой (равномерно в течение рабочего дня).
      // jobId = emailId → идемпотентность: повторный тик не создаст дубль job.
      const delayMs = calculateSendDelay(queued, prospects.length);
      await emailQueue.add('send-email', {
        emailId, to: email,
        subject: composed.subject,
        html: composed.html,
        fromEmail, fromName,
      }, { delay: delayMs, jobId: `email-${emailId}` });

      // Обновляем статус лида
      await db.query(
        `UPDATE outreach_prospects SET status = 'queued' WHERE id = $1`,
        [prospect.id],
      );

      queued++;
    } catch (err) {
      await log(campaign.id, 'warn', `Ошибка подготовки письма для ${prospect.url}: ${err.message}`);
    }
  }

  // 5. Обновляем статистику кампании
  await db.query(
    `UPDATE outreach_campaigns
        SET total_sent = total_sent + $1,
            last_run_at = NOW(),
            next_run_at = NOW() + INTERVAL '24 hours',
            updated_at = NOW()
      WHERE id = $2`,
    [queued, campaign.id],
  );

  // 6. Проверяем прогрев (раз в неделю повышаем лимит)
  await checkWarmupProgression(campaign);

  await log(campaign.id, 'success', `Поставлено в очередь: ${queued} писем`);
}

async function collectNewProspects(campaign) {
  const { analysis, serpTasks } = await expandNicheToGeo({
    keyword: campaign.keyword,
    cities: campaign.cities,
    searchEngine: campaign.search_engine,
    depthPages: campaign.depth_pages,
  });

  // Обновляем нишу если ещё не определена
  if (!campaign.niche && analysis.niche) {
    await db.query(
      `UPDATE outreach_campaigns SET niche = $1, business_type = $2 WHERE id = $3`,
      [analysis.niche, analysis.business_type, campaign.id],
    );
  }

  let collected = 0;
  for (const taskParams of serpTasks) {
    try {
      // Создаём serpB2b задачу
      const { rows } = await db.query(
        `INSERT INTO serp_b2b_tasks
           (user_id, name, query, search_engine, depth_pages, region, status, inputs)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb)
         RETURNING id`,
        [
          campaign.user_id, taskParams.name, taskParams.query,
          taskParams.search_engine, taskParams.depth_pages, taskParams.region,
          JSON.stringify(taskParams),
        ],
      );
      const serpTaskId = rows[0].id;

      // Запускаем пайплайн
      await processSerpB2bTask(serpTaskId, campaign.user_id);

      // Забираем результаты и создаём лиды
      const { rows: serpRows } = await db.query(
        `SELECT results FROM serp_b2b_tasks WHERE id = $1`,
        [serpTaskId],
      );
      const results = serpRows[0]?.results || [];

      for (const site of results) {
        if (!site.emails?.length) continue;
        const { score, breakdown } = scoreProspect(site);
        if (score < 30) continue; // отсеиваем совсем плохие лиды

        // Числовая динамика keys.so для писем с цифрами (миграция 122):
        // deviation_pct + first/last points из growthEvaluator.
        const dynamicsDetail = {};
        for (const engine of ['yandex', 'google']) {
          const d = site.dynamics?.[engine];
          if (!d) continue;
          dynamicsDetail[engine] = {
            trend: d.trend,
            deviation_pct: d.deviation_pct,
            first: d.first_point || null,
            last: d.last_point || null,
            metric: d.metric || 'keywords_top50',
            months: d.months_tracked || null,
          };
        }
        await db.query(
          `INSERT INTO outreach_prospects
             (campaign_id, user_id, url, company_name, inn, emails, phones,
              niche, city, services, dynamics_yandex, dynamics_google,
              dynamics_detail, score, score_breakdown, source_serp_task)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (url, campaign_id) DO NOTHING`,
          [
            campaign.id, campaign.user_id, site.url, site.company_name,
            site.inn, site.emails || [], site.phones || [],
            taskParams._niche, taskParams._city, site.services || [],
            site.dynamics?.yandex?.trend || null,
            site.dynamics?.google?.trend || null,
            Object.keys(dynamicsDetail).length ? JSON.stringify(dynamicsDetail) : null,
            score, JSON.stringify(breakdown), serpTaskId,
          ],
        );
        collected++;
      }
    } catch (err) {
      await log(campaign.id, 'warn', `Ошибка сбора по запросу "${taskParams.query}": ${err.message}`);
    }
  }

  await db.query(
    `UPDATE outreach_campaigns SET total_prospects = total_prospects + $1 WHERE id = $2`,
    [collected, campaign.id],
  );

  await log(campaign.id, 'info', `Собрано новых лидов: ${collected}`);
}

// Равномерно распределяем отправку в рабочие часы (9:00-18:00)
function calculateSendDelay(index, total) {
  const now = new Date();
  const workStart = new Date(now);
  workStart.setHours(9, 0, 0, 0);
  const workEnd = new Date(now);
  workEnd.setHours(18, 0, 0, 0);

  if (now > workEnd) {
    workStart.setDate(workStart.getDate() + 1);
    workEnd.setDate(workEnd.getDate() + 1);
  }

  const workMs = workEnd - workStart;
  const step = workMs / Math.max(total, 1);
  const target = new Date(workStart.getTime() + step * index);
  const delay = target - now;
  return Math.max(0, delay);
}

async function checkWarmupProgression(campaign) {
  if (!campaign.last_run_at) return;
  const daysSinceStart = Math.floor((Date.now() - new Date(campaign.created_at)) / 86400000);
  const expectedWeek = Math.min(5, Math.floor(daysSinceStart / 7) + 1);
  if (expectedWeek > campaign.warmup_week) {
    await db.query(
      `UPDATE outreach_campaigns SET warmup_week = $1 WHERE id = $2`,
      [expectedWeek, campaign.id],
    );
    await log(campaign.id, 'info', `Прогрев: переход на неделю ${expectedWeek} (лимит ${[10, 25, 60, 120, 200][expectedWeek - 1]} писем/день)`);
  }
}

async function log(campaignId, level, message, meta = null) {
  await db.query(
    `INSERT INTO outreach_logs (campaign_id, level, message, meta) VALUES ($1, $2, $3, $4)`,
    [campaignId, level, message, meta ? JSON.stringify(meta) : null],
  );
}

function startOutreachScheduler() {
  if (_timer) return;
  runTick().catch((e) => console.warn('[outreach/scheduler] initial tick:', e.message));
  _timer = setInterval(() => {
    runTick().catch((e) => console.warn('[outreach/scheduler] interval:', e.message));
  }, POLL_MS);
  console.log('[outreach] Scheduler запущен (интервал: 1 час)');
}

function stopOutreachScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startOutreachScheduler, stopOutreachScheduler, runTick };
