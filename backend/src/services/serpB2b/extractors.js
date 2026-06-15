'use strict';

/**
 * Экстракторы B2B-сущностей из HTML/текста: телефон, email, ИНН/ОГРН/КПП,
 * название юрлица (ООО/ИП/АО), сайт.
 *
 * Особенности:
 *   • работаем по очищенному от <script>/<style>/<noscript> тексту, чтобы
 *     не вытащить мусор из инлайн-JS (sentry, wix, GTM и т.п.);
 *   • для email — отсекаем «технические» домены (sentry, wix, hcaptcha,
 *     google-analytics и пр.) и адреса вида image@2x;
 *   • для телефона — нормализация под РФ/СНГ (+7 / 8 → +7), отсев
 *     явных ИНН/ОГРН по длине цифр и контексту;
 *   • ИНН проверяется по контрольным цифрам (10/12 знаков), ОГРН — по
 *     контрольной цифре (13/15 знаков);
 *   • найденные сущности дедуплицируются и ранжируются.
 */

const cheerio = require('cheerio');

// ─────────────────────────────────────────────────────────────────────
// Чистка HTML → plain text
// ─────────────────────────────────────────────────────────────────────

/**
 * Возвращает «чистый» текст HTML без скриптов/стилей/шаблонов и с
 * сохранением пробелов между блоками.
 */
