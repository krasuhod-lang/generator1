'use strict';

const assert = require('assert');
const biobrain = require('../src/services/aegis/biobrainClient');

(async () => {
  const s = await biobrain.status();
  assert.ok(s && typeof s === 'object');

  const p = await biobrain.predict({ text: 'demo' });
  assert.ok(p && typeof p === 'object');

  const f = await biobrain.feedback({
    features: [0.1, 0.2, 0.3, 0.4, 0.5, 0.2, 0.1, 1.0],
    predicted: 0.5,
    real_spq_overall: 82,
    real_eeat: 75,
  });
  assert.ok(f && typeof f === 'object');

  console.log('test-biobrain-client: ok');
})();
