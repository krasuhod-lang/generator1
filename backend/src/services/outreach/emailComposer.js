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
 *
 * Доработка (миграция 123):
 *   • Защита от обрыва письма: эскалация maxTokens + assertComplete + fallback
 *     (по аналогии с metaTags/gistMetaFilter — письмо собирается ВСЕГДА).
 *   • DSPy-усиление промпта (сигнатура OutreachColdEmail) для «человеческого»
 *     тона — graceful при недоступности aegis_py (статический промпт).
 *   • Детерминированная «цепляющая» тема с цифрой падения из keys.so.
 *   • Inline-SVG график динамики видимости в теле письма (emailChart).
 */
const { callLLM } = require('../llm/callLLM');
const { buildPromptSuffix } = require('../projects/dspyClient');
const { buildDynamicsChart } = require('./emailChart');

// Стоп-слова/спам-маркеры для валидации темы письма.
const SUBJECT_MAX_LEN = 55;
const SUBJECT_SPAM_WORDS = ['бесплатно', 'скидка', 'срочно', 'акция', 'гарантия', 'распродажа'];

// Эскалация лимита вывода при обрыве письма (аналог gistMetaFilter).
const COMPOSE_ATTEMPTS = 3;
const BASE_MAX_TOKENS = 4000;
const MAX_TOKENS_CEILING = 12000;

const SYSTEM_PROMPT = `Ты — senior B2B-копирайтер SEO-агентства. Отвечай ТОЛЬКО валидным JSON без markdown.

ЗАДАЧА: написать персонализированное холодное письмо владельцу сайта.

СТРУКТУРА ПИСЬМА (строго 4 коротких абзаца, всего 120-170 слов):
1. Зацепка: конкретный факт о ИХ сайте (домен, ниша, город). Без воды, без «Здравствуйте, меня зовут».
2. Проблема В ЦИФРАХ: работай с трендами РАЗДЕЛЬНО.
   • ПАДЕНИЕ — используй числа ДОСЛОВНО (например: "за последние N месяцев видимость в Google
     снизилась на 42%: с 810 до 469 запросов в топ-50"), затем ОБЯЗАТЕЛЬНАЯ проекция
     «падение → трафик → заявки → ₽» (пример: "для ниши имплантации это примерно X-Y
     недополученных обращений в месяц").
   • РОСТ — покажи, где сайт всё равно недобирает против конкурентов.
   • СТАГНАЦИЯ — покажи упущенный потенциал и что мешает росту.
3. Оффер: бесплатный ВИДЕО-АУДИТ их сайта — запишем видео с разбором минимум
   3 конкретных точек роста. Бесплатно, ни к чему не обязывает.
4. CTA: короткий живой вопрос — "Прислать видео-разбор?" или "Ответьте на письмо — пришлём в течение 2 дней".

ПРАВИЛА:
- Пиши ЗАКОНЧЕННЫЕ предложения. НИКОГДА не обрывай мысль на середине.
- Верни ПОЛНЫЙ JSON. Если текст не помещается — СОКРАТИ формулировки, но не обрывай абзац и не оставляй висящих тегов.
- ЗАПРЕЩЕНЫ клише: уникальный, эффективный, профессиональный, качественный, комплексный,
  инновационный, надёжный, широкий спектр, команда профессионалов, индивидуальный подход.
- Не выдумывай цифры. Используй ТОЛЬКО цифры из блока "Числовая динамика". Если цифр нет — пиши про нишу и конкурентов без конкретных процентов.
- Единый tone-of-voice: деловой, живой, тёплый, уверенный. Как эксперт эксперту.
- subject: до 55 символов, без спам-слов (бесплатно/скидка/срочно/акция), лучше с названием их домена и цифрой потери.

HTML: только inline-стили. Шрифт Arial 14px, цвет #333, ссылки #0071E3.
Каждый абзац — отдельный <p style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;margin:0 0 14px;">.

ФОРМАТ ОТВЕТА (строго один JSON-объект):
{"subject":"...","html":"<p ...>абзац 1</p><p ...>абзац 2</p><p ...>абзац 3</p><p ...>абзац 4</p>"}`;

// Подсказка при повторной попытке после обрыва/незаконченного письма.
const REPAIR_HINT = `

[КРИТИЧНО — предыдущая попытка вернула ОБРЕЗАННОЕ или НЕЗАКОНЧЕННОЕ письмо]
Верни ТОЛЬКО валидный JSON {"subject":"...","html":"..."}:
- ровно 4 абзаца <p>...</p>, все теги закрыты;
- каждое предложение ЗАКОНЧЕНО (оканчивается на . ! или ?);
- держи формулировки КРАТКИМИ, чтобы гарантированно уложиться в лимит вывода;
- без markdown и текста до/после JSON.`;

