'use strict';

/**
 * Smoke-tests for SERP B2B extractors / contact-finder / blacklist.
 *
 * Покрывает:
 *   • разбиение телефонов на сотовые (9XX) и городские (3XX/4XX/8XX);
 *   • поиск ссылок на политику конфиденциальности / о компании /
 *     соглашение, а не только «Контакты»;
 *   • точечный поиск юрлица в окне ±400 символов вокруг ИНН на странице
 *     политики конфиденциальности (типичный кейс реквизитов);
 *   • извлечение услуг из top-nav в шапке;
 *   • расширенный blacklist агрегаторов (ЦИАН, Авито, Яндекс, hh.ru и пр.);
 *   • пайплайн _processSite не валится на одной упавшей contact-странице.
 *
 * Запуск:  node backend/scripts/test-serp-b2b.js
 */

const assert = require('assert');
const path = require('path');

// Подменяем pg/db, чтобы тесты экстракторов не зависели от БД.
require.cache[require.resolve('../src/config/db')] = {
  exports: { query: async () => ({ rows: [], rowCount: 0 }) },
};

const {
  classifyPhone, extractPhones, extractPhonesFromHrefs,
  extractCompanyName, extractCompanyNameNearRequisites,
  extractServicesFromHeader, extractContactsFromPage,
  extractStructuredRequisites,
  isValidInn, isValidOgrn, extractInn, extractOgrn,
} = require('../src/services/serpB2b/extractors');
const { findContactLinks, CONTACT_KEYWORDS } = require(
  '../src/services/serpB2b/contactPageFinder');
const { isBlacklistedHost, isBlacklistedUrl } = require(
  '../src/services/serpB2b/domainBlacklist');
const { lookupByInn, isDadataEnabled, _resetCache: _resetDadataCache } = require(
  '../src/services/serpB2b/dadataClient');
const { _looksLikeLegalEntity } = require(
  '../src/services/serpB2b/companyLLMExtractor');

let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

console.log('\n[serpB2b] Phone classification (mobile/landline)');
ok('+7 (901) 123-45-67 → mobile', classifyPhone('+7 (901) 123-45-67') === 'mobile');
ok('+7 (915) 555-44-33 → mobile', classifyPhone('+7 (915) 555-44-33') === 'mobile');
ok('+7 (988) 100-20-30 → mobile', classifyPhone('+7 (988) 100-20-30') === 'mobile');
ok('+7 (495) 123-45-67 → landline (Москва)', classifyPhone('+7 (495) 123-45-67') === 'landline');
ok('+7 (812) 100-20-30 → landline (СПб)', classifyPhone('+7 (812) 100-20-30') === 'landline');
ok('+7 (343) 222-11-00 → landline (Екб)', classifyPhone('+7 (343) 222-11-00') === 'landline');
ok('+7 (800) 555-35-35 → landline (toll-free 8800)', classifyPhone('+7 (800) 555-35-35') === 'landline');

console.log('\n[serpB2b] Phone extraction + tel: hrefs');
const phoneText = 'Звоните: +7 (495) 123-45-67 или 8 (901) 234-56-78. ИНН 7707083893.';
const phones = extractPhones(phoneText);
ok('два телефона из текста', phones.length === 2);
ok('сохранён 495 (городской)', phones.some((p) => p.includes('(495)')));
ok('сохранён 901 (сотовый)', phones.some((p) => p.includes('(901)')));
const telHtml = '<a href="tel:+74951234567">офис</a><a href="tel:89012345678">моб.</a>';
const telPhones = extractPhonesFromHrefs(telHtml);
ok('tel: 11-цифр и 10-цифр нормализованы',
  telPhones.length === 2 && telPhones[0].includes('(495)') && telPhones[1].includes('(901)'));

console.log('\n[serpB2b] Contact links across categories');
const html = `
  <html><body>
    <header><nav>
      <a href="/about">О компании</a>
      <a href="/services">Услуги</a>
      <a href="/contacts">Контакты</a>
    </nav></header>
    <footer>
      <a href="/privacy-policy">Политика конфиденциальности</a>
      <a href="/oferta">Публичная оферта</a>
      <a href="https://other.com/contacts">External</a>
      <a href="javascript:void(0)">Skip</a>
    </footer>
  </body></html>`;
