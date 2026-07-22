'use strict';
/**
 * emailComposer — генерирует персонализированное HTML-письмо
 * через DeepSeek на основе данных о компании-лиде.
 */
const { callLLM } = require('../llm/callLLM');

const SYSTEM_PROMPT = `Ты B2B-копирайтер. Отвечай ТОЛЬКО валидным JSON без markdown.
Напиши персонализированное холодное письмо: 3 абзаца + CTA, макс 150 слов.
Тон: деловой, живой. Упомяни домен/название в первом абзаце.
HTML: только inline-стили, Arial 14px #333, ссылки #0071E3.
Формат (строго):
{"subject":"тема до 60 символов","html":"<p style=\"font-family:Arial;font-size:14px;color:#333\">текст</p>"}`;

/**
 * @param {object} params
 * @param {object} params.prospect — данные о лиде
 * @param {string} params.senderName — имя отправителя
 * @param {string} params.senderCompany — название компании отправителя
 * @param {string} params.unsubscribeUrl — URL для отписки
 * @returns {Promise<{subject: string, html: string}>}
 */
async function composeEmail({ prospect, senderName, senderCompany, unsubscribeUrl }) {
  const dynamicsText = formatDynamics(prospect);

  const context = `Данные о компании-получателе:
- Сайт: ${prospect.url}
- Название: ${prospect.company_name || 'не определено'}
- Ниша: ${prospect.niche || 'не определена'}
- Город: ${prospect.city || 'не определён'}
- Услуги: ${(prospect.services || []).slice(0, 5).join(', ') || 'не определены'}
- Динамика видимости: ${dynamicsText}

Отправитель:
- Имя: ${senderName}
- Компания: ${senderCompany}`;

  const result = await callLLM('deepseek', SYSTEM_PROMPT, context, {
    retries: 3, temperature: 0.5, maxTokens: 2000,
    callLabel: 'outreach.emailComposer',
  });

  // Добавляем обязательный footer с отпиской
  const footer = `
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;font-family:Arial,sans-serif;">
  Вы получили это письмо, так как ваш сайт был найден в поисковой выдаче по тематике вашего бизнеса.

  <a href="${unsubscribeUrl}" style="color:#999;">Отписаться от рассылки</a>
</div>`;

  return {
    subject: result.subject,
    html: (result.html || '') + footer,
  };
}

function formatDynamics(prospect) {
  const y = prospect.dynamics_yandex;
  const g = prospect.dynamics_google;
  if (!y && !g) return 'данных нет';
  const parts = [];
  if (y) parts.push(`Яндекс: ${y === 'decline' ? 'падение' : y === 'growth' ? 'рост' : 'стагнация'}`);
  if (g) parts.push(`Google: ${g === 'decline' ? 'падение' : g === 'growth' ? 'рост' : 'стагнация'}`);
  return parts.join(', ');
}

module.exports = { composeEmail };
