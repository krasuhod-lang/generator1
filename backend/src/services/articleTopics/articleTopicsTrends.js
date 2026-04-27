'use strict';

/**
 * Article Topics — trends extraction & registry.
 *
 * Парсер TRENDS_JSON-сентинельного блока (см. формат в
 * `backend/src/prompts/articleTopics/main.txt`):
 *
 *     <!-- TRENDS_JSON_START -->
 *     ```json
 *     { "trends": [ ... ], "signals_count": N, "ru_cis_block_present": bool }
 *     ```
 *     <!-- TRENDS_JSON_END -->
 *
 * И помощники для:
 *   • persistExtractedTrends — UPSERT-style вставка в article_topic_trends
 *     (миграция 016) с нормализацией имени для дедупа.
 *   • findDuplicateTrends     — поиск ранее исследованных трендов того же
 *     пользователя по нормализованному имени; используется при создании
 *     deep-dive чтобы предупредить «вы уже копали этот тренд».
 *   • loadSiblingDeepDives    — короткий снимок sibling-deep-dive для
 *     инъекции в промпт ({{SIBLING_DEEP_DIVES}} в deepDive.txt), чтобы
 *     модель не дублировала pillar/cluster страницы.
 *
 * Все функции толерантны к ошибкам — на проблемы парсинга/БД пишут warn
 * и возвращают пустые значения, никогда не пробрасывают throw в pipeline
 * (foresight-отчёт уже сгенерирован, нельзя его «терять» из-за побочных
 * фич).
 */

const db = require('../../config/db');

// ──────────────────────────────────────────────────────────────────────
// Парсинг TRENDS_JSON
// ──────────────────────────────────────────────────────────────────────

const SENTINEL_RE = /<!--\s*TRENDS_JSON_START\s*-->([\s\S]*?)<!--\s*TRENDS_JSON_END\s*-->/i;

/**
 * Извлекает структурированный объект `{ trends, signals_count,
 * ru_cis_block_present }` из markdown-отчёта main-задачи.
 *
 * Возвращает null, если блока нет / он невалидный JSON / структура битая.
 * Парсер устойчив к:
 *   - регистру в комментариях-маркерах,
 *   - наличию или отсутствию ```json``` обёртки внутри,
 *   - trailing-запятым внутри JSON (НЕ исправляем — это нарушение контракта,
 *     возвращаем null и пусть UI fallback на табличный парсер).
 *
 * НЕ выбрасывает — на любой сбой возвращает null.
 */
