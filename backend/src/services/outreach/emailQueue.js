'use strict';
/**
 * emailQueue — BullMQ очередь для отправки писем с throttling.
 * Использует существующее Redis-соединение из src/queue/queue.js.
 */
const { Queue, Worker } = require('bullmq');
const { connection } = require('../../queue/queue');
const db = require('../../config/db');
const { sendEmail } = require('./emailSender');

const EMAIL_QUEUE_NAME = 'outreach-emails';

// Создаём очередь
const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 }, // 1→2→4 минуты
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 500 },
  },
});

emailQueue.on('error', (err) => {
  console.error('[outreach/emailQueue] error:', err.message);
});

// Worker с throttling: не более 10 писем в час
let emailWorker = null;

function startEmailWorker() {
  if (emailWorker) return;

  emailWorker = new Worker(EMAIL_QUEUE_NAME, async (job) => {
    const { emailId, to, subject, html, fromEmail, fromName } = job.data;

    try {
      const { resendId } = await sendEmail({ emailId, to, subject, html, fromEmail, fromName });

      // Логируем успех
      await db.query(
        `INSERT INTO outreach_logs (campaign_id, level, message, meta)
         SELECT campaign_id, 'success', $1, $2
           FROM outreach_emails WHERE id = $3`,
        [`Письмо отправлено на ${to}`, JSON.stringify({ resendId }), emailId],
      );
    } catch (err) {
      // Обновляем статус ошибки
      await db.query(
        `UPDATE outreach_emails SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, emailId],
      );

      await db.query(
        `INSERT INTO outreach_logs (campaign_id, level, message, meta)
         SELECT campaign_id, 'error', $1, $2
           FROM outreach_emails WHERE id = $3`,
        [`Ошибка отправки на ${to}: ${err.message}`, JSON.stringify({ error: err.message }), emailId],
      );

      throw err; // BullMQ сделает retry
    }
  }, {
    connection,
    concurrency: 1,
    limiter: {
      // Глобальный предохранитель воркера. Реальный темп задаёт задержка job'ов
      // (calculateSendDelay) по часовому лимиту прогрева; лимитер лишь страхует
      // от всплесков. Поднят до 60/час, чтобы не тормозить недели 3–5
      // (до 55 писем/час). Переопределяется через OUTREACH_MAX_PER_HOUR.
      max: Number(process.env.OUTREACH_MAX_PER_HOUR) || 60,
      duration: 3600000, // за 1 час
    },
  });

  emailWorker.on('error', (err) => {
    console.error('[outreach/emailWorker] error:', err.message);
  });

  console.log(`[outreach] Email worker запущен (лимит: ${Number(process.env.OUTREACH_MAX_PER_HOUR) || 60} писем/час)`);
}

async function stopEmailWorker() {
  if (emailWorker) {
    const w = emailWorker;
    emailWorker = null;
    try {
      await w.close(); // дожидаемся завершения активной отправки, освобождаем lock
    } catch (e) {
      console.warn('[outreach/emailWorker] ошибка при закрытии:', e.message);
    }
  }
}

module.exports = { emailQueue, startEmailWorker, stopEmailWorker };