const links = findContactLinks(html, 'https://example.ru/');
const cats = new Set(links.map((l) => l.category));
ok('contacts найден', cats.has('contacts'));
ok('about найден', cats.has('about'));
ok('policy найден', cats.has('policy'));
ok('terms (оферта) найден', cats.has('terms'));
ok('внешние хосты не попали', !links.find((l) => {
  try { return new URL(l.url).hostname === 'other.com'; } catch (_) { return false; }
}));
// Производственный код в contactPageFinder допускает только http(s) —
// проверяем именно это инвариантное свойство (а не отрицательный список).
ok('все ссылки используют http(s) (javascript:/data:/vbscript: отсеяны)',
  links.every((l) => {
    try { return /^https?:$/.test(new URL(l.url).protocol); } catch (_) { return false; }
  }));
ok('CONTACT_KEYWORDS совместим (массив)', Array.isArray(CONTACT_KEYWORDS) && CONTACT_KEYWORDS.length > 0);

console.log('\n[serpB2b] Company name near requisites (privacy policy)');
const policyText = `
  Настоящая Политика обработки персональных данных составлена в
  соответствии с требованиями Федерального закона. Оператор —
  Общество с ограниченной ответственностью «Бетон-Строй»
  (ИНН 7701234567, ОГРН 1027700132195), адрес: г. Москва.
  Цель обработки — выполнение договорных обязательств.
`;
const nameNear = extractCompanyNameNearRequisites(policyText);
ok('юрлицо рядом с ИНН на политике', nameNear && nameNear.includes('Бетон-Строй'),
  `got: ${nameNear}`);
// На странице, где ИНН нет — fallback к общему extractCompanyName:
const aboutText = 'Мы — ООО «АльфаТех», работаем с 2010 года.';
ok('юрлицо без ИНН → общий fallback',
  extractCompanyName(aboutText) === 'ООО «АльфаТех»');

console.log('\n[serpB2b] ИП extraction (different name forms)');
ok('ИП Фамилия + 2 инициала',
  extractCompanyName('Продавец: ИП Иванов И.И., ИНН 500100732259.') === 'ИП Иванов И.И.',
  `got: ${extractCompanyName('Продавец: ИП Иванов И.И.')}`);
ok('ИП Фамилия + инициалы с пробелом',
  extractCompanyName('Реквизиты: ИП Петров П. С.') === 'ИП Петров П. С.',
  `got: ${extractCompanyName('Реквизиты: ИП Петров П. С.')}`);
ok('ИП Фамилия Имя Отчество (полное ФИО)',
  extractCompanyName('Оператор — ИП Сидоров Сидор Сидорович.') === 'ИП Сидоров Сидор Сидорович',
  `got: ${extractCompanyName('Оператор — ИП Сидоров Сидор Сидорович.')}`);
ok('Полная форма «Индивидуальный предприниматель» → ИП',
  extractCompanyName('Индивидуальный предприниматель Кузнецов А.В.') === 'ИП Кузнецов А.В.',
  `got: ${extractCompanyName('Индивидуальный предприниматель Кузнецов А.В.')}`);
ok('Полная форма ИП с полным ФИО',
  extractCompanyName('Индивидуальный предприниматель Орлов Олег Олегович работает.')
    === 'ИП Орлов Олег Олегович',
  `got: ${extractCompanyName('Индивидуальный предприниматель Орлов Олег Олегович.')}`);

console.log('\n[serpB2b] Ownership verification (skip clients / mentions)');
// Без rejectClientContext поведение прежнее — берём первое совпадение.
const clientsText = 'Среди наших клиентов — ООО «Клиент-Один». А мы — ООО «Хозяин Сайта».';
ok('default: берёт первое совпадение (обратная совместимость)',
  extractCompanyName(clientsText) === 'ООО «Клиент-Один»',
  `got: ${extractCompanyName(clientsText)}`);
ok('rejectClientContext: пропускает клиента, берёт владельца',
  extractCompanyName(clientsText, { rejectClientContext: true }) === 'ООО «Хозяин Сайта»',
  `got: ${extractCompanyName(clientsText, { rejectClientContext: true })}`);
ok('rejectClientContext: только клиент → null',
  extractCompanyName('Наш клиент — ООО «Только Клиент».', { rejectClientContext: true }) === null,
  `got: ${extractCompanyName('Наш клиент — ООО «Только Клиент».', { rejectClientContext: true })}`);