function extractTrendsJsonBlock(markdown) {
  const text = String(markdown || '');
  if (!text) return null;
  const m = SENTINEL_RE.exec(text);
  if (!m) return null;

  let raw = m[1].trim();
  // Снимаем ```json ... ``` или ``` ... ``` обёртки.
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.trends)) {
    return null;
  }

  // Нормализуем поля каждого тренда: гарантируем строки/массивы и режем
  // потенциально длинные значения, чтобы они не раздували БД.
  const STAGE_OK = new Set(['early', 'emerging', 'growing']);
  const CONF_OK  = new Set(['low', 'medium', 'high']);
  const COV_OK   = new Set(['none', 'partial', 'covered']);

  const trends = parsed.trends.map((t) => {
    const obj = (t && typeof t === 'object') ? t : {};
    const name = String(obj.name || '').trim().slice(0, 200);
    const stageRaw = String(obj.stage || '').toLowerCase().trim();
    const confRaw  = String(obj.confidence || '').toLowerCase().trim();
    const covRaw   = String(obj.competitor_coverage || '').toLowerCase().trim();
    const drivers  = Array.isArray(obj.drivers)
      ? obj.drivers.map((d) => String(d || '').trim().slice(0, 120)).filter(Boolean).slice(0, 6)
      : [];
    const signals  = Array.isArray(obj.signal_ids)
      ? obj.signal_ids.map((n) => Number(n)).filter((n) => Number.isFinite(n)).slice(0, 12)
      : [];
    const win = Number(obj.window_months);
    return {
      name,
      stage:               STAGE_OK.has(stageRaw) ? stageRaw : null,
      confidence:          CONF_OK.has(confRaw)   ? confRaw  : null,
      drivers,
      signal_ids:          signals,
      vector:              String(obj.vector || '').trim().slice(0, 200),
      competitor_coverage: COV_OK.has(covRaw) ? covRaw : null,
      window_months:       Number.isFinite(win) ? Math.max(0, Math.min(120, Math.round(win))) : 0,
    };
  }).filter((t) => t.name);

  return {
    trends,
    signals_count:        Number.isFinite(Number(parsed.signals_count)) ? Number(parsed.signals_count) : null,
    ru_cis_block_present: typeof parsed.ru_cis_block_present === 'boolean'
      ? parsed.ru_cis_block_present
      : null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Нормализация имени тренда для дедупа
// ──────────────────────────────────────────────────────────────────────

/**
 * Нормализованная форма имени тренда — lowercased, без знаков препинания,
 * без двойных пробелов, без markdown-обёрток. Достаточно агрессивная,
 * чтобы «AI-агенты для SEO» и «AI агенты для SEO!» считались дубликатами,
 * но НЕ пытаемся стеммить — этим занимался бы russianStem, но для дедупа
 * на уровне «вы уже копали этот тренд» точная форма достаточна.
 */
function normalizeTrendName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[*_`«»"']+/g, '')                   // markdown/quote обёртки
    .replace(/[\u2010-\u2015\-—–]/g, ' ')         // тире/дефисы → пробел
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')           // прочая пунктуация
    .replace(/\s+/g, ' ')
    .trim();
}

// ──────────────────────────────────────────────────────────────────────
// Persistence в article_topic_trends
// ──────────────────────────────────────────────────────────────────────

/**
 * Сохраняет распарсенные тренды в article_topic_trends. Идемпотентность
 * на уровне (task_id, normalized_name) — повторный запуск не плодит
 * дубликаты в одной задаче.
 *
 * Возвращает количество вставленных строк (0 при ошибке/пустом списке).
 */
async function persistExtractedTrends({ taskId, userId, niche, trends }) {
  if (!taskId || !userId || !Array.isArray(trends) || !trends.length) return 0;

  // Удаляем старые записи этой задачи (на случай retry / повторного прогона).
  // ON CONFLICT не поможет — у нас нет UNIQUE-индекса (он был бы вреден
  // для cross-task дедупа), поэтому идём через прямой DELETE+INSERT в одной
  // транзакции.
  const client = await db.pool.connect().catch(() => null);
  if (!client) {
    // Fallback на пул-уровневый запрос, если transactional API недоступен.
    return _persistFallback({ taskId, userId, niche, trends });
  }
  let inserted = 0;
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM article_topic_trends WHERE task_id = $1`, [taskId]);
    for (const t of trends) {
      const normalized = normalizeTrendName(t.name);
      if (!normalized) continue;
      await client.query(
        `INSERT INTO article_topic_trends
            (user_id, task_id, name, normalized_name, niche,
             stage, confidence, drivers, signal_ids, vector,
             competitor_coverage, window_months)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)`,
        [
          userId, taskId, t.name, normalized, niche || '',
          t.stage, t.confidence,
          JSON.stringify(t.drivers || []),
          JSON.stringify(t.signal_ids || []),
          t.vector, t.competitor_coverage, t.window_months || 0,
        ],
      );
      inserted += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.warn(`[articleTopicsTrends] persist failed for task ${taskId}: ${err.message}`);
    return 0;
  } finally {
    client.release();
  }
  return inserted;
}

async function _persistFallback({ taskId, userId, niche, trends }) {
  let inserted = 0;
  try {
    await db.query(`DELETE FROM article_topic_trends WHERE task_id = $1`, [taskId]);
    for (const t of trends) {
      const normalized = normalizeTrendName(t.name);
      if (!normalized) continue;
      await db.query(
        `INSERT INTO article_topic_trends
            (user_id, task_id, name, normalized_name, niche,
             stage, confidence, drivers, signal_ids, vector,
             competitor_coverage, window_months)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)`,
        [
          userId, taskId, t.name, normalized, niche || '',
          t.stage, t.confidence,
          JSON.stringify(t.drivers || []),
          JSON.stringify(t.signal_ids || []),
          t.vector, t.competitor_coverage, t.window_months || 0,
        ],
      );
      inserted += 1;
    }
  } catch (err) {
    console.warn(`[articleTopicsTrends] persist (fallback) failed for task ${taskId}: ${err.message}`);
    return 0;
  }
  return inserted;
}

// ──────────────────────────────────────────────────────────────────────
// Поиск дубликатов
// ──────────────────────────────────────────────────────────────────────

/**
 * Ищет deep-dive задачи того же пользователя, у которых нормализованное
 * trend_name совпадает с переданным. Используется в контроллере перед
 * созданием deep-dive чтобы вернуть фронту warning «вы уже копали этот
 * тренд N дней назад».
 *
 * Возвращает массив до `limit` строк { id, trend_name, niche, created_at,
 * status }. На ошибку — пустой массив.
 */