/**
 * @param {object} params
 * @param {object} params.prospect — данные о лиде (включая dynamics_detail из миграции 122)
 * @param {string} params.senderName — имя отправителя
 * @param {string} params.senderCompany — название компании отправителя
 * @param {string} params.unsubscribeUrl — URL для отписки
 * @returns {Promise<{subject:string, html:string, strategy:string, manual_review_required:boolean}>}
 */
async function composeEmail({ prospect, senderName, senderCompany, unsubscribeUrl }) {
  const detail = _parseDetail(prospect.dynamics_detail);
  const dynamicsText = formatDynamicsNumeric(prospect, detail);

  // Детерминированная «цепляющая» тема (числа из keys.so, не выдуманы LLM).
  const subjectPlan = buildCatchySubject(prospect, detail);

  const context = `Данные о компании-получателе:
- Сайт: ${prospect.url}
- Название: ${prospect.company_name || 'не определено'}
- Ниша: ${prospect.niche || 'не определена'}
- Город: ${prospect.city || 'не определён'}
- Услуги: ${(prospect.services || []).slice(0, 5).join(', ') || 'не определены'}

Числовая динамика видимости (данные keys.so, метрика — количество запросов сайта в топ-50):
${dynamicsText}

Рекомендованная тема (можешь улучшить, но сохрани цифру потери и длину ≤ 55 символов): ${subjectPlan.subject}

Отправитель:
- Имя: ${senderName}
- Компания: ${senderCompany}`;

  // DSPy-усиление промпта (graceful: пустая строка при недоступности aegis_py).
  let dspySuffix = '';
  try {
    dspySuffix = await buildPromptSuffix('OutreachColdEmail', {
      niche: prospect.niche || null,
      city: prospect.city || null,
      dynamics: detail || null,
    });
  } catch (_) { dspySuffix = ''; }
  const systemPrompt = dspySuffix ? `${SYSTEM_PROMPT}\n${dspySuffix}` : SYSTEM_PROMPT;

  // Таблица + график динамики — рендерим детерминированно кодом (не LLM),
  // чтобы цифры всегда совпадали с данными keys.so.
  const dynamicsTable = buildDynamicsTable(detail);
  const dynamicsChart = buildDynamicsChart(detail).html;
  const footer = _buildFooter(unsubscribeUrl);

  // ── Эскалация maxTokens + проверка завершённости письма ──────────────
  let maxTokens = BASE_MAX_TOKENS;
  let userPrompt = context;
  let bodyHtml = null;
  let subject = subjectPlan.subject;

  for (let attempt = 1; attempt <= COMPOSE_ATTEMPTS; attempt += 1) {
    let result = null;
    try {
      result = await callLLM('deepseek', systemPrompt, userPrompt, {
        retries: 3, temperature: 0.5, maxTokens,
        callLabel: 'outreach.emailComposer',
      });
    } catch (_) { result = null; }

    const html = result && typeof result.html === 'string' ? result.html.trim() : '';
    if (html && assertComplete(html)) {
      bodyHtml = html;
      // LLM-тему принимаем, только если она валидна; иначе оставляем детерминированную.
      const llmSubject = result && typeof result.subject === 'string' ? result.subject.trim() : '';
      if (llmSubject && isValidSubject(llmSubject)) subject = llmSubject;
      break;
    }

    // Обрыв/незаконченное письмо — эскалируем лимит и добавляем ремонт-подсказку.
    maxTokens = Math.min(Math.round(maxTokens * 1.5), MAX_TOKENS_CEILING);
    userPrompt = context + REPAIR_HINT;
  }

  // Fallback: детерминированный шаблон (письмо собирается ВСЕГДА).
  let manualReviewRequired = false;
  if (!bodyHtml) {
    bodyHtml = _fallbackBody(prospect, detail, senderName || senderCompany);
    manualReviewRequired = true;
  }

  return {
    subject,
    html: bodyHtml + dynamicsChart + dynamicsTable + footer,
    strategy: subjectPlan.strategy,
    manual_review_required: manualReviewRequired,
  };
}

/**
 * Проверяет завершённость сгенерированного письма:
 *   • есть хотя бы один абзац <p>…</p>;
 *   • число открытых и закрытых <p> совпадает (нет висящих тегов);
 *   • нет обрыва на незакрытом теге;
 *   • последний абзац оканчивается законченным предложением.
 */
