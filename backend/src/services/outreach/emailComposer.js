'use strict';
/**
 * emailComposer — генерирует персонализированное HTML-письмо
 * через DeepSeek на основе данных о компании-лиде.
 *
 * Апгрейд (миграция 122):
 *   • Цифровая динамика keys.so (deviation_pct, first/last values) в тексте
 *   • Проекция падения на трафик → заявки → продажи
 *   • HTML-таблица динамики видимости с цветовой индикацией и подписью
 *   • Оффер бесплатного видео-аудита (3+ точки роста)
 */
const { callLLM } = require('../llm/callLLM');

const SYSTEM_PROMPT = `Ты — senior B2B-копирайтер SEO-агентства. Отвечай ТОЛЬКО валидным JSON без markdown.

ЗАДАЧА: написать персонализированное холодное письмо владельцу сайта.

СТРУКТУРА ПИСЬМА (строго 4 коротких абзаца, всего 120-170 слов):
1. Зацепка: конкретный факт о ИХ сайте (домен, ниша, город). Без воды.
2. Проблема В ЦИФРАХ: если в данных есть числовая динамика — используй её ДОСЛОВНО
   (например: "за последние N месяцев видимость в Google снизилась на 42%: с 810 до 469 запросов в топ-50").
   Затем проекция: что это значит в потерянном трафике и заявках
   (пример: "для ниши имплантации это примерно X-Y недополученных обращений в месяц").
3. Оффер: бесплатный ВИДЕО-АУДИТ их сайта — запишем видео с разбором минимум
   3 конкретных точек роста. Бесплатно, ни к чему не обязывает.
4. CTA: короткий вопрос — "Прислать видео-разбор?" или "Ответьте на письмо — пришлём в течение 2 дней".

ПРАВИЛА:
- Пиши ЗАКОНЧЕННЫЕ предложения. НИКОГДА не обрывай мысль на середине.
- ЗАПРЕЩЕНЫ слова: уникальный, эффективный, профессиональный, качественный, комплексный, инновационный
- Не выдумывай цифры. Используй ТОЛЬКО цифры из блока "Числовая динамика". Если цифр нет — пиши про нишу и конкурентов без конкретных процентов.
- Тон: деловой, живой, уверенный. Как эксперт эксперту.
- subject: до 55 символов, без спам-слов (бесплатно/скидка/срочно), лучше с названием их домена.

HTML: только inline-стили. Шрифт Arial 14px, цвет #333, ссылки #0071E3.
Каждый абзац — отдельный <p style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;margin:0 0 14px;">.

ФОРМАТ ОТВЕТА (строго один JSON-объект):
{"subject":"...","html":"<p ...>абзац 1</p><p ...>абзац 2</p><p ...>абзац 3</p><p ...>абзац 4</p>"}`;

/**
 * @param {object} params
 * @param {object} params.prospect — данные о лиде (включая dynamics_detail из миграции 122)
 * @param {string} params.senderName — имя отправителя
 * @param {string} params.senderCompany — название компании отправителя
 * @param {string} params.unsubscribeUrl — URL для отписки
 * @returns {Promise<{subject: string, html: string}>}
 */
async function composeEmail({ prospect, senderName, senderCompany, unsubscribeUrl }) {
  const detail = _parseDetail(prospect.dynamics_detail);
  const dynamicsText = formatDynamicsNumeric(prospect, detail);

  const context = `Данные о компании-получателе:
- Сайт: ${prospect.url}
- Название: ${prospect.company_name || 'не определено'}
- Ниша: ${prospect.niche || 'не определена'}
- Город: ${prospect.city || 'не определён'}
- Услуги: ${(prospect.services || []).slice(0, 5).join(', ') || 'не определены'}

Числовая динамика видимости (данные keys.so, метрика — количество запросов сайта в топ-50):
${dynamicsText}

Отправитель:
- Имя: ${senderName}
- Компания: ${senderCompany}`;

  const result = await callLLM('deepseek', SYSTEM_PROMPT, context, {
    retries: 3, temperature: 0.5, maxTokens: 3000,
    callLabel: 'outreach.emailComposer',
  });

  if (!result || !result.subject || !result.html) {
    throw new Error('emailComposer: LLM вернул неполный ответ (нет subject/html)');
  }

  // Таблица динамики — рендерим детерминированно кодом (не LLM),
  // чтобы цифры в таблице всегда совпадали с данными keys.so.
  const dynamicsTable = buildDynamicsTable(detail);

  // Обязательный footer с отпиской
  const footer = `
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;font-family:Arial,sans-serif;">
  Вы получили это письмо, так как ваш сайт был найден в поисковой выдаче по тематике вашего бизнеса.
  <a href="${unsubscribeUrl}" style="color:#999;">Отписаться от рассылки</a>
</div>`;

  return {
    subject: result.subject,
    html: (result.html || '') + dynamicsTable + footer,
  };
}

