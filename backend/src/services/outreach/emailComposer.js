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
 * @param {string} [params.senderSite] — наш сайт (для блока «связаться»)
 * @param {string} [params.senderTelegram] — Telegram отправителя (@user или ссылка)
 * @returns {Promise<{subject: string, html: string, text: string}>}
 */
async function composeEmail({
  prospect, senderName, senderCompany, unsubscribeUrl, senderSite, senderTelegram,
}) {
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

  // Тему письма собираем детерминированно кодом, чтобы она была разнообразной
  // у каждого письма, помещалась в читаемую область и содержала гео/цифры
  // по проекту (req 1). LLM-вариант используем как запасной.
  const subject = buildCatchySubject({ prospect, detail }) || _clipSubject(result.subject);

  // Персонализированный заголовок-плашка: белый текст на синем фоне (req 2 —
  // чёрный на синем читается плохо). Тянем гео и цифры по проекту (req 1).
  const heroHeading = buildHeroHeading({ prospect, detail });
  const hero = `
<div style="background:#0071E3;border-radius:10px 10px 0 0;padding:22px 24px;">
  <div style="font-family:Arial,sans-serif;font-size:20px;font-weight:bold;color:#ffffff;line-height:1.3;margin:0;">${_escapeHtml(heroHeading)}</div>
</div>`;

  // Таблица динамики — рендерим детерминированно кодом (не LLM),
  // чтобы цифры в таблице всегда совпадали с данными keys.so.
  const dynamicsTable = buildDynamicsTable(detail);

  // Блок контактов отправителя (req 3): наш сайт + ссылка на Telegram,
  // чтобы получатель мог связаться. Обязательная «отсылка» внизу письма.
  const contactBlock = buildContactBlock({ senderName, senderCompany, senderSite, senderTelegram });

  // Обязательный footer с отпиской
  const footer = `
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;font-family:Arial,sans-serif;">
  Вы получили это письмо, так как ваш сайт был найден в поисковой выдаче по тематике вашего бизнеса.
  <a href="${unsubscribeUrl}" style="color:#999;">Отписаться от рассылки</a>
</div>`;

  const body = `
<div style="padding:22px 24px 4px;">${result.html || ''}${dynamicsTable}</div>`;

  const html = `
<div style="max-width:600px;margin:0 auto;border:1px solid #eee;border-radius:10px;overflow:hidden;background:#ffffff;">
  ${hero}${body}
  <div style="padding:0 24px 20px;">${contactBlock}${footer}</div>
</div>`;

  return {
    subject,
    html,
    text: buildPlainText({ heroHeading, html: result.html, senderName, senderCompany, senderSite, senderTelegram, unsubscribeUrl }),
  };
}

/** Обрезает тему до читаемой длины (≤ 60 символов). */
function _clipSubject(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 59).trim() + '…' : t;
}

/** Домен сайта без www / протокола. */
function _domainOf(url) {
  if (!url) return 'ваш сайт';
  try {
    const u = url.includes('://') ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, '');
  } catch (_) {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || 'ваш сайт';
  }
}