async function findDuplicateDeepDives({ userId, trendName, limit = 3 }) {
  if (!userId || !trendName) return [];
  const normalized = normalizeTrendName(trendName);
  if (!normalized) return [];
  try {
    const { rows } = await db.query(
      `SELECT id, trend_name, niche, status, created_at
         FROM article_topic_tasks
        WHERE user_id = $1
          AND mode    = 'deep_dive'
          AND trend_name IS NOT NULL
          AND lower(regexp_replace(trim(trend_name), '\\s+', ' ', 'g')) = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, normalized, Math.max(1, Math.min(20, limit))],
    );
    // Финальная фильтрация на JS-стороне с полной нормализацией (regex в SQL
    // выше — мягкая аппроксимация; точное совпадение проверяем здесь).
    return rows.filter((r) => normalizeTrendName(r.trend_name) === normalized);
  } catch (err) {
    console.warn(`[articleTopicsTrends] findDuplicateDeepDives failed: ${err.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────
// Sibling deep-dives (для инъекции в промпт)
// ──────────────────────────────────────────────────────────────────────

/**
 * Возвращает компактный текстовый блок для подстановки в
 * {{SIBLING_DEEP_DIVES}} placeholder в deepDive.txt.
 *
 * Берёт все УСПЕШНО завершённые sibling-deep-dive задачи (тот же
 * parent_task_id, статус 'done', НЕ текущая задача) и строит выжимку:
 *   - название тренда
 *   - первые ~1500 символов их секции "## 1. Семантическое ядро будущего"
 *     (этого достаточно, чтобы модель поняла, какие запросы уже взяты)
 *
 * Лимит ~6 sibling-задач, общий cap ~10 KB чтобы не раздувать промпт.
 */
async function buildSiblingDeepDivesBlock({ parentTaskId, currentTaskId, maxSiblings = 6, capChars = 10000 }) {
  if (!parentTaskId) return '(нет — это первый deep-dive в данной серии)';

  let rows = [];
  try {
    // Если currentTaskId передан — исключаем его явно через `id <> $2`;
    // иначе строим SQL без этого фильтра, чтобы не зависеть от nil-UUID
    // как сторожевого значения (более явная и устойчивая логика).
    if (currentTaskId) {
      const r = await db.query(
        `SELECT id, trend_name, result_markdown
           FROM article_topic_tasks
          WHERE parent_task_id = $1
            AND id            <> $2
            AND mode           = 'deep_dive'
            AND status         = 'done'
            AND result_markdown IS NOT NULL
          ORDER BY completed_at DESC NULLS LAST
          LIMIT $3`,
        [parentTaskId, currentTaskId, maxSiblings],
      );
      rows = r.rows || [];
    } else {
      const r = await db.query(
        `SELECT id, trend_name, result_markdown
           FROM article_topic_tasks
          WHERE parent_task_id = $1
            AND mode           = 'deep_dive'
            AND status         = 'done'
            AND result_markdown IS NOT NULL
          ORDER BY completed_at DESC NULLS LAST
          LIMIT $2`,
        [parentTaskId, maxSiblings],
      );
      rows = r.rows || [];
    }
  } catch (err) {
    console.warn(`[articleTopicsTrends] buildSiblingDeepDivesBlock failed: ${err.message}`);
    return '(нет данных — продолжай без учёта sibling-задач)';
  }
  if (!rows.length) return '(нет — это первый deep-dive в данной серии)';

  const SEMCORE_RE = /^##\s*1[\.\)]\s*[^\n]*$/im;

  const blocks = [];
  let totalLen = 0;
  for (const r of rows) {
    const md = String(r.result_markdown || '');
    let semCore = '';
    const m = SEMCORE_RE.exec(md);
    if (m) {
      const start = m.index + m[0].length;
      // Берём содержимое до следующего ## заголовка ИЛИ 1500 символов.
      const tail = md.slice(start);
      const next = tail.search(/\n##\s+/);
      const slice = next > 0 ? tail.slice(0, next) : tail;
      semCore = slice.trim().slice(0, 1500);
    } else {
      semCore = md.slice(0, 800);
    }
    const block =
      `### Sibling: «${(r.trend_name || '—').slice(0, 120)}»\n` +
      `Семантическое ядро (выжимка):\n${semCore || '(нет)'}\n`;
    if (totalLen + block.length > capChars) break;
    blocks.push(block);
    totalLen += block.length;
  }
  return blocks.join('\n---\n\n').trim();
}

module.exports = {
  extractTrendsJsonBlock,
  normalizeTrendName,
  persistExtractedTrends,
  findDuplicateDeepDives,
  buildSiblingDeepDivesBlock,
};
