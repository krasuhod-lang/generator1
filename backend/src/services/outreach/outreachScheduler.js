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
const { buildProvocationEmailV2 } = require('./provocation'); // V2 провокационный режим (email_mode='provocation')
const { emailQueueV2 } = require('./provocation/emailQueueV2'); // V2: отдельная очередь отправки
const { emailQueue } = require('./emailQueue');
const { processSerpB2bTask } = require('../serpB2b/pipeline');

const POLL_MS = 60 * 60 * 1000; // 1 час
let _timer = null;

async function runTick() {
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

  // 3. Берём лиды с высоким score, которым ещё не отправляли.
  //    Для V2 (provocation) — ТОЛЬКО полностью подготовленные (provocation_ready):
  //    письмо уходит лишь когда по лиду собрано всё (конкуренты + прогноз + кейсы).
  const readyFilter = campaign.email_mode === 'provocation' ? 'AND provocation_ready = TRUE' : '';
  const { rows: prospects } = await db.query(
    `SELECT * FROM outreach_prospects
      WHERE campaign_id = $1
        AND status = 'new'
        AND array_length(emails, 1) > 0
        AND score >= 50
        ${readyFilter}
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
      const ok = await prepareAndQueueEmail(campaign, prospect, {
        fromEmail, fromName, appUrl, index: queued, total: prospects.length,
      });
      if (ok) queued++;
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

/**
 * Готовит и ставит в очередь одно письмо для лида: генерирует текст,
 * создаёт запись outreach_emails, сохраняет токен отписки и отправляет
 * в BullMQ. Используется общим конвейером и прямой рассылкой (req 5).
 * @returns {Promise<boolean>} true — если письмо поставлено в очередь.
 */
async function prepareAndQueueEmail(campaign, prospect, opts) {
  const { fromEmail, fromName, appUrl, index = 0, total = 1 } = opts;

  const email = (prospect.emails || []).find(isCorporateEmail) || (prospect.emails || [])[0];
  if (!email) return false;

  const domain = email.split('@')[1];

  // Генерируем письмо
  const unsubToken = crypto.randomBytes(16).toString('hex');
  const unsubUrl = `${appUrl}/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubToken}`;

  // Выбор письма по режиму кампании:
  //   • 'provocation' (V2) — отправляем ТОЛЬКО провокационное письмо. Если оно
  //     почему-то не собралось — лид ПРОПУСКАЕМ и НЕ шлём старое классическое
  //     вместо него (иначе клиенту уходит «не то письмо»). Дособерётся позже.
  //   • 'classic' — прежнее поведение без изменений.
  let composed;
  if (campaign.email_mode === 'provocation') {
    try {
      composed = await buildProvocationEmailV2({
        prospect: { ...prospect, niche: prospect.niche || campaign.niche },
        campaign,
        sender: {
          senderName: fromName,
          senderCompany: fromName,
          senderSite: campaign.sender_site,
          senderTelegram: campaign.sender_telegram,
        },
        unsubscribeUrl: unsubUrl,
        appUrl,
      });
    } catch (err) {
      await log(campaign.id, 'warn', `V2-письмо не собралось для ${prospect.url} — лид пропущен (старое НЕ шлём): ${err.message}`);
      return false;
    }
    if (!composed) {
      await log(campaign.id, 'warn', `V2-письмо пустое для ${prospect.url} — лид пропущен (старое НЕ шлём)`);
      return false;
    }
  } else {
    composed = await composeEmail({
      prospect: { ...prospect, niche: prospect.niche || campaign.niche, dynamics_detail: prospect.dynamics_detail },
      senderName: fromName,
      senderCompany: fromName,
      unsubscribeUrl: unsubUrl,
      senderSite: campaign.sender_site,
      senderTelegram: campaign.sender_telegram,
    });
  }

  // Создаём запись письма в БД
  const { rows: emailRows } = await db.query(
    `INSERT INTO outreach_emails
       (prospect_id, campaign_id, user_id, recipient_email, recipient_domain, subject, html_preview, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
     RETURNING id`,
    [
      prospect.id, campaign.id, campaign.user_id,
      email, domain,
      composed.subject, composed.html.slice(0, 500),
    ],
  );
  const emailId = emailRows[0].id;

  // Сохраняем токен отписки
  await db.query(
    `INSERT INTO outreach_unsubscribes (email, domain, token)
     VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
    [email.toLowerCase(), domain, unsubToken],
  );

  // Ставим в очередь с задержкой (равномерно в течение рабочего дня, МСК).
  const delayMs = calculateSendDelay(index, total);
  // Маршрутизация очереди: V2-кампании (provocation) → ОТДЕЛЬНАЯ чистая очередь
  // с защитой от сирот. Классика ('classic') → прежняя очередь, без изменений.
  const targetQueue = campaign.email_mode === 'provocation' ? emailQueueV2 : emailQueue;
  await targetQueue.add('send-email', {
    emailId, to: email,
    subject: composed.subject,
    html: composed.html,
    text: composed.text,
    fromEmail, fromName,
    replyTo: campaign.sender_email || fromEmail,
    unsubscribeUrl: unsubUrl,
  }, { delay: delayMs });

  // Обновляем статус лида
  await db.query(
    `UPDATE outreach_prospects SET status = 'queued' WHERE id = $1`,
    [prospect.id],
  );

  return true;
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
              messengers, niche, city, services, dynamics_yandex, dynamics_google,
              dynamics_detail, score, score_breakdown, source_serp_task)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (url, campaign_id) DO NOTHING`,
          [
            campaign.id, campaign.user_id, site.url, site.company_name,
            site.inn, site.emails || [], site.phones || [],
            JSON.stringify(Array.isArray(site.messengers) ? site.messengers : []),
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

  // Провокационный режим (V2): обогащение запускаем В ФОНЕ и НЕ ждём его —
  // сбор лидов завершается сразу. Фон сам наполнит пул кейсов и посчитает
  // конкурентов+прогноз под каждый лид; готовые лиды подхватит фаза отправки.
  if (campaign.email_mode === 'provocation') {
    setImmediate(() => enrichProvocationCampaignV2(campaign).catch((e) =>
      console.warn(`[outreach] Провокация(фон) ${campaign.id}: ${e.message}`)));
  }

  await log(campaign.id, 'info', `Собрано новых лидов: ${collected}`);
}

// Идёт ли уже фоновое обогащение по кампании — чтобы тики планировщика не
// запускали параллельные проходы по одним и тем же лидам.
const _provocationEnriching = new Set();

/**
 * Фоновое обогащение провокационной кампании (V2). НЕ блокирует сбор/отправку.
 * 1) пул кейсов (растущие ТОП-10 сайты по городам кампании);
 * 2) под КАЖДЫЙ email-worthy лид — конкуренты + прогноз (provocation_ready=true).
 * Готовые лиды затем берёт обычная фаза отправки (только provocation_ready).
 * ИЗОЛЯЦИЯ: работает лишь для email_mode='provocation', пишет в V2-поля.
 */
async function enrichProvocationCampaignV2(campaign) {
  if (_provocationEnriching.has(campaign.id)) return;
  _provocationEnriching.add(campaign.id);
  const appUrl = process.env.APP_URL || '';
  try {
    // 1. Пул кейсов из выдачи кампании (растущие сайты, что в ТОП-10).
    try {
      const { harvestCasesForCampaignV2 } = require('./provocation/caseHarvester');
      const h = await harvestCasesForCampaignV2(campaign.id, {});
      if (h.cases) await log(campaign.id, 'info', `Провокация: собрано кейсов (ТОП-10): ${h.cases}`);
    } catch (e) {
      await log(campaign.id, 'warn', `Провокация: сбор кейсов пропущен: ${e.message}`);
    }

    // 2. Полный предрасчёт каждого лида: конкуренты + прогноз.
    const { prepareProspectProvocationV2 } = require('./provocation/prepareProspect');
    // Дособираем любых НЕ готовых email-worthy лидов (конкуренты; прогноз в V2
    // отключён). Как только найден хотя бы один прямой конкурент — лид ready.
    const { rows: toPrep } = await db.query(
      `SELECT * FROM outreach_prospects
        WHERE campaign_id = $1 AND status = 'new'
          AND array_length(emails, 1) > 0 AND score >= 50
          AND provocation_ready IS NOT TRUE
        ORDER BY score DESC LIMIT 25`,
      [campaign.id],
    );
    let done = 0;
    for (const pr of toPrep) {
      try {
        await prepareProspectProvocationV2(pr, { campaign, appUrl });
        done++;
      } catch (e) {
        await log(campaign.id, 'warn', `Провокация: подготовка ${pr.url} пропущена: ${e.message}`);
      }
    }
    if (done) {
      await log(campaign.id, 'success',
        `Провокация: полностью готово лидов: ${done} — уходят в отправку индивидуальными письмами`);
    }
  } finally {
    _provocationEnriching.delete(campaign.id);
  }
}

// Равномерно распределяем отправку в рабочие часы по МСК (07:00–18:00),
// чтобы письма уходили в «человеческое» время и не выглядели как спам-бот.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3
const WORK_START_HOUR = 7;
const WORK_END_HOUR = 18;

function calculateSendDelay(index, total) {
  const now = new Date();
  // Текущее МСК-время как «настенное».
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const y = msk.getUTCFullYear();
  const mo = msk.getUTCMonth();
  const d = msk.getUTCDate();

  // Границы окна отправки в МСК, переведённые обратно в UTC-таймстемпы.
  let workStart = Date.UTC(y, mo, d, WORK_START_HOUR, 0, 0) - MSK_OFFSET_MS;
  let workEnd = Date.UTC(y, mo, d, WORK_END_HOUR, 0, 0) - MSK_OFFSET_MS;

  // Если рабочий день по МСК уже закончился — переносим на завтра.
  if (now.getTime() > workEnd) {
    workStart = Date.UTC(y, mo, d + 1, WORK_START_HOUR, 0, 0) - MSK_OFFSET_MS;
    workEnd = Date.UTC(y, mo, d + 1, WORK_END_HOUR, 0, 0) - MSK_OFFSET_MS;
  }
  // Если ещё не начался — ждём открытия окна.
  const start = Math.max(workStart, now.getTime());

  const workMs = Math.max(0, workEnd - start);
  const step = workMs / Math.max(total, 1);
  const target = start + step * index;
  return Math.max(0, target - now.getTime());
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

module.exports = {
  startOutreachScheduler, stopOutreachScheduler, runTick,
  prepareAndQueueEmail, calculateSendDelay,
};
