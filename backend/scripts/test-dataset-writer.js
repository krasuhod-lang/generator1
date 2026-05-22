'use strict';

const assert = require('assert');
const { _passesGate, _hashUser } = require('../src/services/aegis/datasetWriter');

(function run() {
  assert.equal(_hashUser('abc').length, 16);

  const pass = _passesGate({ overall: 85, subscores: { eeat: 80, fact_check: 80, plagiarism: 80 } });
  assert.equal(pass, true);

  const fail = _passesGate({ overall: 60, subscores: { eeat: 90, fact_check: 90, plagiarism: 90 } });
  assert.equal(fail, false);

  const passFallback = _passesGate({ overall: 85, subscores: {} });
  assert.equal(passFallback, true);

  console.log('test-dataset-writer: ok');
})();
