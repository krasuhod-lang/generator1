'use strict';
/**
 * emailComposerProvocation — сборка «провокационного» письма.
 *
 * Отдельный НОВЫЙ композер (старый emailComposer.js не трогаем). Собирает
 * письмо по согласованной логике:
 *   провокация (прямые конкуренты + разрыв, объяснение механики выдачи)
 *   → авторитет («знаем, за счёт чего они наверху»)
 *   → прогноз (кнопка-ссылка по сайту лида)
 *   → неоспоримый пруф (наши топ-сайты из ДРУГИХ городов + запросы с объёмом)
 *   → CTA («ответьте — пришлём план»).
 *
 * Все цифры рисует КОД (детерминированно). LLM пишет только живые связки
 * (intro/authority/cta) — опционально; при отсутствии есть текстовый фолбэк,
 * поэтому модуль рендерит письмо и без похода в LLM (удобно для preview/тестов).
 *
 * Слово-единица (пациент/клиент/заявка/заказ) приходит из nicheProfile.
 */

const P = 'font-family:Arial,sans-serif;';
const TEXT = `${P}font-size:14px;color:#333;line-height:1.6;margin:0 0 14px;`;

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _domain(url) {
  if (!url) return '';
  try {
    const u = url.includes('://') ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, '');
  } catch (_) {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}
function _num(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('ru-RU');
}
function _greeting(now = new Date()) {
  const h = new Date(now.getTime() + 3 * 3600 * 1000).getUTCHours(); // МСК
  if (h >= 5 && h < 12) return 'Доброе утро';
  if (h >= 12 && h < 18) return 'Добрый день';
  if (h >= 18 && h < 23) return 'Добрый вечер';
  return 'Здравствуйте';
}

// Предложный падеж города («в Москве», «в Казани»). Карта для сложных случаев
// (миллионники), для остальных — наивное правило по окончанию.
const CITY_PREP = {
  'Москва': 'Москве', 'Санкт-Петербург': 'Санкт-Петербурге', 'Новосибирск': 'Новосибирске',
  'Екатеринбург': 'Екатеринбурге', 'Казань': 'Казани', 'Нижний Новгород': 'Нижнем Новгороде',
  'Ростов-на-Дону': 'Ростове-на-Дону', 'Уфа': 'Уфе', 'Самара': 'Самаре', 'Пермь': 'Перми',
  'Омск': 'Омске', 'Челябинск': 'Челябинске', 'Воронеж': 'Воронеже', 'Волгоград': 'Волгограде',
  'Красноярск': 'Красноярске', 'Тюмень': 'Тюмени', 'Краснодар': 'Краснодаре', 'Саратов': 'Саратове',
  'Томск': 'Томске', 'Минск': 'Минске',
};
function _prep(city) {
  const c = String(city || '').trim();
  if (!c) return '';
  if (CITY_PREP[c]) return CITY_PREP[c];
  if (/[ьй]$/i.test(c)) return c.slice(0, -1) + 'и';   // Пермь→Перми
  if (/а$/i.test(c)) return c.slice(0, -1) + 'е';       // Ялта→Ялте
  if (/[бвгдзклмнпрстф]$/i.test(c)) return c + 'е';     // Курск→Курске
  return c;
}
function _inCity(city, prefix = ' в ') {
  const c = _prep(city);
  return c ? `${prefix}${c}` : '';
}

/** Плашка-заголовок: прямой конкурент обходит их в их городе. */
function _hero(anchorDomain, city) {
  const where = city ? ` в ${_esc(_prep(city))}` : '';
  const txt = anchorDomain
    ? `${_esc(anchorDomain)} забирает ваших клиентов${where}`
    : `Вы теряете клиентов из поиска${where}`;
  return `
<div style="background:#0071E3;border-radius:10px 10px 0 0;padding:22px 24px;">
  <div style="${P}font-size:20px;font-weight:bold;color:#fff;line-height:1.3;margin:0;">${txt}</div>
</div>`;
}

/** Оборачивает блок в секцию-карточку с лёгкой подложкой (визуальное разделение блоков). */
function _section(html, bg, border) {
  if (!html || !String(html).trim()) return '';
  return `<div style="margin:0 0 16px;padding:14px 16px 2px;background:${bg};border:1px solid ${border};border-radius:10px;">${html}</div>`;
}

