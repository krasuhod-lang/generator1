'use strict';

/**
 * Smoke-tests модуля «Рассылка».
 *
 * Покрывает:
 *   • тему письма (короткая, с гео/конкурентом);
 *   • блоки письма: конкуренты, кейсы, подпись с контактами;
 *   • plain-text версию письма;
 *   • ОТСУТСТВИЕ прогнозов в письме (клиентам прогнозы не отправляем);
 *   • окно отправки по МСК в calculateSendDelay;
 *   • извлечение мессенджеров WhatsApp/Telegram/MAX без каналов.
 *
 * Запуск:  node backend/scripts/test-outreach-enhancements.js
 */

const assert = require('assert');

// Подменяем pg/db, чтобы тесты не зависели от БД.
require.cache[require.resolve('../src/config/db')] = {
  exports: { query: async () => ({ rows: [], rowCount: 0 }) },
};

const {
  composeProvocationEmailV2, buildSubject,
} = require('../src/services/outreach/provocation/emailComposerProvocation');
const { extractMessengerLinks } = require('../src/services/serpB2b/extractors');
const { calculateSendDelay } = require('../src/services/outreach/outreachScheduler');

let failures = 0;
function ok(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name}`); failures++; }
}

const competitors = [
  { domain: 'a-clinic.ru', company_name: 'А-Клиника', traffic_month: 12000 },
  { domain: 'b-dent.ru', company_name: null, traffic_month: 8400 },
];
const cases = [{
  domain: 'top-dent.ru', city: 'Пермь', traffic_month: 9100,
  leads_min: 40, leads_max: 70,
  top_keywords: [{ phrase: 'имплантация зубов', volume: 5400 }],
}];
const sender = {
  senderName: 'Иван', senderCompany: 'SEO Team',
  senderSite: 'https://myseo.ru', senderTelegram: '@ivan_seo',
};

function build(extra = {}) {
  return composeProvocationEmailV2({
    prospect: { url: 'https://klinika.ru', city: 'Казань' },
    competitors, prospectTraffic: 900, cases,
    unit: 'пациентов', sampleQuery: 'стоматология казань',
    sender, unsubscribeUrl: 'https://app.example/unsubscribe',
    ...extra,
  });
}

console.log('\n[рассылка] Тема письма');
{
  const s = buildSubject({ anchorDomain: 'a-clinic.ru', city: 'Казань', prospectDomain: 'klinika.ru' });
  ok(`тема ≤ 60 симв. ("${s}")`, s.length > 0 && s.length <= 60);
  ok('тема содержит конкурента', s.includes('a-clinic.ru'));
  ok('тема детерминирована', s === buildSubject({ anchorDomain: 'a-clinic.ru', city: 'Казань', prospectDomain: 'klinika.ru' }));

  const noComp = buildSubject({ anchorDomain: null, city: '', prospectDomain: 'klinika.ru' });
  ok('без конкурента тема не пустая', noComp.length > 0);
}

console.log('\n[рассылка] Тело письма');
{
  const letter = build();
  ok('есть subject/html/text', Boolean(letter.subject && letter.html && letter.text));
  ok('в письме перечислены конкуренты', letter.html.includes('a-clinic.ru') && letter.html.includes('b-dent.ru'));
  ok('показан трафик лида', letter.html.includes('900'));
  ok('есть блок кейсов', letter.html.includes('top-dent.ru'));
  ok('единица ниши подставлена', letter.html.includes('пациентов'));
  ok('есть ссылка отписки', letter.html.includes('https://app.example/unsubscribe'));
  ok('нет inline-SVG (вырезается почтовиками)', !/<svg/i.test(letter.html));

  const empty = build({ competitors: [], cases: [], prospectTraffic: 0 });
  ok('без данных письмо всё равно собирается', Boolean(empty.html && empty.text));
}

console.log('\n[рассылка] Прогнозы клиентам НЕ отправляем');
{
  const letter = build();
  const body = `${letter.subject}\n${letter.html}\n${letter.text}`;
  ok('нет слова «прогноз»', !/прогноз/i.test(body));
  ok('нет ссылки на публичный прогноз', !/\/forecast\//i.test(body));
  ok('нет кнопки «Смотреть прогноз»', !/Смотреть прогноз/i.test(body));
}

console.log('\n[рассылка] Блок контактов отправителя');
{
  const letter = build();
  ok('содержит сайт отправителя', /myseo\.ru/.test(letter.html));
  ok('содержит Telegram-ссылку', /href="https:\/\/t\.me\/ivan_seo"/.test(letter.html));
  ok('содержит имя отправителя', letter.html.includes('Иван'));

  const noContacts = build({ sender: { senderName: 'Иван', senderCompany: 'Иван' } });
  ok('без контактов не падает и не дублирует имя',
    noContacts.html.includes('Иван') && !/t\.me/.test(noContacts.html));
}

console.log('\n[рассылка] Plain-text версия');
{
  const { text } = build();
  ok('текстовая версия не пустая', typeof text === 'string' && text.length > 0);
  ok('без HTML-тегов', !/<[a-z][\s\S]*>/i.test(text));
  ok('содержит конкурента', text.includes('a-clinic.ru'));
}

console.log('\n[рассылка] Мессенджеры — только личный контакт, без каналов');
{
  const html = `
    <a href="https://wa.me/79001234567">WhatsApp</a>
    <a href="https://api.whatsapp.com/send?phone=79001112233">wa</a>
    <a href="https://t.me/company_manager">Telegram</a>
    <a href="//max.ru/u/client">MAX</a>
    <a href="https://t.me/joinchat/AbCdEf">закрытый канал</a>
    <a href="https://t.me/s/publicchannel">публичный канал</a>
    <a href="https://vk.com/club123">VK</a>
    <a href="mailto:info@x.ru">почта</a>`;
  const links = extractMessengerLinks(html);
  const types = links.map((l) => l.type);
  ok('нашёл WhatsApp', types.includes('whatsapp'));
  ok('нашёл Telegram (личный)', links.some((l) => l.type === 'telegram' && l.url.includes('company_manager')));
  ok('нашёл MAX (нормализовал протокол)', links.some((l) => l.type === 'max' && l.url.startsWith('https://')));
  ok('исключил joinchat-канал', !links.some((l) => /joinchat/.test(l.url)));
  ok('исключил публичный канал /s/', !links.some((l) => /\/s\//.test(l.url)));
  ok('не считает VK/почту мессенджером', !links.some((l) => /vk\.com/.test(l.url) || /mailto/.test(l.url)));
}

console.log('\n[рассылка] Окно отправки МСК');
{
  // Всегда неотрицательная задержка и в разумных пределах (< 48 ч).
  const d0 = calculateSendDelay(0, 10);
  const d5 = calculateSendDelay(5, 10);
  ok('задержка неотрицательна', d0 >= 0 && d5 >= 0);
  ok('задержка ограничена 48 часами', d0 < 48 * 3600 * 1000 && d5 < 48 * 3600 * 1000);
  ok('индекс дальше по списку → не раньше по времени', d5 >= d0);
}

console.log('');
if (failures) {
  console.error(`❌ ${failures} проверок провалено`);
  process.exit(1);
}
console.log('✅ ALL OK');
process.exit(0);
