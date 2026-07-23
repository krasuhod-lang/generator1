'use strict';
/**
 * test-outreach-send — dry-run проверки связки outreach без реальной отправки.
 *
 * Покрывает (Блоки 2/3/5 ТЗ):
 *   • assertComplete — детект обрыва письма;
 *   • buildCatchySubject — «цепляющая» тема с цифрой падения из keys.so;
 *   • isValidSubject — фильтр длины/спам-слов;
 *   • buildDynamicsChart — inline-SVG график динамики;
 *   • composeEmail — эскалация при обрыве + fallback (LLM/ DSPy замоканы).
 *
 * LLM (callLLM) и DSPy (dspyClient) замоканы через require.cache — сеть и БД
 * не дёргаются.
 */
const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed += 1; }
  catch (err) { console.error(`✗ ${name}\n  ${err.message}`); failed += 1; }
}

// ── Мокаем DSPy (graceful, всегда пустой суффикс) ─────────────────────
const dspyPath = require.resolve('../src/services/projects/dspyClient');
require.cache[dspyPath] = {
  id: dspyPath, filename: dspyPath, loaded: true,
  exports: { buildPromptSuffix: async () => '', enhancePrompt: async () => ({ ok: false }) },
};

// ── Управляемый мок callLLM ───────────────────────────────────────────
let _llmResponses = [];
const llmPath = require.resolve('../src/services/llm/callLLM');
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: {
    callLLM: async () => {
      if (!_llmResponses.length) return null;
      const r = _llmResponses.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    BudgetExceededError: class {}, resetTaskBudget() {}, getTaskBudgetSpent() { return 0; },
  },
};

const {
  composeEmail, buildCatchySubject, assertComplete, isValidSubject,
  _buildGreeting, _buildContactBlock,
} = require('../src/services/outreach/emailComposer');
const { buildDynamicsChart } = require('../src/services/outreach/emailChart');

const P = (t) => `<p style="font:14px Arial">${t}</p>`;
const COMPLETE_HTML = P('Абзац раз.') + P('Абзац два.') + P('Оффер три.') + P('Прислать разбор?');

const DETAIL = {
  google: { trend: 'decline', deviation_pct: -42.1, first: { value: 810 }, last: { value: 469 }, months: 7 },
  yandex: { trend: 'growth', deviation_pct: 18.2, first: { value: 650 }, last: { value: 768 }, months: 7 },
};
const PROSPECT = {
  url: 'https://www.example-clinic.ru/', company_name: 'Клиника', niche: 'имплантация',
  city: 'Москва', services: ['импланты'], dynamics_detail: DETAIL,
};