/** Яркий призыв к действию — самый заметный блок письма (по требованию — особенно он). */
function _ctaBox(text) {
  return `
<div style="margin:8px 0 4px;padding:18px 20px;background:#0071E3;border-radius:10px;">
  <div style="${P}font-size:16px;font-weight:bold;color:#ffffff;line-height:1.45;margin:0;">${_esc(text)}</div>
</div>`;
}

/** Ярлык конкурента: «Название компании» (сайт); если имени нет — просто сайт. */
function _competitorLabel(c) {
  const d = _esc(c.domain);
  const name = (c.company_name || '').trim();
  return name ? `«${_esc(name)}» (${d})` : `<b>${d}</b>`;
}

/** Перечисление конкурентов через запятую с «и» перед последним. */
function _joinRu(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return items.join(' и ');
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

/** Блок конкурентов: механика выдачи + список выше лида + разрыв. */
function _competitorBlock({ competitors, prospectTraffic, city, sampleQuery, unit }) {
  if (!competitors || !competitors.length) return '';
  const where = city ? ` в ${_esc(_prep(city))}` : '';
  const q = sampleQuery ? `«${_esc(sampleQuery)}»` : 'ваши услуги';

  const rows = competitors.map((c) => `
    <tr>
      <td style="padding:6px 0;${P}font-size:14px;color:#333;">▸ ${c.company_name ? `<b>${_esc(c.company_name)}</b> <span style="color:#888;">(${_esc(c.domain)})</span>` : `<b>${_esc(c.domain)}</b>`}</td>
      <td style="padding:6px 0 6px 16px;${P}font-size:14px;color:#333;white-space:nowrap;">~${_num(c.traffic_month)} визитов/мес</td>
    </tr>`).join('');

  const gap = prospectTraffic
    ? `А ваш сайт — примерно <b>${_num(prospectTraffic)} визитов/мес</b>. Разница в разы. Этот поток идёт к ним, не к вам.`
    : `Ваш сайт — заметно ниже. Этот поток идёт к ним, не к вам.`;

  return `
<p style="${TEXT}">Когда человек в Яндексе или Google ищет ${q} — <b>первым он видит их сайты, а не ваш</b>. Туда и заходит. Так ваш потенциальный клиент становится их клиентом.</p>
<p style="${TEXT}">Вот кто стоит <b>выше вас</b>${where} прямо сейчас:</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">${rows}</table>
<p style="${TEXT}">${gap}</p>`;
}

/**
 * Авторитетный блок: «они наверху не случайно — за этим проверенный алгоритм,
 * мы его знаем и умеем повторять для вас». Это смысловой мост от конкурентов
 * (проблема) к кейсам (доказательство) — показывается ВСЕГДА, чтобы логика
 * письма не рвалась. Кнопка-прогноз добавляется ТОЛЬКО при валидной ссылке;
 * если прогноза нет — блок остаётся связным и без «висящих» обещаний.
 */
function _authorityBlock(forecastUrl, unit) {
  const intro = `<p style="${TEXT}">Они наверху не случайно — за этим стоит <b>проверенный алгоритм продвижения</b>, по которому агентства выводят сайты в топ. Мы этот алгоритм знаем — и умеем повторять его для вашего сайта.</p>`;
  if (!forecastUrl) return intro;
  return `${intro}
<p style="${TEXT}">Мы уже посчитали, на какой трафик и сколько ${_esc(unit)} по нему реально выйти вашему сайту:</p>
<div style="margin:0 0 18px;">
  <a href="${_esc(forecastUrl)}" style="display:inline-block;background:#0071E3;color:#fff;${P}font-size:15px;font-weight:bold;text-decoration:none;padding:13px 24px;border-radius:8px;">▶ Смотреть прогноз по вашему сайту</a>
</div>`;
}

/** Блок кейсов: наши топ-сайты из ДРУГИХ городов + запросы с объёмом. */
function _casesBlock(cases, unit) {
  if (!cases || !cases.length) return '';
  const cards = cases.map((c) => {
    const kws = (c.top_keywords || []).map((k) =>
      `<div style="${P}font-size:13px;color:#333;margin:2px 0 0;">• «${_esc(k.phrase)}» — ${_num(k.volume)} ищут/мес</div>`
    ).join('');
    const leads = (c.leads_min && c.leads_max)
      ? ` · ~${_num(c.leads_min)}–${_num(c.leads_max)} ${_esc(unit)}/мес <span style="color:#999;">(примерно — коммерческая информация)</span>`
      : '';
    return `
<div style="margin:0 0 14px;padding:12px 14px;border:1px solid #eee;border-radius:8px;">
  <div style="${P}font-size:14px;color:#111;"><b>${_esc(c.domain)}</b> · ${_esc(c.city)}</div>
  <div style="${P}font-size:13px;color:#555;margin:2px 0 6px;">~${_num(c.traffic_month)} визитов/мес${leads}</div>
  <div style="${P}font-size:12px;color:#888;">в топ-10 и забирает трафик по запросам:</div>
  ${kws}
</div>`;
  }).join('');

  return `
<p style="${TEXT}">И это не просто слова. Вот сайты, <b>которые мы уже вывели в ТОП-10</b>. Они не просто забирают трафик — <b>расширяют клиентскую базу</b>, и некоторые уже думают о масштабировании бизнеса. Откройте поиск и проверьте сами:</p>
${cards}
<p style="${TEXT}">Вбейте эти запросы — увидите сайты на первых местах. Каждый ищут тысячи раз в месяц, и весь этот поток идёт им.</p>`;
}

/** Подпись + контакты. */
function _signature({ senderName, senderCompany, senderSite, senderTelegram }) {
  const links = [];
  if (senderSite) links.push(`<a href="${_esc(senderSite)}" style="color:#0071E3;text-decoration:none;">${_esc(_domain(senderSite))}</a>`);
  if (senderTelegram) {
    const h = String(senderTelegram).replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
    links.push(`<a href="https://t.me/${_esc(h)}" style="color:#0071E3;text-decoration:none;">Telegram: @${_esc(h)}</a>`);
  }
  const sign = [senderName, senderCompany && senderCompany !== senderName ? senderCompany : ''].filter(Boolean).join(', ');
  return `
<div style="margin-top:22px;padding-top:16px;border-top:1px solid #e5e5e5;${P}font-size:13px;color:#555;line-height:1.6;">
  <div style="font-weight:bold;color:#333;">${_esc(sign || 'С уважением')}</div>
  <div>Ответлю на вопросы — напишите удобным способом:</div>
  ${links.length ? `<div style="margin-top:6px;">${links.join(' &nbsp;·&nbsp; ')}</div>` : ''}
</div>`;
}

/**
 * Тема письма: прямой конкурент обходит их в их городе.
 */
function buildSubject({ anchorDomain, city, prospectDomain }) {
  let base;
  if (anchorDomain) {
    base = city ? `${anchorDomain} обходит вас в ${_prep(city)}` : `${anchorDomain} обходит вас в поиске`;
  } else {
    base = prospectDomain ? `${prospectDomain}: где вы теряете клиентов` : 'Где вы теряете клиентов из поиска';
  }
  return base.length > 60 ? base.slice(0, 59).trim() + '…' : base;
}

/**
 * Собирает провокационное письмо.
 * @param {object} p
 * @param {object} p.prospect            — лид {url, city}
 * @param {Array}  p.competitors         — [{domain, traffic_month}], отсортированы по силе
 * @param {number} [p.prospectTraffic]   — трафик самого лида (визиты/мес)
 * @param {Array}  p.cases               — [{domain, city, traffic_month, leads_min, leads_max, top_keywords}]
 * @param {string} [p.forecastUrl]       — ссылка на прогноз
 * @param {string} p.unit                — слово-единица под нишу (пациентов/заявок/…)
 * @param {string} [p.sampleQuery]       — пример запроса ниши (для механики выдачи)
 * @param {object} p.sender              — {senderName, senderCompany, senderSite, senderTelegram}
 * @param {string} p.unsubscribeUrl
 * @param {object} [p.connective]        — {intro?, cta?} живые связки от LLM (опц.)
 * @returns {{subject:string, html:string, text:string}}
 */
function composeProvocationEmailV2(p) {
  const {
    prospect, competitors = [], prospectTraffic, cases = [], forecastUrl,
    unit = 'заявок', sampleQuery, sender = {}, unsubscribeUrl, connective = {},
  } = p;

  const city = prospect?.city || '';
  const anchorDomain = competitors[0]?.domain || null;
  const greeting = _greeting();

  const whereCity = city ? ` в ${_esc(_prep(city))}` : '';
  const compNames = competitors.slice(0, 3).map(_competitorLabel);
  let introFallback;
  if (compNames.length >= 2) {
    introFallback = `Вы наверняка знаете своих прямых конкурентов${whereCity} — ${_joinRu(compNames)}. Пара минут — и вы увидите, сколько клиентов они забирают у вас, и что с этим делать.`;
  } else if (compNames.length === 1) {
    introFallback = `Вы наверняка знаете своего прямого конкурента${whereCity} — ${compNames[0]}. Пара минут — и вы увидите, сколько клиентов он забирает у вас, и что с этим делать.`;
  } else {
    introFallback = `Пара минут — и вы увидите, где вы теряете клиентов из поиска и что с этим делать.`;
  }
  const intro = connective.intro
    ? `<p style="${TEXT}">${_esc(connective.intro)}</p>`
    : `<p style="${TEXT}">${introFallback}</p>`;

  const ctaText = connective.cta
    || 'Хотите так же? Ответьте на это письмо — пришлём чёткий понятный пошаговый план, как увеличить количество трафика минимум в 2 раза!';

  const body = `
<div style="padding:22px 24px 4px;">
  <p style="${TEXT}">${_esc(greeting)}!</p>
  ${intro}
  ${_section(_competitorBlock({ competitors, prospectTraffic, city, sampleQuery, unit }), '#FFF6F5', '#F3D6D2')}
  ${_section(_authorityBlock(forecastUrl, unit), '#EFF6FF', '#CFE3FF')}
  ${_section(_casesBlock(cases, unit), '#F4FBF5', '#CFE8D4')}
  ${_ctaBox(ctaText)}
</div>`;

  const footer = `
<div style="padding:0 24px 20px;">
  ${_signature(sender)}
  <div style="margin-top:20px;padding-top:14px;border-top:1px solid #eee;${P}font-size:11px;color:#999;">
    Вы получили это письмо, так как ваш сайт найден в поисковой выдаче по вашей тематике.
    ${unsubscribeUrl ? `<a href="${_esc(unsubscribeUrl)}" style="color:#999;">Отписаться</a>.` : ''}
  </div>
</div>`;

  const html = `
<div style="max-width:600px;margin:0 auto;border:1px solid #eee;border-radius:10px;overflow:hidden;background:#fff;">
  ${_hero(anchorDomain, city)}${body}${footer}
</div>`;

  return {
    subject: buildSubject({ anchorDomain, city, prospectDomain: _domain(prospect?.url) }),
    html,
    text: _plainText({ greeting, anchorDomain, city, competitors, prospectTraffic, forecastUrl, cases, unit, ctaText, sender, unsubscribeUrl }),
  };
}

function _plainText({ greeting, anchorDomain, city, competitors, prospectTraffic, forecastUrl, cases, unit, ctaText, sender, unsubscribeUrl }) {
  const lines = [`${greeting}!`, ''];
  if (anchorDomain) {
    lines.push(`${anchorDomain} — ваш прямой конкурент${city ? ` в ${_prep(city)}` : ''}, он забирает ваших клиентов из поиска.`, '');
  } else {
    lines.push('Разбор вашего сайта: где вы теряете клиентов из поиска.', '');
  }
  if (competitors.length) {
    lines.push('Выше вас в выдаче:');
    competitors.forEach((c) => lines.push(`  ▸ ${c.domain} — ~${_num(c.traffic_month)} визитов/мес`));
    if (prospectTraffic) lines.push(`  Ваш сайт — ~${_num(prospectTraffic)} визитов/мес.`);
    lines.push('');
  }
  lines.push('Они наверху не случайно — за этим стоит проверенный алгоритм продвижения. Мы его знаем и умеем повторять для вашего сайта.', '');
  if (forecastUrl) lines.push(`Прогноз по вашему сайту (трафик и ${unit}): ${forecastUrl}`, '');
  if (cases.length) {
    lines.push('Сайты, которые мы вывели в ТОП-10 (проверьте в поиске):');
    cases.forEach((c) => {
      lines.push(`  ▸ ${c.domain} · ${c.city} — ~${_num(c.traffic_month)} визитов/мес`);
      (c.top_keywords || []).forEach((k) => lines.push(`      • «${k.phrase}» — ${_num(k.volume)} ищут/мес`));
    });
    lines.push('');
  }
  lines.push(ctaText, '');
  const sign = [sender.senderName, sender.senderCompany].filter(Boolean).join(', ');
  lines.push(`С уважением, ${sign || ''}`.trim());
  if (sender.senderSite) lines.push(`Сайт: ${sender.senderSite}`);
  if (sender.senderTelegram) lines.push(`Telegram: ${sender.senderTelegram}`);
  if (unsubscribeUrl) lines.push('', `Отписаться: ${unsubscribeUrl}`);
  return lines.join('\n');
}

module.exports = { composeProvocationEmailV2, buildSubject };