ok('rejectClientContext: партнёр/кейс отсеивается',
  extractCompanyName('Кейс: реализовали проект для ООО «Заказчик».', { rejectClientContext: true })
    === null,
  `got: ${extractCompanyName('Кейс: реализовали проект для ООО «Заказчик».', { rejectClientContext: true })}`);
// extractContactsFromPage должен применять ownership-фильтр на общем fallback.
const ownerPageHtml = `<html><body>
  <section>Наши клиенты: ООО «Чужая Компания» доверяют нам.</section>
  <footer>ООО «Наш Сайт», все права защищены.</footer>
</body></html>`;
const ownerContacts = extractContactsFromPage(ownerPageHtml);
ok('extractContactsFromPage: не выписывает клиента, берёт владельца',
  ownerContacts.company_name === 'ООО «Наш Сайт»',
  `got: ${ownerContacts.company_name}`);

console.log('\n[serpB2b] Services from header / top nav');
const navHtml = `
  <html><body>
    <header class="site-header">
      <nav class="main-menu">
        <ul>
          <li><a href="/">Главная</a></li>
          <li class="has-submenu">
            <a href="/services">Услуги</a>
            <ul class="submenu">
              <li><a href="/services/seo">SEO-продвижение</a></li>
              <li><a href="/services/contextual">Контекстная реклама</a></li>
              <li><a href="/services/dev">Разработка сайтов</a></li>
            </ul>
          </li>
          <li><a href="/about">О компании</a></li>
          <li><a href="/contacts">Контакты</a></li>
        </ul>
      </nav>
    </header>
  </body></html>`;
const services = extractServicesFromHeader(navHtml);
ok('взяли подменю «Услуги» (3 пункта)',
  services.length === 3 && services.includes('SEO-продвижение'),
  `got: ${JSON.stringify(services)}`);
ok('Главная/Контакты не попали в услуги',
  !services.includes('Главная') && !services.includes('Контакты'));

// Без подменю — fallback к плоскому top-nav (стоп-слова отфильтрованы).
const flatNavHtml = `
  <html><body><header><nav>
    <a href="/">Главная</a>
    <a href="/printing">Полиграфия</a>
    <a href="/branding">Брендинг</a>
    <a href="/contacts">Контакты</a>
  </nav></header></body></html>`;
const flatServices = extractServicesFromHeader(flatNavHtml);
ok('flat-меню: «Полиграфия»/«Брендинг» взяты, стоп-слова — нет',
  flatServices.includes('Полиграфия') && flatServices.includes('Брендинг')
  && !flatServices.includes('Главная') && !flatServices.includes('Контакты'),
  `got: ${JSON.stringify(flatServices)}`);

console.log('\n[serpB2b] Aggregator blacklist');
ok('avito.ru → blacklisted', isBlacklistedHost('www.avito.ru'));
ok('cian.ru → blacklisted', isBlacklistedHost('cian.ru'));
ok('yandex.ru → blacklisted', isBlacklistedHost('yandex.ru'));
ok('hh.ru → blacklisted', isBlacklistedHost('hh.ru'));
ok('superjob.ru → blacklisted', isBlacklistedHost('www.superjob.ru'));
ok('youdo.com → blacklisted', isBlacklistedHost('youdo.com'));
ok('subdomain market.yandex → blacklisted', isBlacklistedHost('market.yandex.ru'));
ok('https://avito.ru/foo → blacklisted', isBlacklistedUrl('https://avito.ru/foo'));
ok('обычный сайт → НЕ blacklisted', !isBlacklistedHost('beton-stroy.ru'));
ok('javascript: → blacklisted (не http)', isBlacklistedUrl('javascript:alert(1)'));

console.log('\n[serpB2b] Full extractContactsFromPage integration');
const fullHtml = `
  <html><body>
    <header><nav class="main-menu">
      <li class="has-submenu">
        <a href="/services">Услуги</a>
        <ul><li><a href="/x">Поставка щебня</a></li><li><a href="/y">Аренда техники</a></li></ul>
      </li>
    </nav></header>
    <footer>
      ООО «Бетон-Строй» ИНН 7707083893 ОГРН 1027700132195 КПП 770701001
      Тел.: <a href="tel:+74951234567">+7 (495) 123-45-67</a>,
      <a href="tel:89052345678">+7 (905) 234-56-78</a>
      <a href="mailto:info@example.ru">info@example.ru</a>
    </footer>
  </body></html>`;
