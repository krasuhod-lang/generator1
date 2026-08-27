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
    const { rows } = await db.query('SELECT status, attempt_count FROM outreach_emails WHERE id = $1', [emailId]);
    if (!rows.length) {
      console.warn(`[emailQueueV2] пропуск: строки нет в БД (emailId=${emailId}, to=${to})`);
      return { skipped: 'no_row' };
    }
    if (rows[0].status !== 'queued') {
      console.warn(`[emailQueueV2] пропуск: статус '${rows[0].status}' (emailId=${emailId})`);
      return { skipped: 'not_queued' };
    }

    // ── Отправка ────────────────────────────────────────────────────
    await db.query(
      `UPDATE outreach_emails
          SET attempt_count = COALESCE(attempt_count, 0) + 1,
              last_attempt_at = NOW(),
              error_message = NULL
        WHERE id = $1 AND status = 'queued'`,
      [emailId],
    );
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
      // Постоянные условия (отписка, free provider, cooldown) не имеют
      // смысла ретраить — это финальный skip. Для transient provider errors
      // оставляем строку queued: BullMQ сможет выполнить следующую попытку.
      if (_isSkip(err.message)) {
        await db.query(
          `UPDATE outreach_emails SET status = 'failed', failed_at = COALESCE(failed_at, NOW()), error_message = $1 WHERE id = $2 AND status = 'queued'`,
          [err.message, emailId],
        );
        await db.query(
          `INSERT INTO outreach_logs (campaign_id, level, message, meta)
           SELECT campaign_id, 'warn', $1, $2 FROM outreach_emails WHERE id = $3`,
          [`Письмо пропущено (V2) на ${to}: ${err.message}`, JSON.stringify({ error: err.message, permanent: true }), emailId],
        );
        return { skipped: err.message };
      }
      await db.query(
        `UPDATE outreach_emails SET error_message = $1, failed_at = NULL WHERE id = $2 AND status = 'queued'`,
        [err.message, emailId],
      );
      await db.query(
        `INSERT INTO outreach_logs (campaign_id, level, message, meta)
         SELECT campaign_id, 'warn', $1, $2 FROM outreach_emails WHERE id = $3`,
        [`Временная ошибка отправки (V2), повторим: ${to}: ${err.message}`, JSON.stringify({ error: err.message, retryable: true }), emailId],
      );
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

  // BullMQ emits `failed` only after all configured attempts are exhausted.
  // Mark the DB row failed here, not inside the retryable worker catch.
  workerV2.on('failed', async (job, err) => {
    const emailId = job?.data?.emailId;
    if (!emailId) return;
    try {
      await db.query(
        `UPDATE outreach_emails
            SET status = 'failed', failed_at = COALESCE(failed_at, NOW()), error_message = $1
          WHERE id = $2 AND status = 'queued'`,
        [err?.message || 'Email delivery failed after retries', emailId],
      );
      await db.query(
        `INSERT INTO outreach_logs (campaign_id, level, message, meta)
         SELECT campaign_id, 'error', $1, $2 FROM outreach_emails WHERE id = $3`,
        [
          `Отправка окончательно не удалась (V2) на ${job.data.to || 'unknown recipient'}`,
          JSON.stringify({ error: err?.message || 'unknown', attempts: job.attemptsMade }),
          emailId,
        ],
      );
    } catch (dbErr) {
      console.error('[outreach/emailWorkerV2] failed event persistence:', dbErr.message);
    }
  });

  console.log('[outreach] Email worker V2 запущен (отдельная очередь, защита от сирот, лимит 10/час)');
}

function stopEmailWorkerV2() {
  if (workerV2) { workerV2.close(); workerV2 = null; }
}

module.exports = { emailQueueV2, startEmailWorkerV2, stopEmailWorkerV2 };
