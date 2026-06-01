'use strict';

const assert = require('assert');

// Стаб pg: smoke-тесты гоняются без установленных зависимостей/БД. Перехватываем
// require('pg') до загрузки config/db, чтобы протестировать чистую логику воркера.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') {
    return {
      Pool: class {
        on() {}
        query() { return Promise.resolve({ rows: [] }); }
        connect() { return Promise.resolve({ release() {}, query() { return Promise.resolve({ rows: [] }); } }); }
      },
    };
  }
  return _origLoad.apply(this, arguments);
};

const { parseIssueToTask } = require('../src/services/aegis/backlogParser');

(async function run() {
  const a = parseIssueToTask({
    number: 1,
    title: 'Тестовая тема',
    body: 'kind: link-article\nquery: купить окна\nanchor_url: https://example.com',
    html_url: 'https://github.com/x/y/issues/1',
  });
  assert.equal(a.kind, 'link-article');
  assert.equal(a.payload.query, 'купить окна');
  assert.equal(a.payload.anchor_url, 'https://example.com');

  const b = parseIssueToTask({
    number: 2,
    title: 'Only title',
    body: '',
    html_url: '',
  });
  assert.equal(b.kind, 'info-article');
  assert.equal(b.payload.query, 'Only title');

  // ── Идемпотентность диспатча (защита от cache-miss-«протечки») ──────────
  // _alreadyProcessing должен вернуть true только когда issue уже в работе
  // (aegis_backlog.status='processing'), чтобы воркер не переотправлял его
  // каждые 60с, когда метки GitHub не применились.
  const db = require('../src/config/db');
  const { _alreadyProcessing } = require('../src/services/aegis/backlogWorker');
  const origQuery = db.query;

  db.query = async () => ({ rows: [{ status: 'processing' }] });
  assert.equal(await _alreadyProcessing(42), true, 'processing → skip (idempotent)');

  db.query = async () => ({ rows: [{ status: 'done' }] });
  assert.equal(await _alreadyProcessing(42), false, 'done → не блокируем');

  db.query = async () => ({ rows: [] });
  assert.equal(await _alreadyProcessing(99), false, 'нет записи → новый issue, диспатчим');

  db.query = async () => { throw new Error('db down'); };
  assert.equal(await _alreadyProcessing(7), false, 'ошибка БД → graceful (не блокируем)');

  db.query = origQuery;

  console.log('test-aegis-backlog: ok');
  // Явный выход: импорт backlogWorker → dispatcher тянет SSE/Redis-клиенты,
  // которые держат event loop живым (бесконечный reconnect без реального Redis).
  process.exit(0);
})().catch((err) => { console.error('test-aegis-backlog: FAIL', err); process.exit(1); });