const full = extractContactsFromPage(fullHtml);
ok('full: ИНН валиден', full.inn === '7707083893' && isValidInn(full.inn));
ok('full: ОГРН валиден', full.ogrn === '1027700132195' && isValidOgrn(full.ogrn));
ok('full: КПП', full.kpp === '770701001');
ok('full: company_name', full.company_name && full.company_name.includes('Бетон-Строй'));
ok('full: phones split mobile/landline',
  full.phones_mobile.some((p) => p.includes('(905)'))
  && full.phones_landline.some((p) => p.includes('(495)')),
  `mobile=${JSON.stringify(full.phones_mobile)} landline=${JSON.stringify(full.phones_landline)}`);
ok('full: email', full.emails.includes('info@example.ru'));
ok('full: services',
  Array.isArray(full.services) && full.services.length === 2
  && full.services.includes('Поставка щебня'));

console.log('\n[serpB2b] Structured requisites — JSON-LD / <meta> / itemprop');
const jsonLdHtml = `
  <html><head>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": "ООО \\"Ромашка-Технологии\\"",
        "taxID": "7707083893",
        "ogrn": "1027700132195"
      }
    </script>
    <meta itemprop="taxID" content="7707083893">
  </head><body>
    <footer>Просто текст без ИНН в видимом DOM.</footer>
  </body></html>`;
const struct = extractStructuredRequisites(jsonLdHtml);
ok('JSON-LD: ИНН подхвачен по taxID и валиден',
  struct.inn === '7707083893' && isValidInn(struct.inn),
  `got: ${JSON.stringify(struct)}`);
ok('JSON-LD: ОГРН подхвачен и валиден',
  struct.ogrn === '1027700132195' && isValidOgrn(struct.ogrn),
  `got: ${JSON.stringify(struct)}`);
ok('JSON-LD: name → нормализован к ООО «...»',
  struct.company_name && struct.company_name.includes('Ромашка-Технологии'),
  `got: ${struct.company_name}`);

// extractContactsFromPage должен ловить реквизиты из JSON-LD, даже когда
// видимый DOM пуст (важный кейс: ИНН спрятан под спойлером/в скриптах).
const hiddenInnHtml = `
  <html><head>
    <script type="application/ld+json">
      {"@type":"Organization","name":"ООО \\"СкрытыйИНН\\"","taxID":"7707083893"}
    </script>
  </head><body><div>Контакты у нас в футере, ИНН не виден глазом.</div></body></html>`;
const hiddenContacts = extractContactsFromPage(hiddenInnHtml);
ok('extractContactsFromPage: ИНН из JSON-LD при пустом DOM',
  hiddenContacts.inn === '7707083893',
  `got: ${JSON.stringify(hiddenContacts)}`);
ok('extractContactsFromPage: company_name из JSON-LD при пустом DOM',
  hiddenContacts.company_name && hiddenContacts.company_name.includes('СкрытыйИНН'),
  `got: ${hiddenContacts.company_name}`);
ok('extractContactsFromPage: company_name_source = "jsonld" для JSON-LD',
  hiddenContacts.company_name_source === 'jsonld',
  `got: ${hiddenContacts.company_name_source}`);

// Если структурированной разметки нет, источник = 'html'.
const plainHtml = `
  <html><body><footer>
    Мы — ООО «АльфаТех», свяжитесь с нами.
  </footer></body></html>`;
const plainContacts = extractContactsFromPage(plainHtml);
ok('extractContactsFromPage: company_name_source = "html" без JSON-LD',
  plainContacts.company_name && plainContacts.company_name_source === 'html',
  `got: name=${plainContacts.company_name} source=${plainContacts.company_name_source}`);

// Если ничего не найдено — source = null.
const emptyContacts = extractContactsFromPage('<html><body><p>Just text.</p></body></html>');
ok('extractContactsFromPage: company_name_source = null когда имя не найдено',
  emptyContacts.company_name === null && emptyContacts.company_name_source === null,
  `got: name=${emptyContacts.company_name} source=${emptyContacts.company_name_source}`);

