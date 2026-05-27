'use strict';

/**
 * brandAliases — резолвинг brand_hint в канонический brand_key через
 * таблицу article_topics_brand_aliases (миграция 052).
 *
 * Зачем: один и тот же бренд приходит разными словоформами/написаниями
 * («Бренд Х», «brand-x», «BrandX Pro»). Без alias-резолва каждая
 * словоформа становится отдельным brand_key и история не склеивается.
 *
 * Алгоритм resolveBrandKey(db, { userId, rawBrand }):
 *   1) normalizeBrandKey(rawBrand) → baseKey;
 *   2) SELECT brand_key_canonical FROM aliases WHERE user_id=$1 AND brand_alias_key=$2;
 *   3) если найден — возвращаем canonical; иначе возвращаем baseKey.
 *
 * Если db недоступен / упал — возвращаем baseKey (graceful, не блокируем
 * генерацию). Все операции идемпотентны.
 *
 * recordAlias(db, { userId, canonical, alias, source, confidence }):
 *   INSERT ... ON CONFLICT (user_id, brand_alias_key) DO NOTHING.
 *
 * autoLinkSimilar(db, { userId, candidateKey, threshold = 0.85 }):
 *   эвристика — если в текущей истории пользователя уже есть brand_key,
 *   который очень близок к candidateKey по char-bigram cosine, мы
 *   автоматически регистрируем alias: candidate → existing canonical.
 *   Используется как «дешёвый» автоконсолидатор без LLM.
 */

const { normalizeBrandKey } = require('./brandKey');

function _charBigrams(s) {
  const out = new Map();
  const str = String(s || '');
  if (str.length < 2) {
    if (str) out.set(str, 1);
    return out;
  }
  for (let i = 0; i < str.length - 1; i += 1) {
    const bg = str.slice(i, i + 2);
    out.set(bg, (out.get(bg) || 0) + 1);
  }
  return out;
}

function _cosineBigrams(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [, v] of b) nb += v * v;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w) dot += v * w;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

async function resolveBrandKey(db, { userId, rawBrand } = {}) {
  const base = normalizeBrandKey(rawBrand);
  if (!base || !userId || !db) return base;
  try {
    const r = await db.query(
      `SELECT brand_key_canonical
         FROM article_topics_brand_aliases
        WHERE user_id = $1 AND brand_alias_key = $2
        LIMIT 1`,
      [userId, base],
    );
    if (r && r.rows && r.rows.length && r.rows[0].brand_key_canonical) {
      return String(r.rows[0].brand_key_canonical);
    }
  } catch (e) {
    console.warn('[brandAliases] resolve failed:', e.message);
  }
  return base;
}

async function recordAlias(db, { userId, canonical, alias, source = 'manual', confidence = null } = {}) {
  if (!db || !userId || !canonical || !alias) {
    return { ok: false, reason: 'no_input' };
  }
  const canonicalKey = normalizeBrandKey(canonical);
  const aliasKey = normalizeBrandKey(alias);
  if (!canonicalKey || !aliasKey || canonicalKey === aliasKey) {
    return { ok: false, reason: 'noop' };
  }
  try {
    const conf = confidence == null ? null : Math.max(0, Math.min(1, Number(confidence) || 0));
    const r = await db.query(
      `INSERT INTO article_topics_brand_aliases
         (user_id, brand_key_canonical, brand_alias_key, source, confidence)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, brand_alias_key) DO NOTHING
       RETURNING id`,
      [userId, canonicalKey, aliasKey, String(source).slice(0, 32), conf],
    );
    return { ok: true, inserted: r.rowCount > 0 };
  } catch (e) {
    console.warn('[brandAliases] recordAlias failed:', e.message);
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

async function listAliases(db, { userId, canonical } = {}) {
  if (!db || !userId) return [];
  try {
    const r = canonical
      ? await db.query(
          `SELECT brand_alias_key, source, confidence, created_at
             FROM article_topics_brand_aliases
            WHERE user_id = $1 AND brand_key_canonical = $2
            ORDER BY created_at DESC LIMIT 500`,
          [userId, normalizeBrandKey(canonical)],
        )
      : await db.query(
          `SELECT brand_key_canonical, brand_alias_key, source, confidence, created_at
             FROM article_topics_brand_aliases
            WHERE user_id = $1
            ORDER BY created_at DESC LIMIT 1000`,
          [userId],
        );
    return r.rows;
  } catch (e) {
    console.warn('[brandAliases] list failed:', e.message);
    return [];
  }
}

/**
 * autoLinkSimilar: если в brand_history пользователя уже есть brand_key,
 * близкий к candidateKey (char-bigram cosine ≥ threshold), автоматически
 * регистрируем alias и возвращаем canonical. Если нет — возвращаем
 * исходный candidateKey без записи.
 *
 * Используется в pipeline при первом столкновении с новым brand_hint.
 */
async function autoLinkSimilar(db, { userId, candidateKey, threshold = 0.85 } = {}) {
  if (!db || !userId || !candidateKey) return { canonical: candidateKey, linked: false };
  let rows = [];
  try {
    const r = await db.query(
      `SELECT DISTINCT brand_key
         FROM article_topics_brand_history
        WHERE user_id = $1
        ORDER BY brand_key
        LIMIT 500`,
      [userId],
    );
    rows = r.rows || [];
  } catch (e) {
    console.warn('[brandAliases] autoLink history scan failed:', e.message);
    return { canonical: candidateKey, linked: false };
  }
  if (!rows.length) return { canonical: candidateKey, linked: false };
  const candBg = _charBigrams(candidateKey);
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const key = String(row.brand_key || '');
    if (!key || key === candidateKey) continue;
    const score = _cosineBigrams(candBg, _charBigrams(key));
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  if (best && bestScore >= threshold) {
    await recordAlias(db, {
      userId,
      canonical: best,
      alias: candidateKey,
      source: 'heuristic',
      confidence: Number(bestScore.toFixed(3)),
    });
    return { canonical: best, linked: true, similarity: Number(bestScore.toFixed(3)) };
  }
  return { canonical: candidateKey, linked: false, similarity: Number(bestScore.toFixed(3)) };
}

module.exports = {
  resolveBrandKey,
  recordAlias,
  listAliases,
  autoLinkSimilar,
  _charBigrams,
  _cosineBigrams,
};