function htmlToCleanText(html) {
  if (!html) return '';
  const $ = cheerio.load(String(html));
  $('script, style, noscript, template, iframe, svg, link, meta').remove();
  // <a href="mailto:..."> и <a href="tel:..."> — попадут в email/phone
  // через href отдельно, текст оставляем.
  // Замена <br>/<p>/<div>/<li> на переводы строк, чтобы соседние ИНН-
  // названия не слипались.
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, footer, header, address')
    .each((_, el) => { $(el).append('\n'); });
  const text = $('body').text() || $.text() || '';
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Технические e-mail-домены, которые не являются контактами компании.
const EMAIL_TECH_DOMAINS = new Set([
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'wix.com',
  'parastorage.com', 'hcaptcha.com', 'recaptcha.net', 'google-analytics.com',
  'googletagmanager.com', 'gstatic.com', 'cloudflare.com', 'cloudflareinsights.com',
  'jsdelivr.net', 'unpkg.com', 'bootstrapcdn.com', 'jquery.com',
  'fontawesome.com', 'typekit.net', 'use.fontawesome.com',
  'example.com', 'example.org', 'domain.com', 'mail.com', 'site.ru',
  'sitename.ru',
]);

// Локалпарты, которые гарантированно не являются контактом
// (либо служебные, либо плейсхолдеры).
const EMAIL_TECH_LOCAL_RE = /^(?:noreply|no-reply|donotreply|sentry|wix|hcaptcha|recaptcha|admin@|name@|email@|user@|test@|example@)/i;

// Расширения изображений / шрифтов / асетов: /image@2x.png, /icon@2x.svg
const EMAIL_ASSET_RE = /@\d+x\.(png|jpe?g|svg|webp|gif|ico|woff2?|ttf|otf|eot)/i;

function _isLikelyEmail(email) {
  if (!email) return false;
  if (EMAIL_ASSET_RE.test(email)) return false;
  if (EMAIL_TECH_LOCAL_RE.test(email)) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (local.length > 64 || domain.length > 253) return false;
  if (EMAIL_TECH_DOMAINS.has(domain)) return false;
  // Картинки sentry/wix часто имеют ext-домен типа foo@2x.png — добиваем
  // строгой проверкой TLD: TLD должно быть 2..24 буквы.
  const tld = domain.split('.').pop();
  if (!/^[a-zA-Z]{2,24}$/.test(tld)) return false;
  // Цифровые-only локалпарты типа 12345678@1234 — мусор.
  if (/^\d+$/.test(local) && local.length > 6) return false;
  return true;
}

function extractEmails(text, { maxItems = 10 } = {}) {
  if (!text) return [];
  const matches = String(text).match(EMAIL_RE) || [];
  const seen = new Set();
  const out = [];
  for (let raw of matches) {
    raw = raw.trim().replace(/[.,;:!?)>}\]]+$/, '');
    const lower = raw.toLowerCase();
    if (!_isLikelyEmail(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(raw);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// PHONE (RU/CIS)
// ─────────────────────────────────────────────────────────────────────

// Совмещённый шаблон: +7 / 8, скобки, дефисы, пробелы. Поддерживает
// 10-значные номера РФ (после кода страны). Бесцифровой префикс «7»
// без «+» НЕ поддерживается — это путает регекс на длинных цепочках
// цифр (ИНН/ОГРН), которые часто соседствуют с телефонами в реквизитах.
const PHONE_RE = /(?:\+7|(?<!\d)8)[\s\-()\u00A0]*\(?(\d{3,4})\)?[\s\-()\u00A0]*(\d{2,3})[\s\-()\u00A0]*(\d{2})[\s\-()\u00A0]*(\d{2})(?!\d)/g;

// Контекст до/после совпадения, который указывает на ИНН/ОГРН/счёт,
// а не на телефон (даже если по длине цифр совпало).
const PHONE_NEGATIVE_CONTEXT = /(?:ИНН|ОГРН|ОКПО|ОКВЭД|ОКАТО|ОКТМО|КПП|БИК|р[\/\\\s]?с|расч[её]тный\s+сч[её]т|счет|account|account\s*no|tax\s*id)/i;

function _normalizePhone(d1, d2, d3, d4) {
  // Сводим к +7 (XXX) XXX-XX-XX. d1 длиной 3 или 4 (Беларусь/Казахстан
  // могут давать 3-значные коды у нас не нормализуем — оставляем как есть).
  return `+7 (${d1}) ${d2}-${d3}-${d4}`;
}

/**
 * Классификация номера РФ по коду зоны DEF/ABC:
 *   • 9XX → сотовый (всё мобильное в РФ начинается на 9: 900..999);
 *   • 8XX (включая 800/804/805 — бесплатные и сервисные) → городской/сервисный;
 *   • остальные коды (3XX, 4XX, 5XX, 6XX, 7XX) → городские.
 *
 * @param {string} phone — номер в любом формате (берём digits)
 * @returns {'mobile'|'landline'}
 */
function classifyPhone(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  // Ожидаем 11 цифр после нормализации (7XXXXXXXXXX). Если меньше —
  // консервативно считаем городским (ИНН/опечатка в нормализации).
  if (digits.length < 11) return 'landline';
  // Первая цифра кода зоны — индекс 1 (после ведущей 7).
  const areaFirst = digits[1];
  return areaFirst === '9' ? 'mobile' : 'landline';
}

function extractPhones(text, { maxItems = 6 } = {}) {
  if (!text) return [];
  const src = String(text);
  const out = [];
  const seen = new Set();
  let m;
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(src)) !== null) {
    // Контекст ТОЛЬКО ДО матча — там стоит метка «ИНН:» / «ОГРН:» / «р/с»,
    // если цифры по факту являются реквизитом, а не номером. Метки ПОСЛЕ
    // номера к нему не относятся (там обычно начинается следующий блок).
    const start = Math.max(0, m.index - 32);
    const ctx = src.slice(start, m.index);
    if (PHONE_NEGATIVE_CONTEXT.test(ctx)) continue;
    // d1 длиной 3 (РФ) или 4 (некоторые регионы РФ типа Сочи 8622?
    // На самом деле РФ всегда 3-значный код после +7/8). Игнорируем
    // 4-значные первый блок — это маркер ошибочного захвата.
    if (m[1].length !== 3) continue;
    const norm = _normalizePhone(m[1], m[2], m[3], m[4]);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= maxItems) break;
  }
  return out;
}