function assertComplete(html) {
  if (!html || typeof html !== 'string') return false;
  const s = html.trim();

  const open = (s.match(/<p[\s>]/gi) || []).length;
  const close = (s.match(/<\/p>/gi) || []).length;
  if (open === 0 || open !== close) return false;

  // Обрыв на незакрытом теге (последний '<' без последующего '>').
  const lastLt = s.lastIndexOf('<');
  const lastGt = s.lastIndexOf('>');
  if (lastLt > lastGt) return false;

  // Текст последнего абзаца должен оканчиваться завершённым предложением.
  const paras = s.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  if (!paras.length) return false;
  // Снимаем теги многопроходно (пока строка меняется), чтобы вложенные/битые
  // конструкции не оставляли остатков. Текст используется ТОЛЬКО для проверки
  // завершённости предложения и никуда не рендерится.
  let lastInner = paras[paras.length - 1];
  let prev;
  do { prev = lastInner; lastInner = lastInner.replace(/<[^>]*>/g, ''); }
  while (lastInner !== prev);
  lastInner = lastInner.replace(/&nbsp;/g, ' ').trim();
  if (lastInner.length < 3) return false;
  if (!/[.!?…»")]$/.test(lastInner)) return false;

  return true;
}

/**
 * Детерминированная «цепляющая» тема письма на основе dynamics_detail.
 * Цифры берутся ТОЛЬКО из keys.so — не выдумываются.
 * @returns {{subject:string, strategy:string}}
 */
function buildCatchySubject(prospect, detail) {
  const domain = _domainOf(prospect.url);
  const labels = { yandex: 'Яндекс', google: 'Google' };

  // Ищем движок с наибольшим падением.
  let worst = null;
  if (detail) {
    for (const engine of ['yandex', 'google']) {
      const d = detail[engine];
      if (!d || d.trend !== 'decline' || !Number.isFinite(Number(d.deviation_pct))) continue;
      const pct = Math.abs(Number(d.deviation_pct));
      if (!worst || pct > worst.pct) worst = { engine, pct };
    }
  }

  if (worst) {
    const pctInt = Math.round(worst.pct);
    const base = domain
      ? `${domain}: −${pctInt}% видимости в ${labels[worst.engine]}`
      : `Теряете ${pctInt}% видимости в ${labels[worst.engine]}`;
    return { subject: _clipSubject(base), strategy: 'numeric_drop' };
  }

  // Нет падения — конкурентный угол.
  const competitor = domain
    ? `${domain}: конкуренты обгоняют в выдаче`
    : 'Конкуренты обгоняют вас в поиске';
  return { subject: _clipSubject(competitor), strategy: 'competitor' };
}

/** Тема валидна: непустая, ≤ лимита, без спам-слов. */
function isValidSubject(subject) {
  if (!subject || typeof subject !== 'string') return false;
  const s = subject.trim();
  if (!s || s.length > SUBJECT_MAX_LEN) return false;
  const low = s.toLowerCase();
  return !SUBJECT_SPAM_WORDS.some((w) => low.includes(w));
}

function _clipSubject(s) {
  const t = String(s || '').trim();
  return t.length > SUBJECT_MAX_LEN ? t.slice(0, SUBJECT_MAX_LEN - 1).trim() + '…' : t;
}

function _domainOf(url) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}

/** Обязательный footer с отпиской. */
function _buildFooter(unsubscribeUrl) {
  return `
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;font-family:Arial,sans-serif;">
  Вы получили это письмо, так как ваш сайт был найден в поисковой выдаче по тематике вашего бизнеса.
  <a href="${unsubscribeUrl}" style="color:#999;">Отписаться от рассылки</a>
</div>`;
}

/**
 * Детерминированный fallback-шаблон письма (когда LLM не вернул законченный
 * текст). Собирается из данных keys.so, помечается manual_review_required.
 */
function _fallbackBody(prospect, detail, senderName) {
  const domain = _domainOf(prospect.url);
  const p = (text) =>
    `<p style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;margin:0 0 14px;">${text}</p>`;

  const nicheTxt = prospect.niche ? ` в нише «${prospect.niche}»` : '';
  const cityTxt = prospect.city ? ` (${prospect.city})` : '';

  // Абзац с цифрами, если есть падение.
  let problem = 'Мы проанализировали видимость вашего сайта в поиске и заметили точки роста, которые сейчас не используются.';
  if (detail) {
    for (const engine of ['yandex', 'google']) {
      const d = detail[engine];
      if (d && d.trend === 'decline' && Number.isFinite(Number(d.deviation_pct)) && d.first && d.last) {
        const label = engine === 'yandex' ? 'Яндексе' : 'Google';
        problem = `За последнее время видимость вашего сайта в ${label} снизилась на ${Math.abs(Number(d.deviation_pct)).toFixed(1)}%: ` +
          `с ${d.first.value} до ${d.last.value} запросов в топ-50. Это напрямую бьёт по трафику и числу обращений с поиска.`;
        break;
      }
    }
  }

  return [
    p(`Здравствуйте! Посмотрел ваш сайт ${domain}${nicheTxt}${cityTxt}.`),
    p(problem),
    p('Готов записать короткое видео с разбором минимум 3 конкретных точек роста именно по вашему сайту. Бесплатно и ни к чему не обязывает.'),
    p(`Прислать видео-разбор? Ответьте на это письмо — подготовлю в течение 2 дней.<br>— ${senderName || 'SEO Team'}`),
  ].join('');
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
  composeEmail,
  buildDynamicsTable,
  formatDynamicsNumeric,
  buildCatchySubject,
  assertComplete,
  isValidSubject,
};