/** Стабильный неотрицательный хэш строки (для разнообразия шаблонов). */
function _hash(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Наибольшее падение видимости из detail (для цифр в теме/заголовке). */
function _biggestDecline(detail) {
  if (!detail) return null;
  let best = null;
  for (const engine of ['yandex', 'google']) {
    const d = detail[engine];
    if (!d || d.trend !== 'decline' || !Number.isFinite(Number(d.deviation_pct))) continue;
    const pct = Math.abs(Number(d.deviation_pct));
    if (!best || pct > best.pct) best = { engine, pct: Math.round(pct) };
  }
  return best;
}

/** Минимальное экранирование HTML для подстановки в шаблон. */
function _escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Тема письма (req 1): разнообразная у каждого письма, помещается в
 * читаемую область (≤ ~50 символов), тянет гео (город) и цифры по проекту.
 * Разнообразие — детерминированный выбор шаблона по хэшу домена.
 * @returns {string}
 */
function buildCatchySubject({ prospect, detail }) {
  const domain = _domainOf(prospect?.url);
  const city = (prospect?.city || '').trim();
  const drop = _biggestDecline(detail);
  const templates = [];

  if (drop) {
    templates.push(`${domain}: видимость −${drop.pct}%`);
    templates.push(`${city ? city + ': ' : ''}−${drop.pct}% трафика`);
    templates.push(`${domain} теряет позиции: −${drop.pct}%`);
  }
  if (city) {
    templates.push(`${city}: ${domain} и конкуренты`);
    templates.push(`SEO-разбор ${domain} — ${city}`);
  }
  templates.push(`Разбор сайта ${domain}`);
  templates.push(`${domain}: 3 точки роста`);
  templates.push(`Что тормозит трафик ${domain}`);

  const idx = _hash(prospect?.url || domain) % templates.length;
  return _clipSubjectReadable(templates[idx]);
}

/** Обрезает тему под читаемую область почтовика (≤ 50 символов). */
function _clipSubjectReadable(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 50 ? t.slice(0, 49).trim() + '…' : t;
}

/**
 * Заголовок-плашка внутри письма (req 1/2): белый текст на синем фоне,
 * разнообразный, с гео и цифрами по проекту.
 * @returns {string}
 */
function buildHeroHeading({ prospect, detail }) {
  const domain = _domainOf(prospect?.url);
  const city = (prospect?.city || '').trim();
  const drop = _biggestDecline(detail);
  const variants = [];

  if (drop) {
    variants.push(`${domain}: видимость в поиске снизилась на ${drop.pct}%`);
    variants.push(`${city ? city + ': ' : ''}трафик ${domain} падает на ${drop.pct}%`);
  }
  if (city) {
    variants.push(`${city}: как ${domain} обойти конкурентов в поиске`);
  }
  variants.push(`${domain}: 3 точки роста поискового трафика`);
  variants.push(`Бесплатный видео-разбор сайта ${domain}`);

  const idx = _hash((prospect?.url || domain) + 'hero') % variants.length;
  return variants[idx];
}

/**
 * Блок контактов отправителя (req 3): наш сайт + ссылка на Telegram.
 * Обязательная «отсылка» внизу письма, чтобы клиент мог связаться.
 * @returns {string}
 */
function buildContactBlock({ senderName, senderCompany, senderSite, senderTelegram }) {
  const links = [];
  const site = _normalizeUrl(senderSite);
  if (site) {
    links.push(`<a href="${_escapeHtml(site)}" style="color:#0071E3;text-decoration:none;">${_escapeHtml(_domainOf(site))}</a>`);
  }
  const tg = _normalizeTelegram(senderTelegram);
  if (tg) {
    links.push(`<a href="${_escapeHtml(tg.url)}" style="color:#0071E3;text-decoration:none;">Telegram: ${_escapeHtml(tg.label)}</a>`);
  }

  const signName = senderName ? _escapeHtml(senderName) : '';
  const signCompany = senderCompany && senderCompany !== senderName ? _escapeHtml(senderCompany) : '';
  const sign = [signName, signCompany].filter(Boolean).join(', ');

  const linksHtml = links.length
    ? `<div style="margin-top:6px;">${links.join(' &nbsp;·&nbsp; ')}</div>`
    : '';

  return `
<div style="margin-top:22px;padding-top:16px;border-top:1px solid #e5e5e5;font-family:Arial,sans-serif;font-size:13px;color:#555;line-height:1.6;">
  <div style="font-weight:bold;color:#333;">${sign || 'С уважением'}</div>
  <div>Готов ответить на вопросы — напишите мне удобным способом:</div>
  ${linksHtml}
</div>`;
}

/** Нормализует произвольную ссылку сайта в https-URL или null. */
function _normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return `https://${s}`;
  return null;
}

/**
 * Нормализует Telegram-контакт: @user | user | t.me/user | ссылка.
 * @returns {{url: string, label: string}|null}
 */
function _normalizeTelegram(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    const handle = s.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/\/+$/, '');
    return { url: s, label: handle ? `@${handle.replace(/^@/, '')}` : s };
  }
  const user = s.replace(/^@/, '').replace(/^t\.me\//i, '');
  if (!user) return null;
  return { url: `https://t.me/${user}`, label: `@${user}` };
}

/** Текстовая (plain-text) версия письма — повышает доставляемость (req 4). */
function buildPlainText({ heroHeading, html, senderName, senderCompany, senderSite, senderTelegram, unsubscribeUrl }) {
  const bodyText = String(html || '')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const contacts = [];
  const site = _normalizeUrl(senderSite);
  if (site) contacts.push(`Сайт: ${site}`);
  const tg = _normalizeTelegram(senderTelegram);
  if (tg) contacts.push(`Telegram: ${tg.label} (${tg.url})`);

  const sign = [senderName, senderCompany && senderCompany !== senderName ? senderCompany : '']
    .filter(Boolean).join(', ');

  return [
    heroHeading,
    '',
    bodyText,
    '',
    sign ? `С уважением, ${sign}` : 'С уважением',
    ...contacts,
    '',
    `Отписаться: ${unsubscribeUrl}`,
  ].join('\n');
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

module.exports = {
  composeEmail, buildDynamicsTable, formatDynamicsNumeric,
  buildCatchySubject, buildHeroHeading, buildContactBlock,
};
