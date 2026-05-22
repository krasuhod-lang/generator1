'use strict';

const assert = require('assert');
const { parseIssueToTask } = require('../src/services/aegis/backlogParser');

(function run() {
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

  console.log('test-aegis-backlog: ok');
})();
