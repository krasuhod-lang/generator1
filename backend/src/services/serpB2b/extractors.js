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
  // 2) ИП ФИО.
  IP_RE.lastIndex = 0;
  if ((m = IP_RE.exec(src)) !== null) {
    return `ИП ${m[1].trim()}`;
  }
  // 3) Без кавычек — только если за маркером идёт явное Название.
  COMPANY_PLAIN_RE.lastIndex = 0;
  if ((m = COMPANY_PLAIN_RE.exec(src)) !== null) {
    return `${m[1]} ${m[2].trim()}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Главный сборщик «контактов с одной страницы»
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} html — сырой HTML страницы (для tel:/mailto: hrefs)
 * @param {string} [text] — опциональный заранее очищенный текст
 * @returns {{
 *   emails: string[], phones: string[],
 *   inn: string|null, ogrn: string|null, kpp: string|null,
 *   company_name: string|null
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

  return {
    emails,
    phones,
    inn: extractInn(cleanText),
    ogrn: extractOgrn(cleanText),
    kpp: extractKpp(cleanText),
    company_name: extractCompanyName(cleanText),
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
  extractContactsFromPage,
};
