'use strict';

/**
 * Smoke-test для personas.
 * Проверяет:
 *   1. listPersonas() возвращает 7 ключей.
 *   2. Каждый .txt файл существует и непустой (>200 chars).
 *   3. pickPersonaFor детерминированный.
 *   4. pickPersonaFor распределяет более-менее равномерно по 7 категориям.
 *   5. buildPersonaSystemBlock содержит anti-hallucination блок.
 *   6. Override через opts.persona работает.
 *   7. Невалидный persona override fallback'ит на pickPersonaFor.
 */

const assert = require('assert');
const personas = require('../src/prompts/infoArticle/personas');

// 1. list
const keys = personas.listPersonas();
assert.strictEqual(keys.length, 7, 'expect 7 personas');
console.log(`✓ listPersonas: ${keys.join(', ')}`);

// 2. content non-empty
for (const k of keys) {
  const body = personas.getPersonaPrompt(k);
  assert.ok(body && body.length > 200, `${k} prompt should be >200 chars, got ${body.length}`);
  // Каждая персона должна содержать секцию anti-hallucination
  assert.ok(/anti-hallucination/i.test(body) || /НЕ выдумывай|НЕ придумывай/i.test(body),
    `${k} should contain anti-hallucination guidance`);
}
console.log('✓ all 7 persona files non-empty + anti-hallucination guidance');

// 3. determinism
const a = personas.pickPersonaFor({ topic: 'мёд', region: '213', brand: 'Алтай' });
const b = personas.pickPersonaFor({ topic: 'мёд', region: '213', brand: 'Алтай' });
assert.strictEqual(a, b, 'same input → same persona');
const c = personas.pickPersonaFor({ topic: 'мёд', region: '213', brand: 'Башкирия' });
const sameByChance = a === c; // possible but pick is hash-based
console.log(`✓ pickPersonaFor deterministic (mёд×Алтай=${a}, mёд×Башкирия=${c}${sameByChance ? ' [collision OK]' : ''})`);

// 4. distribution — на 1000 случайных строк должно покрываться ≥ 5 из 7 персон
const dist = new Map();
for (let i = 0; i < 1000; i += 1) {
  const k = personas.pickPersonaFor({ topic: `тема ${i}`, region: 'r', brand: `b${i % 50}` });
  dist.set(k, (dist.get(k) || 0) + 1);
}
assert.ok(dist.size >= 5, `expected ≥5 distinct personas across 1000 inputs, got ${dist.size}`);
console.log(`✓ pickPersonaFor distributes across ${dist.size}/7 personas (1000 inputs)`);

// 5. system block contains anti-hallucination hard rules
const { key, block } = personas.buildPersonaSystemBlock({ topic: 'мёд', brand: 'X' });
assert.ok(block.length > 500, 'block should be substantial');
assert.ok(/ANTI-HALLUCINATION HARD RULES/.test(block), 'block contains hard rules');
assert.ok(/АВТОРСКАЯ ПЕРСОНА/.test(block), 'block contains persona marker');
console.log(`✓ buildPersonaSystemBlock: key=${key}, ${block.length} chars, contains anti-hallucination`);

// 6. override
const overr = personas.buildPersonaSystemBlock({ topic: 'мёд', persona: 'engineer' });
assert.strictEqual(overr.key, 'engineer');
assert.ok(overr.block.includes('ИНЖЕНЕР-ТЕХНОЛОГ'));
console.log('✓ explicit persona override works');

// 7. invalid override → fallback to deterministic
const bad = personas.buildPersonaSystemBlock({ topic: 'мёд', persona: 'nonexistent_persona' });
assert.notStrictEqual(bad.key, 'nonexistent_persona');
assert.ok(keys.includes(bad.key));
console.log(`✓ invalid override falls back to ${bad.key}`);

// 8. empty seed → first persona (graceful)
const empty = personas.pickPersonaFor({});
assert.strictEqual(empty, keys[0]);
console.log(`✓ empty seed → ${empty}`);

console.log('\n✅ test-personas: all checks passed');