(async () => {
  await test('assertComplete: полное письмо валидно', () => {
    assert.strictEqual(assertComplete(COMPLETE_HTML), true);
  });
  await test('assertComplete: обрыв на середине тега невалиден', () => {
    assert.strictEqual(assertComplete(P('раз.') + '<p style="font:14px Arial">обрыв на середине сло'), false);
  });
  await test('assertComplete: незаконченное предложение невалидно', () => {
    assert.strictEqual(assertComplete(P('раз.') + P('этот абзац не закончен и')), false);
  });
  await test('assertComplete: пустой/нестроковый вход', () => {
    assert.strictEqual(assertComplete(''), false);
    assert.strictEqual(assertComplete(null), false);
  });

  await test('buildCatchySubject: numeric_drop по худшему падению', () => {
    const r = buildCatchySubject(PROSPECT, DETAIL);
    assert.strictEqual(r.strategy, 'numeric_drop');
    assert.ok(/42/.test(r.subject), `нет цифры падения: ${r.subject}`);
    assert.ok(/Google/.test(r.subject), 'нет движка падения');
    assert.ok(r.subject.length <= 55, 'тема длиннее 55 символов');
  });
  await test('buildCatchySubject: competitor при отсутствии падения', () => {
    const r = buildCatchySubject({ url: 'https://site.ru' }, { yandex: { trend: 'growth', deviation_pct: 5, first: { value: 1 }, last: { value: 2 } } });
    assert.strictEqual(r.strategy, 'competitor');
  });

  await test('isValidSubject: длина и спам-слова', () => {
    assert.strictEqual(isValidSubject('site.ru: −42% в Google'), true);
    assert.strictEqual(isValidSubject('Бесплатно поднимем сайт'), false);
    assert.strictEqual(isValidSubject('x'.repeat(60)), false);
  });

  await test('buildDynamicsChart: SVG с обеими сериями', () => {
    const { html } = buildDynamicsChart(DETAIL);
    assert.ok(html.includes('<svg'), 'нет svg');
    assert.ok(html.includes('polyline'), 'нет линий');
    assert.ok(html.includes('keys.so'), 'нет подписи источника');
  });
  await test('buildDynamicsChart: пусто без данных', () => {
    assert.strictEqual(buildDynamicsChart(null).html, '');
    assert.strictEqual(buildDynamicsChart({}).html, '');
  });

  await test('composeEmail: принимает первое законченное письмо', async () => {
    _llmResponses = [{ subject: 'example-clinic.ru: −42% в Google', html: COMPLETE_HTML }];
    const r = await composeEmail({ prospect: PROSPECT, senderName: 'Иван', senderCompany: 'SEO', unsubscribeUrl: 'https://app/u?t=1' });
    assert.strictEqual(r.manual_review_required, false);
    assert.ok(r.html.includes('Оффер три.'), 'нет тела письма');
    assert.ok(r.html.includes('<svg'), 'нет графика');
    assert.ok(r.html.includes('Отписаться'), 'нет footer');
    assert.strictEqual(r.strategy, 'numeric_drop');
  });

  await test('composeEmail: эскалация — 1-й обрыв, 2-й ок', async () => {
    _llmResponses = [
      { subject: 's', html: P('раз.') + '<p>обрыв на середине сло' }, // невалидно
      { subject: 'example-clinic.ru: −42% в Google', html: COMPLETE_HTML }, // валидно
    ];
    const r = await composeEmail({ prospect: PROSPECT, senderName: 'Иван', senderCompany: 'SEO', unsubscribeUrl: 'https://app/u?t=1' });
    assert.strictEqual(r.manual_review_required, false);
    assert.ok(r.html.includes('Оффер три.'));
  });

  await test('composeEmail: fallback-шаблон при полном провале LLM', async () => {
    _llmResponses = [new Error('boom'), new Error('boom'), new Error('boom')];
    const r = await composeEmail({ prospect: PROSPECT, senderName: 'Иван', senderCompany: 'SEO', unsubscribeUrl: 'https://app/u?t=1' });
    assert.strictEqual(r.manual_review_required, true);
    assert.ok(r.html.includes('example-clinic.ru'), 'fallback без домена');
    assert.ok(r.html.includes('видео'), 'fallback без оффера');
    assert.ok(r.subject.length <= 55 && r.subject.length > 0, 'нет темы у fallback');
  });

  // ── Приветствие по времени суток (МСК) ─────────────────────────────
  await test('_buildGreeting: утро / день / вечер / ночь по МСК', () => {
    const at = (h) => _buildGreeting(Date.UTC(2026, 0, 15, h - 3, 0, 0)); // h — час МСК
    assert.ok(at(8).includes('Доброе утро'), 'утро');
    assert.ok(at(14).includes('Добрый день'), 'день');
    assert.ok(at(20).includes('Добрый вечер'), 'вечер');
    assert.ok(at(2).includes('Здравствуйте'), 'ночь');
  });

  await test('composeEmail: письмо начинается с приветствия', async () => {
    _llmResponses = [{ subject: 'example-clinic.ru: −42% в Google', html: COMPLETE_HTML }];
    const r = await composeEmail({ prospect: PROSPECT, senderName: 'Иван', senderCompany: 'SEO', unsubscribeUrl: 'https://app/u?t=1' });
    assert.ok(/^<p[^>]*>(Доброе утро|Добрый день|Добрый вечер|Здравствуйте)/.test(r.html.trim()), 'нет приветствия в начале');
  });

  // ── Блок контактов (сайт + Telegram-CTA) ───────────────────────────
  await test('_buildContactBlock: пусто без данных', () => {
    assert.strictEqual(_buildContactBlock({}), '');
    assert.strictEqual(_buildContactBlock({ site: '', telegram: '' }), '');
  });

  await test('_buildContactBlock: сайт нормализуется в https + host-подпись', () => {
    const html = _buildContactBlock({ site: 'example.ru' });
    assert.ok(html.includes('href="https://example.ru"'), 'нет https-ссылки');
    assert.ok(html.includes('>example.ru<'), 'нет подписи домена');
  });

  await test('_buildContactBlock: Telegram — CTA + t.me из @username', () => {
    const html = _buildContactBlock({ telegram: '@seo_expert' });
    assert.ok(html.includes('href="https://t.me/seo_expert"'), 'нет t.me ссылки');
    assert.ok(html.includes('Telegram'), 'нет призыва в Telegram');
    assert.ok(html.includes('@seo_expert'), 'нет подписи username');
  });

  await test('_buildContactBlock: Telegram из t.me/ ссылки', () => {
    const html = _buildContactBlock({ telegram: 'https://t.me/seo_expert' });
    assert.ok(html.includes('href="https://t.me/seo_expert"'), 'ссылка t.me не распознана');
  });

  await test('_buildContactBlock: экранирует имя (защита от инъекций)', () => {
    const html = _buildContactBlock({ site: 'example.ru', senderName: '<script>' });
    assert.ok(!html.includes('<script>'), 'имя не экранировано');
    assert.ok(html.includes('&lt;script&gt;'), 'нет экранированного имени');
  });

  await test('composeEmail: блок контактов попадает в письмо', async () => {
    _llmResponses = [{ subject: 'example-clinic.ru: −42% в Google', html: COMPLETE_HTML }];
    const r = await composeEmail({
      prospect: PROSPECT, senderName: 'Иван', senderCompany: 'SEO',
      senderSite: 'agency.ru', senderTelegram: '@seo_expert',
      unsubscribeUrl: 'https://app/u?t=1',
    });
    assert.ok(r.html.includes('href="https://agency.ru"'), 'нет ссылки на сайт');
    assert.ok(r.html.includes('href="https://t.me/seo_expert"'), 'нет ссылки на Telegram');
    // Контакты идут ПОСЛЕ тела письма и ПЕРЕД footer-отпиской.
    assert.ok(r.html.indexOf('Оффер три.') < r.html.indexOf('t.me/seo_expert'), 'контакты выше тела');
    assert.ok(r.html.indexOf('t.me/seo_expert') < r.html.indexOf('Отписаться'), 'контакты ниже footer');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