// Извлечение телефонов из href="tel:..." (более надёжный сигнал).
function extractPhonesFromHrefs(html, { maxItems = 6 } = {}) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const re = /href\s*=\s*["']tel:([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const digits = String(m[1]).replace(/\D+/g, '');
    if (digits.length < 10 || digits.length > 13) continue;
    let d = digits;
    if (d.length === 11 && (d.startsWith('7') || d.startsWith('8'))) d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    if (d.length !== 11 || !d.startsWith('7')) continue;
    const norm = `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractEmailsFromHrefs(html, { maxItems = 10 } = {}) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const re = /href\s*=\s*["']mailto:([^"'?]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeURIComponent(String(m[1]).trim());
    const lower = raw.toLowerCase();
    if (!_isLikelyEmail(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(raw);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// ИНН / ОГРН / КПП
// ─────────────────────────────────────────────────────────────────────

// ИНН в РФ: 10 цифр (юрлицо) или 12 (ИП). Контрольная сумма — обязательна,
// иначе любые случайные 10/12 цифр проходят.
function _innChecksum(digits, weights) {
  let s = 0;
  for (let i = 0; i < weights.length; i++) s += weights[i] * Number(digits[i]);
  return (s % 11) % 10;
}

function isValidInn(inn) {
  const s = String(inn || '').replace(/\D+/g, '');
  if (s.length === 10) {
    const w = [2, 4, 10, 3, 5, 9, 4, 6, 8, 0];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += w[i] * Number(s[i]);
    return ((sum % 11) % 10) === Number(s[9]);
  }
  if (s.length === 12) {
    const w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8, 0, 0];
    const w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8, 0];
    let s1 = 0, s2 = 0;
    for (let i = 0; i < 11; i++) s1 += w1[i] * Number(s[i]);
    for (let i = 0; i < 11; i++) s2 += w2[i] * Number(s[i]);
    return ((s1 % 11) % 10) === Number(s[10]) && ((s2 % 11) % 10) === Number(s[11]);
  }
  return false;
}

// ОГРН/ОГРНИП: 13/15 цифр. Контрольная цифра = (число mod p) mod 10,
// где p = 11 для ОГРН (13), 13 для ОГРНИП (15). Берём первые n-1 цифр
// как число, делим, остаток mod 10 == последняя цифра.
function isValidOgrn(ogrn) {
  const s = String(ogrn || '').replace(/\D+/g, '');
  if (s.length === 13) {
    const head = s.slice(0, 12);
    // BigInt чтобы не потерять точность на 12 цифрах.
    const rem = Number(BigInt(head) % 11n) % 10;
    return rem === Number(s[12]);
  }
  if (s.length === 15) {
    const head = s.slice(0, 14);
    const rem = Number(BigInt(head) % 13n) % 10;
    return rem === Number(s[14]);
  }
  return false;
}

// JS \b не учитывает кириллицу — для меток на русском используем
// явное «не-буква перед маркером» (и любая граница после).
const _NB = '(?:^|[^А-Яа-яёЁA-Za-z])';

const INN_CONTEXT_RE = new RegExp(`${_NB}ИНН[^А-Яа-яёЁ\\d]{0,5}(\\d{10}|\\d{12})`, 'g');
const INN_FALLBACK_RE = /(?<!\d)(\d{10}|\d{12})(?!\d)/g;
const OGRN_CONTEXT_RE = new RegExp(`${_NB}ОГРН(?:ИП)?[^А-Яа-яёЁ\\d]{0,5}(\\d{13}|\\d{15})`, 'g');
const KPP_CONTEXT_RE = new RegExp(`${_NB}КПП[^А-Яа-яёЁ\\d]{0,5}(\\d{9})`, 'g');

function extractInn(text) {
  if (!text) return null;
  const src = String(text);
  // Шаг 1: явный «ИНН: ...».
  let m;
  INN_CONTEXT_RE.lastIndex = 0;
  while ((m = INN_CONTEXT_RE.exec(src)) !== null) {
    if (isValidInn(m[1])) return m[1];
  }
  // Шаг 2: любые валидные 10/12 цифр в тексте — берём первое.
  // Чтобы не цеплять ОГРН, исключаем последовательности длиной 13/15.
  INN_FALLBACK_RE.lastIndex = 0;
  while ((m = INN_FALLBACK_RE.exec(src)) !== null) {
    if (isValidInn(m[1])) return m[1];
  }
  return null;
}

function extractOgrn(text) {
  if (!text) return null;
  const src = String(text);
  let m;
  OGRN_CONTEXT_RE.lastIndex = 0;
  while ((m = OGRN_CONTEXT_RE.exec(src)) !== null) {
    if (isValidOgrn(m[1])) return m[1];
  }
  return null;
}

function extractKpp(text) {
  if (!text) return null;
  const src = String(text);
  let m;
  KPP_CONTEXT_RE.lastIndex = 0;
  while ((m = KPP_CONTEXT_RE.exec(src)) !== null) {
    return m[1];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Юрлицо (ООО / АО / ПАО / ИП / ЗАО)
// ─────────────────────────────────────────────────────────────────────

// «ООО "Бетон-Строй"», «ИП Иванов И.И.», «АО "Газпром"» — JS \b не
// держит границу перед кириллицей, поэтому используем якорь «не-буква».
const COMPANY_RE = new RegExp(
  `${_NB}(ООО|ОАО|ЗАО|ПАО|АО|НКО|ТОО)\\s+["«“”„‟'\`‹›]([^"«»“”„‟'\`‹›\\n]{2,120})["«»“”„‟'\`‹›]`,
  'g',
);
// Полная форма: «Общество с ограниченной ответственностью «Бетон-Строй»» —
// часто встречается на политике конфиденциальности и в соглашениях.
const COMPANY_FULL_FORM_RE = new RegExp(
  '(Общество\\s+с\\s+ограниченной\\s+ответственностью|'
  + 'Открытое\\s+акционерное\\s+общество|'
  + 'Закрытое\\s+акционерное\\s+общество|'
  + 'Публичное\\s+акционерное\\s+общество|'
  + 'Акционерное\\s+общество)'
  + '\\s+["«“”„‟\'`‹›]([^"«»“”„‟\'`‹›\\n]{2,120})["«»“”„‟\'`‹›]',
  'gi',
);
const COMPANY_FULL_TO_SHORT = {
  'общество с ограниченной ответственностью': 'ООО',
  'открытое акционерное общество': 'ОАО',
  'закрытое акционерное общество': 'ЗАО',
  'публичное акционерное общество': 'ПАО',
  'акционерное общество': 'АО',
};
const COMPANY_PLAIN_RE = new RegExp(
  `${_NB}(ООО|ОАО|ЗАО|ПАО|АО)\\s+([А-ЯЁA-Z][\\wА-ЯЁа-яё\\-«»"]{2,80})(?![\\wА-Яа-я])`,
  'g',
);
const IP_RE = new RegExp(
  `${_NB}ИП\\s+([А-ЯЁ][а-яё]{2,30}\\s+[А-ЯЁ]\\.\\s*[А-ЯЁ]\\.)`,
  'g',
);

function extractCompanyName(text) {
  if (!text) return null;
  const src = String(text);
  // 1) Кавычки — самый чёткий сигнал.
  let m;
  COMPANY_RE.lastIndex = 0;
  if ((m = COMPANY_RE.exec(src)) !== null) {
    return `${m[1]} «${m[2].trim()}»`;
  }
  // 2) Полная форма «Общество с ограниченной ответственностью «...»» —
  // нормализуем к короткому виду (ООО / АО / ПАО), чтобы записи в базе
  // были однотипными.
  COMPANY_FULL_FORM_RE.lastIndex = 0;
  if ((m = COMPANY_FULL_FORM_RE.exec(src)) !== null) {
    const fullForm = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
    const shortForm = COMPANY_FULL_TO_SHORT[fullForm] || m[1];
    return `${shortForm} «${m[2].trim()}»`;
  }
  // 3) ИП ФИО.
  IP_RE.lastIndex = 0;
  if ((m = IP_RE.exec(src)) !== null) {
    return `ИП ${m[1].trim()}`;
  }
  // 4) Без кавычек — только если за маркером идёт явное Название.
  COMPANY_PLAIN_RE.lastIndex = 0;
  if ((m = COMPANY_PLAIN_RE.exec(src)) !== null) {
    return `${m[1]} ${m[2].trim()}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// JSON-LD / Microdata / <meta> — структурированные реквизиты
// ─────────────────────────────────────────────────────────────────────

// Ключи в JSON-LD/Schema.org/Microdata, под которыми сайты хранят ИНН/ОГРН.
// Schema.org: Organization.taxID / vatID. На рунет-сайтах часто прямо «inn»,
// «ogrn», «kpp» в произвольных JSON-структурах (микроразметка через
// data-attributes, viewModel и т.п.).
const STRUCT_INN_KEYS  = ['taxid', 'taxnumber', 'tax_id', 'vatid', 'vat_id', 'inn', 'инн'];
const STRUCT_OGRN_KEYS = ['ogrn', 'огрн', 'ogrnip', 'огрнип', 'psrn', 'registrationnumber', 'registration_number'];
const STRUCT_NAME_KEYS = ['legalname', 'legal_name', 'alternatename', 'alternate_name', 'name'];

function _normKey(k) { return String(k || '').toLowerCase().replace(/[\s_\-]+/g, ''); }

function _walkJson(value, visit) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) _walkJson(v, visit);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v);
      _walkJson(v, visit);
    }
  }
}

/**
 * Возвращает структурированные реквизиты, найденные в JSON-LD-блоках
 * (`<script type="application/ld+json">`) и в `<meta name|property|itemprop="..." content="...">`.
 *
 * Найденные ИНН/ОГРН проходят ту же проверку контрольной суммой, что и
 * текстовые: случайные числа из data-атрибутов отсеиваются.
 *
 * @param {string} html — сырой HTML
 * @returns {{inn: string|null, ogrn: string|null, company_name: string|null}}
 */
function extractStructuredRequisites(html) {
  const out = { inn: null, ogrn: null, company_name: null };
  if (!html) return out;
  let $;
  try { $ = cheerio.load(String(html)); } catch (_) { return out; }

  const tryInn = (raw) => {
    if (out.inn) return;
    const s = String(raw || '').replace(/\D+/g, '');
    if ((s.length === 10 || s.length === 12) && isValidInn(s)) out.inn = s;
  };
  const tryOgrn = (raw) => {
    if (out.ogrn) return;
    const s = String(raw || '').replace(/\D+/g, '');
    if ((s.length === 13 || s.length === 15) && isValidOgrn(s)) out.ogrn = s;
  };
  const tryName = (raw) => {
    if (out.company_name) return;
    const s = String(raw || '').trim();
    if (!s || s.length < 3 || s.length > 200) return;
    // Берём только то, что выглядит как юр. лицо (ООО/АО/ПАО/ИП/полная форма).
    const found = extractCompanyName(s);
    if (found) out.company_name = found;
  };

  // 1) JSON-LD блоки.
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text() || $(el).html() || '';
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      // Иногда сайты кладут несколько JSON-объектов конкатенацией —
      // пробуем выдрать первый объект/массив.
      const m = raw.match(/[\[{][\s\S]*[\]}]/);
      if (!m) return;
      try { parsed = JSON.parse(m[0]); } catch (__) { return; }
    }
    _walkJson(parsed, (k, v) => {
      if (typeof v !== 'string' && typeof v !== 'number') return;
      const nk = _normKey(k);
      if (STRUCT_INN_KEYS.includes(nk))  tryInn(v);
      if (STRUCT_OGRN_KEYS.includes(nk)) tryOgrn(v);
      if (STRUCT_NAME_KEYS.includes(nk)) tryName(v);
    });
  });

  // 2) <meta name|property|itemprop="..." content="...">.
  $('meta[content]').each((_, el) => {
    const $el = $(el);
    const key = _normKey($el.attr('name') || $el.attr('property') || $el.attr('itemprop') || '');
    if (!key) return;
    const content = $el.attr('content') || '';
    if (!content) return;
    if (STRUCT_INN_KEYS.includes(key))  tryInn(content);
    if (STRUCT_OGRN_KEYS.includes(key)) tryOgrn(content);
    if (STRUCT_NAME_KEYS.includes(key)) tryName(content);
  });

  // 3) Microdata: itemprop на любом элементе со значением в text/value.
  $('[itemprop]').each((_, el) => {
    const $el = $(el);
    const key = _normKey($el.attr('itemprop') || '');
    if (!key) return;
    const val = $el.attr('content') || $el.text() || '';
    if (!val) return;
    if (STRUCT_INN_KEYS.includes(key))  tryInn(val);
    if (STRUCT_OGRN_KEYS.includes(key)) tryOgrn(val);
    if (STRUCT_NAME_KEYS.includes(key)) tryName(val);
  });

  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Точечный поиск юрлица рядом с ИНН/ОГРН (помогает на политике
// конфиденциальности / страницах «О компании», где юрлицо
// располагается в одном абзаце с ИНН).
// ─────────────────────────────────────────────────────────────────────

/**
 * Возвращает компанию в окне ±400 символов вокруг найденного ИНН/ОГРН.
 * Важно для текстов вида:
 *   «Оператор персональных данных — Общество с ограниченной
 *    ответственностью «Бетон-Строй» (ИНН 7701234567, ОГРН ...)»
 * — здесь юрлицо стоит до маркера, а не после.
 */
function extractCompanyNameNearRequisites(text) {
  if (!text) return null;
  const src = String(text);
  // Якоря: ИНН/ОГРН с числовым значением.
  const re = /(?:ИНН|ОГРН(?:ИП)?)[^А-Яа-яёЁ\d]{0,5}\d{10,15}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = Math.max(0, m.index - 400);
    const end = Math.min(src.length, m.index + 400);
    const window = src.slice(start, end);
    const name = extractCompanyName(window);
    if (name) return name;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Услуги компании из шапки сайта (header / top nav)
// ─────────────────────────────────────────────────────────────────────

const SERVICES_NAV_KEYWORDS = [
  'услуги', 'сервисы', 'services', 'наши услуги',
  'каталог услуг', 'что мы делаем', 'направления',
];

const SERVICE_TEXT_BLACKLIST = new Set([
  'главная', 'home', 'контакты', 'contacts', 'contact',
  'о нас', 'о компании', 'about', 'about us',
  'блог', 'blog', 'новости', 'news', 'отзывы', 'reviews',
  'портфолио', 'portfolio', 'кейсы', 'cases', 'galery',
  'войти', 'регистрация', 'login', 'sign in', 'sign up',
  'каталог', 'catalog', 'оплата', 'доставка', 'faq', 'вопросы',
  'политика', 'оферта', 'соглашение', 'privacy', 'terms',
  'корзина', 'cart', 'заказать', 'купить',
]);

function _isLikelyServiceText(t) {
  const norm = String(t || '').trim().toLowerCase();
  if (norm.length < 3 || norm.length > 80) return false;
  if (SERVICE_TEXT_BLACKLIST.has(norm)) return false;
  // Стоп: телефон/email/URL.
  if (/[@\d]/.test(norm) && /\d{3,}/.test(norm)) return false;
  // Должны быть буквы.
  if (!/[a-zA-Zа-яёА-ЯЁ]/.test(norm)) return false;
  return true;
}

/**
 * Извлекает список «услуг» компании из шапки сайта. Стратегия:
 *   1) ищем в header/top-nav пункт меню со словом «Услуги/Services» и
 *      собираем дочерние ссылки (sub-menu) — это самый чистый сигнал;
 *   2) если sub-menu не нашли — берём прямые соседние пункты меню,
 *      отфильтровав очевидно нерелевантные («Главная», «Контакты»).
 *
 * @param {string} html
 * @param {string} [baseUrl]
 * @returns {string[]} список названий услуг (до 12 штук)
 */
function extractServicesFromHeader(html, baseUrl) {
  if (!html) return [];
  let $;
  try { $ = cheerio.load(String(html)); } catch (_) { return []; }
  $('script, style, noscript, template').remove();

  const seen = new Set();
  const out = [];
  function _push(name) {
    const v = String(name || '').trim().replace(/\s+/g, ' ');
    if (!_isLikelyServiceText(v)) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  }

  // Шаг 1: ищем «корневой» пункт меню со словом «Услуги/Services» и
  // собираем sub-menu (вложенные <a> в том же родителе/«сабменю»).
  const navSel = 'header, [role="banner"], [class*="header" i], [class*="menu" i], '
    + '[class*="navbar" i], [class*="nav-" i], [class*="main-nav" i], nav';
  let foundSubmenu = false;
  $(navSel).find('a').each((_, a) => {
    if (foundSubmenu) return;
    const text = ($(a).text() || '').trim().toLowerCase();
    if (!text) return;
    if (!SERVICES_NAV_KEYWORDS.some((k) => text === k || text.startsWith(k))) return;
    // Поднимаемся к ближайшему «контейнеру меню» и собираем все ссылки внутри.
    const $a = $(a);
    const $container = $a.closest('li, .has-submenu, [class*="dropdown" i], [class*="submenu" i]');
    const $scope = $container.length ? $container : $a.parent();
    $scope.find('a').each((__, sub) => {
      const t = ($(sub).text() || '').trim();
      if (t && t.toLowerCase() !== text) {
        _push(t);
        foundSubmenu = true;
      }
    });
  });

  // Шаг 2: fallback — top-level пункты меню без сабменю.
  if (!out.length) {
    $('header nav a, nav a, [class*="main-menu" i] a, [class*="top-menu" i] a').each((_, a) => {
      if (out.length >= 12) return;
      const t = ($(a).text() || '').trim();
      _push(t);
    });
  }

  // Лимит на разумное число услуг.
  return out.slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────
// Главный сборщик «контактов с одной страницы»
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} html — сырой HTML страницы (для tel:/mailto: hrefs)
 * @param {string} [text] — опциональный заранее очищенный текст
 * @returns {{
 *   emails: string[], phones: string[],
 *   phones_mobile: string[], phones_landline: string[],
 *   inn: string|null, ogrn: string|null, kpp: string|null,
 *   company_name: string|null,
 *   services: string[]
 * }}
 */
function extractContactsFromPage(html, text) {
  const cleanText = text || htmlToCleanText(html);
  const hrefEmails = extractEmailsFromHrefs(html);
  const hrefPhones = extractPhonesFromHrefs(html);
  const textEmails = extractEmails(cleanText);
  const textPhones = extractPhones(cleanText);

  // Объединяем, hrefs идут первыми (более надёжный сигнал).
  const emails = Array.from(new Set([...hrefEmails, ...textEmails])).slice(0, 10);
  const phones = Array.from(new Set([...hrefPhones, ...textPhones])).slice(0, 6);

  // Раздел сотовые / городские (РФ: 9XX → сотовый).
  const phones_mobile = [];
  const phones_landline = [];
  for (const p of phones) {
    if (classifyPhone(p) === 'mobile') phones_mobile.push(p);
    else phones_landline.push(p);
  }

  // Реквизиты: сначала структурированные (JSON-LD / <meta> / itemprop) —
  // самый надёжный источник, потому что не зависит от верстки и не
  // ломается, когда ИНН визуально спрятан в футере под спойлером.
  const structured = extractStructuredRequisites(html);

  // ИНН/ОГРН/КПП: если в структуре нашли — используем; иначе fallback к
  // тексту видимого DOM (footer/address/contacts блоки попадают в cleanText).
  const inn  = structured.inn  || extractInn(cleanText);
  const ogrn = structured.ogrn || extractOgrn(cleanText);
  const kpp  = extractKpp(cleanText);

  // Юрлицо: 1) из структурированной разметки, 2) точечный поиск рядом
  // с ИНН/ОГРН (на политике конфиденциальности), 3) общий fallback по
  // тексту. Окончательное Enrichment имени делает pipeline через Dadata
  // (см. serpB2b/dadataClient).
  const company_name = structured.company_name
    || extractCompanyNameNearRequisites(cleanText)
    || extractCompanyName(cleanText);

  return {
    emails,
    phones,
    phones_mobile,
    phones_landline,
    inn,
    ogrn,
    kpp,
    company_name,
    services: extractServicesFromHeader(html),
  };
}

module.exports = {
  htmlToCleanText,
  extractEmails,
  extractPhones,
  extractEmailsFromHrefs,
  extractPhonesFromHrefs,
  extractInn,
  extractOgrn,
  extractKpp,
  isValidInn,
  isValidOgrn,
  extractCompanyName,
  extractCompanyNameNearRequisites,
  extractStructuredRequisites,
  extractServicesFromHeader,
  classifyPhone,
  extractContactsFromPage,
};
