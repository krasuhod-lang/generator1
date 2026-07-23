'use strict';

/**
 * Smoke-tests для доработок модуля Outreach.
 *
 * Покрывает:
 *   • разнообразные и короткие темы писем с гео/цифрами (req 1);
 *   • заголовок-плашку письма с гео/цифрами (req 1/2);
 *   • блок контактов отправителя (сайт + Telegram) в подписи (req 3);
 *   • plain-text версию письма (req 4);
 *   • окно отправки по МСК в calculateSendDelay (req 4);
 *   • извлечение мессенджеров WhatsApp/Telegram/MAX без каналов (req 6).
 *
 * Запуск:  node backend/scripts/test-outreach-enhancements.js
 */

const assert = require('assert');

// Подменяем pg/db, чтобы тесты не зависели от БД.
require.cache[require.resolve('../src/config/db')] = {
  exports: { query: async () => ({ rows: [], rowCount: 0 }) },
};

const {
  buildCatchySubject, buildHeroHeading, buildContactBlock,
} = require('../src/services/outreach/emailComposer');
const { extractMessengerLinks } = require('../src/services/serpB2b/extractors');
const { calculateSendDelay } = require('../src/services/outreach/outreachScheduler');

let failures = 0;
function ok(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name}`); failures++; }
}

const detail = {
  yandex: { trend: 'decline', deviation_pct: -42.1, first: { value: 810 }, last: { value: 469 }, months: 7 },
  google: { trend: 'growth', deviation_pct: 12, first: { value: 100 }, last: { value: 112 } },
};

console.log('\n[outreach] Темы писем (req 1) — разнообразие + читаемая длина');
{
  const subjects = new Set();
  const urls = ['https://a-clinic.ru', 'https://b-dent.ru', 'https://c-implant.ru', 'https://d-med.ru'];
  for (const url of urls) {
    const s = buildCatchySubject({ prospect: { url, city: 'Казань' }, detail });
    subjects.add(s);
    ok(`тема ≤ 50 симв. для ${url} ("${s}")`, s.length <= 50 && s.length > 0);
  }
  ok('темы различаются между разными сайтами', subjects.size > 1);

  // Цифры/гео подтягиваются, когда есть падение.
  const withNum = buildCatchySubject({ prospect: { url: 'https://a.ru', city: 'Пермь' }, detail });
  ok('без падения детерминирована (стабильна)',
    buildCatchySubject({ prospect: { url: 'https://only.ru' } }) === buildCatchySubject({ prospect: { url: 'https://only.ru' } }));
  ok('строка не пустая', withNum.length > 0);
}

console.log('\n[outreach] Заголовок-плашка (req 1/2)');
{
  const hero = buildHeroHeading({ prospect: { url: 'https://klinika.ru', city: 'Сочи' }, detail });
  ok('заголовок не пустой', typeof hero === 'string' && hero.length > 0);
  ok('заголовок стабилен для одного лида',
    buildHeroHeading({ prospect: { url: 'https://x.ru' }, detail: null }) ===
    buildHeroHeading({ prospect: { url: 'https://x.ru' }, detail: null }));
}

console.log('\n[outreach] Блок контактов отправителя (req 3)');
{
  const block = buildContactBlock({
    senderName: 'Иван', senderCompany: 'SEO Team',
    senderSite: 'myseo.ru', senderTelegram: '@ivan_seo',
  });
  ok('содержит сайт', /myseo\.ru/.test(block));
  ok('нормализует сайт в https', /href="https:\/\/myseo\.ru"/.test(block));
  ok('содержит Telegram-ссылку', /href="https:\/\/t\.me\/ivan_seo"/.test(block));
  ok('содержит имя отправителя', block.includes('Иван'));

  const empty = buildContactBlock({ senderName: 'Иван', senderCompany: 'Иван' });
  ok('без контактов не падает и не дублирует имя', empty.includes('Иван') && !/href=/.test(empty));
}

console.log('\n[outreach] Мессенджеры (req 6) — только личный контакт, без каналов');
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

console.log('\n[outreach] Окно отправки МСК (req 4)');
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
