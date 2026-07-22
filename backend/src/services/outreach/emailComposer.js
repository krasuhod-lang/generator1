'use strict';
/**
 * emailComposer — генерирует персонализированное HTML-письмо
 * через DeepSeek на основе данных о компании-лиде.
 */
const { callLLM } = require('../llm/callLLM');

const SYSTEM_PROMPT = `Ты — опытный B2B-копирайтер для SEO-агентства.
Пишешь персонализированные холодные email.

СТРОГИЕ ПРАВИЛА:
1. Длина: 3-4 абзаца, максимум 180 слов в тексте
2. Первый абзац: конкретный факт о сайте получателя (домен, ниша, город)
3. Второй абзац: их конкретная проблема с данными (если есть динамика — используй)
4. Третий абзац: что предлагаем (конкретно, 1-2 предложения)
5. CTA: один вопрос или предложение созвониться
6. ЗАПРЕЩЕНЫ слова: уникальный, эффективный, профессиональный, качественный, комплексный
7. Тон: деловой, живой, не роботизированный
8. Обязательно упомянуть домен или название компании в первом абзаце

Верни ТОЛЬКО JSON без markdown:
{
  "subject": "тема письма (до 60 символов, без спам-слов)",
  "html": "HTML-тело письма (только содержимое body, без html/head/body тегов)"
}

HTML должен использовать только inline-стили. Шрифт: Arial, 14px, цвет #333.
Ссылки: цвет #0071E3.`;

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
    retries: 2, temperature: 0.75, maxTokens: 1200,
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