/** Парсит dynamics_detail (может прийти строкой из pg JSONB или объектом). */
function _parseDetail(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * Форматирует числовую динамику для промпта DeepSeek.
 * Пример вывода:
 *   - Google: ПАДЕНИЕ на 42.1% за 7 мес (с 810 до 469 запросов в топ-50)
 *   - Яндекс: рост на 18.2% за 7 мес (с 650 до 768 запросов в топ-50)
 */
function formatDynamicsNumeric(prospect, detail) {
  const lines = [];
  const labels = { yandex: 'Яндекс', google: 'Google' };
  const trends = { growth: 'рост', decline: 'ПАДЕНИЕ', stagnation: 'стагнация' };

  for (const engine of ['yandex', 'google']) {
    const d = detail?.[engine];
    if (d && Number.isFinite(Number(d.deviation_pct)) && d.first && d.last) {
      const pct = Math.abs(Number(d.deviation_pct)).toFixed(1);
      const months = d.months || '?';
      lines.push(
        `- ${labels[engine]}: ${trends[d.trend] || d.trend} на ${pct}% за ${months} мес ` +
        `(с ${d.first.value} до ${d.last.value} запросов в топ-50)`
      );
    } else {
      // Fallback на trend без цифр
      const t = prospect[`dynamics_${engine}`];
      if (t) lines.push(`- ${labels[engine]}: ${trends[t] || t} (точных цифр нет)`);
    }
  }
  return lines.length ? lines.join('\n') : 'данных нет — не используй конкретные цифры в письме';
}

/**
 * Детерминированная HTML-таблица динамики для тела письма.
 * Рендерится кодом (не LLM) — цифры гарантированно совпадают с keys.so.
 * Возвращает '' если числовых данных нет.
 */
function buildDynamicsTable(detail) {
  if (!detail) return '';
  const rows = [];
  const labels = { yandex: 'Яндекс', google: 'Google' };

  for (const engine of ['yandex', 'google']) {
    const d = detail[engine];
    if (!d || !Number.isFinite(Number(d.deviation_pct)) || !d.first || !d.last) continue;
    const pct = Number(d.deviation_pct);
    const isDecline = d.trend === 'decline';
    const color = isDecline ? '#D32F2F' : d.trend === 'growth' ? '#2E7D32' : '#757575';
    const arrow = isDecline ? '▼' : d.trend === 'growth' ? '▲' : '●';
    const sign = pct > 0 ? '+' : '';
    rows.push(`
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:Arial,sans-serif;font-size:13px;color:#333;">${labels[engine]}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:Arial,sans-serif;font-size:13px;color:#333;text-align:center;">${d.first.value}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:Arial,sans-serif;font-size:13px;color:#333;text-align:center;">${d.last.value}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:${color};text-align:center;">${arrow} ${sign}${pct.toFixed(1)}%</td>
    </tr>`);
  }

  if (!rows.length) return '';

  return `
<table style="border-collapse:collapse;margin:18px 0 6px;border:1px solid #eee;border-radius:6px;">
  <tr style="background:#f7f7f7;">
    <th style="padding:8px 12px;font-family:Arial,sans-serif;font-size:12px;color:#666;text-align:left;">Поисковая система</th>
    <th style="padding:8px 12px;font-family:Arial,sans-serif;font-size:12px;color:#666;">Было</th>
    <th style="padding:8px 12px;font-family:Arial,sans-serif;font-size:12px;color:#666;">Сейчас</th>
    <th style="padding:8px 12px;font-family:Arial,sans-serif;font-size:12px;color:#666;">Динамика</th>
  </tr>${rows.join('')}
</table>
<div style="font-family:Arial,sans-serif;font-size:11px;color:#999;margin:0 0 14px;">
  Количество запросов вашего сайта в топ-50 поисковой выдачи (данные сервиса аналитики keys.so).
</div>`;
}

module.exports = { composeEmail, buildDynamicsTable, formatDynamicsNumeric };