// Невалидная контрольная сумма ИНН в JSON-LD не должна попадать в результат.
const badInnHtml = `
  <html><head>
    <script type="application/ld+json">{"@type":"Organization","taxID":"1234567890"}</script>
  </head><body>foo</body></html>`;
const badStruct = extractStructuredRequisites(badInnHtml);
ok('JSON-LD: невалидный ИНН (битая контр. сумма) отбрасывается',
  badStruct.inn === null,
  `got: ${badStruct.inn}`);

// <meta itemprop="..."> в head — fallback, когда JSON-LD нет.
const metaOnlyHtml = '<html><head><meta itemprop="ogrn" content="1027700132195"></head><body></body></html>';
ok('meta itemprop=ogrn: ОГРН подхвачен',
  extractStructuredRequisites(metaOnlyHtml).ogrn === '1027700132195');

console.log('\n[serpB2b] Dadata client — gating + cache');
const prevKey = process.env.DADATA_API_KEY;
delete process.env.DADATA_API_KEY;
_resetDadataCache();
ok('isDadataEnabled() === false без ключа', !isDadataEnabled());
(async () => {
  const r = await lookupByInn('7707083893');
  ok('lookupByInn без ключа → null', r === null, `got: ${JSON.stringify(r)}`);
  if (prevKey) process.env.DADATA_API_KEY = prevKey;
})();
// Невалидный ИНН — даже при наличии ключа не делаем сетевой запрос.
process.env.DADATA_API_KEY = 'fake-key-for-test';
_resetDadataCache();
(async () => {
  const r = await lookupByInn('1234567890'); // битая контр. сумма
  ok('lookupByInn(битый ИНН) → null без сетевого запроса', r === null);
  delete process.env.DADATA_API_KEY;
  if (prevKey) process.env.DADATA_API_KEY = prevKey;
})();

console.log('\n[serpB2b] LLM extractor — legal-entity validation');
ok('valid: ООО «Ромашка»', _looksLikeLegalEntity('ООО «Ромашка»'));
ok('valid: ИП Иванов И.И.', _looksLikeLegalEntity('ИП Иванов И.И.'));
ok('valid: Общество с ограниченной ответственностью «Бетон-Строй»',
  _looksLikeLegalEntity('Общество с ограниченной ответственностью «Бетон-Строй»'));
ok('reject: пустая строка', !_looksLikeLegalEntity(''));
ok('reject: просто слово', !_looksLikeLegalEntity('Ромашка'));
ok('reject: слишком длинный текст',
  !_looksLikeLegalEntity('ООО «' + 'Х'.repeat(300) + '»'));
ok('reject: null', !_looksLikeLegalEntity(null));

console.log('\n[serpB2b] Pipeline robustness — _processSite swallows page errors');
const fetcher = require('../src/services/serpB2b/siteFetcher');
const realFetch = fetcher.fetchPage;
let calls = 0;
fetcher.fetchPage = async (url) => {
  calls += 1;
  if (calls === 1) {
    return { url, status: 200, html: '<html><body><a href="/contacts">Контакты</a><a href="/privacy">Политика</a></body></html>' };
  }
  if (calls === 2) {
    // Первая contact-страница падает — пайплайн не должен валиться.
    const e = new Error('ECONNRESET'); e.code = 'network'; throw e;
  }
  // Вторая — валидная политика с ИНН.
  return { url, status: 200, html: 'ООО «ПолитикаКонтрагент» ИНН 7707083893' };
};
(async () => {
  const { _processSite } = require('../src/services/serpB2b/pipeline');
  const row = await _processSite('https://test.example/');
  ok('_processSite не падает на ошибочной странице',
    row && row.status !== 'error',
    `status=${row && row.status}`);
  ok('_processSite собирает данные с альтернативных страниц',
    row.inn === '7707083893' && row.company_name,
    `inn=${row && row.inn} name=${row && row.company_name}`);
  ok('_processSite заполняет company_name_source ("html_requisites" из текста политики)',
    row.company_name_source === 'html_requisites',
    `got: ${row && row.company_name_source}`);
  fetcher.fetchPage = realFetch;

  console.log(`\n${failed === 0 ? '✅ ALL OK' : `❌ ${failed} TEST(S) FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
