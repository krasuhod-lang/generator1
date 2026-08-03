'use strict';
/**
 * emailQueueV2 — ОТДЕЛЬНАЯ очередь отправки писем для провокационного режима (V2).
 *
 * Полностью изолирована от классической очереди 'outreach-emails' (её НЕ трогаем):
 *   • своё имя очереди 'outreach-emails-v2' (свой набор ключей в Redis);
 *   • встроенная ЗАЩИТА: перед отправкой проверяем, что строка письма ЕСТЬ в БД
 *     и статус всё ещё 'queued'. Нет — пропускаем БЕЗ отправки и БЕЗ ретрая.
 *     Так очередь никогда не шлёт «сирот» (удалённые/устаревшие письма).
 *   • пропуски (free-провайдер / cooldown / отписка) — НЕ ретраятся (не жгут лимит).
 *
 * Отправку выполняет тот же sendEmail (переиспуем, ничего в нём не меняем).
 */
const { Queue, Worker } = require('bullmq');
const { connection } = require('../../../queue/queue');
const db = require('../../../config/db');
const { sendEmail } = require('../emailSender');

const QUEUE_NAME = 'outreach-emails-v2';

const emailQueueV2 = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 500 },
  },
});

emailQueueV2.on('error', (err) => {
  console.error('[outreach/emailQueueV2] error:', err.message);
});

// Ошибки-«пропуски» — их не имеет смысла ретраить (постоянные условия).
function _isSkip(msg) {
  return /Пропускаем бесплатный провайдер|Cooldown активен|отписал/i.test(String(msg || ''));
}

let workerV2 = null;

function startEmailWorkerV2() {
  if (workerV2) return;

  workerV2 = new Worker(QUEUE_NAME, async (job) => {
    const { emailId, to, subject, html, text, fromEmail, fromName, replyTo, unsubscribeUrl } = job.data;

    // ── ЗАЩИТА: письмо ещё актуально? ──────────────────────────────
    // Если строки нет (кампанию удалили / данные сбросили) или статус уже
    // не 'queued' — НЕ отправляем. Тихо завершаем (job completed, без ретрая).
    const { rows } = await db.query('SELECT status FROM outreach_emails WHERE id = $1', [emailId]);
    if (!rows.length) {
      console.warn(`[emailQueueV2] пропуск: строки нет в БД (emailId=${emailId}, to=${to})`);
      return { skipped: 'no_row' };
    }
    if (rows[0].status !== 'queued') {
      console.warn(`[emailQueueV2] пропуск: статус '${rows[0].status}' (emailId=${emailId})`);
      return { skipped: 'not_queued' };
    }

    // ── Отправка ────────────────────────────────────────────────────
    try {
      const { resendId } = await sendEmail({
        emailId, to, subject, html, text, fromEmail, fromName, replyTo, unsubscribeUrl,
      });
      await db.query(
        `INSERT INTO outreach_logs (campaign_id, level, message, meta)
         SELECT campaign_id, 'success', $1, $2 FROM outreach_emails WHERE id = $3`,
        [`Письмо отправлено (V2) на ${to}`, JSON.stringify({ resendId }), emailId],
      );
      return { sent: true };
    } catch (err) {
      await db.query(
        `UPDATE outreach_emails SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, emailId],
      );
      await db.query(
        `INSERT INTO outreach_logs (campaign_id, level, message, meta)
         SELECT campaign_id, 'error', $1, $2 FROM outreach_emails WHERE id = $3`,
        [`Ошибка отправки (V2) на ${to}: ${err.message}`, JSON.stringify({ error: err.message }), emailId],
      );
      // Пропуск (free/cooldown/отписка) — НЕ ретраим (пусто → job completed).
      if (_isSkip(err.message)) return { skipped: err.message };
      throw err; // настоящую ошибку — ретраим (BullMQ)
    }
  }, {
    connection,
    concurrency: 1,
    limiter: { max: 10, duration: 3600000 }, // 10 писем/час
  });

  workerV2.on('error', (err) => {
    console.error('[outreach/emailWorkerV2] error:', err.message);
  });

  console.log('[outreach] Email worker V2 запущен (отдельная очередь, защита от сирот, лимит 10/час)');
}

function stopEmailWorkerV2() {
  if (workerV2) { workerV2.close(); workerV2 = null; }
}

module.exports = { emailQueueV2, startEmailWorkerV2, stopEmailWorkerV2 };
