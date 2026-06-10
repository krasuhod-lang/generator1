'use strict';

/**
 * aegis/experimentLoop (B4) — активное обучение мозга через само-эксперименты.
 *
 * Поток:
 *   1) pickCandidates(db) — раз в сутки выбирает страницы, по которым
 *      Bio-Brain менее всего уверен в предсказании (entropy-sampling).
 *      Источники сигнала:
 *        • aegis_seo_actions.priority — что мозг уже хочет улучшить;
 *        • aegis_seo_observations.position — «striking distance» (11–30);
 *        • biobrainClient.predict({ features }).confidence — если py поднят.
 *      Не повторяет URL'ы, по которым уже есть открытый эксперимент.
 *
 *   2) planExperiment(db, candidate) — записывает в `aegis_experiments`
 *      запись со статусом 'planned': baseline-метрики, top-N гипотез
 *      из action_plan, сам uncertainty score.
 *
 *   3) dispatchExperiment(db, exp) — (опц.) создаёт GitHub-issue в backlog
 *      через githubBot и переводит в 'dispatched'. Если backlog выключен,
 *      просто помечает запись как 'dispatched' без issue — это валидно:
 *      пользователь увидит карточку и сам обновит страницу.
 *
 *   4) measureExperiment(db, exp) — через measureAfterDays считает
 *      delta_position / delta_clicks и пушит reward в biobrain.feedback.
 *      Outcome: won (delta_position < -0.5 && reward > 0.5),
 *               lost (delta_position > +0.5 || reward < 0.2),
 *               inconclusive в остальных случаях.
 *
 * Конфиг — в featureFlags.experiments. ENV не вводим.
 */

const { getAegisFlags } = require('./featureFlags');
const biobrainClient   = require('./biobrainClient');
const serpOutcomeTracker = require('./serpOutcomeTracker');

let _db = null;
function setDbConnection(db) { _db = db; }

// ── pure helpers ──────────────────────────────────────────────────────

/**
 * Бинарная энтропия Шеннона для p ∈ [0,1].
 * Используем как сигнал «насколько мозг сомневается»: чем ближе p к 0.5,
 * тем выше entropy (max 1.0 при p=0.5; 0 при p=0 или p=1).
 */
function binaryEntropy(p) {
  const x = Math.max(0, Math.min(1, Number(p)));
  if (x === 0 || x === 1) return 0;
  const e = -(x * Math.log2(x) + (1 - x) * Math.log2(1 - x));
  return Number(e.toFixed(4));
}

/**
 * Уверенность 0..1 → сигнал uncertainty 0..1 (1 — максимально неуверен).
 * Если confidence не определён, возвращаем 0.5 (нейтральная точка для
 * сэмплинга — позиция в SERP внесёт основной вклад).
 */
function uncertaintyFromConfidence(confidence) {
  if (confidence === null || confidence === undefined) return 0.5;
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 0.5;
  return Math.max(0, Math.min(1, 1 - c));
}

/**
 * «Striking-distance» score: страницы с позицией 11–30 имеют наибольшую
 * вероятность быстрого роста при точечной правке — мозг должен учиться
 * именно на них. position=1 / position=100 → 0; пик в [11..20].
 */
function strikingDistanceScore(position) {
  const p = Number(position);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p < 5) return 0.1;
  if (p <= 10) return 0.3;
  if (p <= 20) return 1.0;
  if (p <= 30) return 0.8;
  if (p <= 50) return 0.4;
  return 0.1;
}

/**
 * Композитный uncertainty score для ранжирования кандидатов.
 * Вход: { confidence, position, priority }. Выход: 0..1 (выше → лучше
 * кандидат для эксперимента).
 */
function composeUncertainty({ confidence = null, position = null, priority = 0 } = {}) {
  const cfg = (getAegisFlags().experiments || {}).uncertaintyWeights || {
    biobrain: 0.5, striking: 0.3, priority: 0.2,
  };
  const w = cfg;
  const sum = (w.biobrain || 0) + (w.striking || 0) + (w.priority || 0);
  if (sum <= 0) return 0;
  const u =
    (w.biobrain  || 0) * uncertaintyFromConfidence(confidence) +
    (w.striking  || 0) * strikingDistanceScore(position) +
    (w.priority  || 0) * Math.max(0, Math.min(1, Number(priority) / 10));
  return Number((u / sum).toFixed(4));
}

/**
 * Reward по дельтам. Положительная Δclicks и убывание позиции (delta<0
 * означает «двинулись ближе к ТОП-1») — увеличивают reward. Шкала 0..1.
 *
 * Используем серверный serpOutcomeTracker.computeReward с post_position
 * (avgPosition) и delta_clicks. Дополнительно домножаем на «Δposition
 * bonus» — чтобы движение из p=20 в p=8 давало явно больше, чем
 * p=4 → p=3 при том же абсолютном numerical delta.
 */
function computeExperimentReward({ baselinePosition, postPosition, deltaClicks } = {}) {
  const post = Number(postPosition);
  const base = Number(baselinePosition);
  // Базовый reward — функция позиции после.
  const basePart = serpOutcomeTracker.computeReward({
    avgPosition: Number.isFinite(post) ? post : 50,
    inTop3:  Number.isFinite(post) && post <= 3  ? 1 : 0,
    inTop10: Number.isFinite(post) && post <= 10 ? 1 : 0,
    deltaClicks,
  });
  // Бонус за движение к топу: log-нормализованная Δposition.
  let bonus = 0;
  if (Number.isFinite(base) && Number.isFinite(post)) {
    const delta = base - post; // >0 если поднялись
    if (delta > 0) bonus = Math.min(0.2, Math.log10(1 + delta) * 0.15);
    if (delta < 0) bonus = Math.max(-0.2, -Math.log10(1 + Math.abs(delta)) * 0.1);
  }
  const r = Math.max(0, Math.min(1, basePart + bonus));
  return Number(r.toFixed(4));
}

/**
 * Выбор outcome из reward + Δposition. Чистая функция.
 */
function classifyOutcome({ reward, deltaPosition } = {}) {
  const r = Number(reward);
  const d = Number(deltaPosition);
  if (Number.isFinite(d) && d <= -0.5 && r >= 0.5) return 'won';
  if ((Number.isFinite(d) && d >= 0.5) || (Number.isFinite(r) && r < 0.2)) return 'lost';
  return 'inconclusive';
}

// ── DB helpers (не выбрасывают; возвращают [] на ошибке) ─────────────

async function _loadCandidates(db, limit, lookbackDays) {
  // Берём топ-priority действия из aegis_seo_actions со статусом
  // 'recommended' и подмешиваем последнюю наблюдаемую позицию из
  // aegis_seo_observations. Исключаем URL'ы с открытым экспериментом.
  const sql = `
    WITH ranked AS (
      SELECT a.site_key,
             a.target_url,
             MAX(a.priority)            AS max_priority,
             MAX(a.action_type)         AS action_type,
             jsonb_agg(a.payload ORDER BY a.priority DESC) AS actions
        FROM aegis_seo_actions a
       WHERE a.status = 'recommended'
         AND a.target_url IS NOT NULL
       GROUP BY a.site_key, a.target_url
    ),
    obs AS (
      SELECT url,
             AVG(position)    AS position,
             SUM(clicks)      AS clicks,
             SUM(impressions) AS impressions
        FROM aegis_seo_observations
       WHERE observed_at > NOW() - ($1::int || ' days')::interval
       GROUP BY url
    )
    SELECT r.site_key, r.target_url, r.max_priority, r.action_type, r.actions,
           o.position, o.clicks, o.impressions
      FROM ranked r
      LEFT JOIN obs o ON o.url = r.target_url
     WHERE NOT EXISTS (
       SELECT 1 FROM aegis_experiments e
        WHERE e.site_key = r.site_key
          AND e.target_url = r.target_url
          AND e.status IN ('planned', 'dispatched')
     )
     ORDER BY r.max_priority DESC NULLS LAST
     LIMIT $2`;
  try {
    const r = await db.query(sql, [Math.max(1, lookbackDays || 30), Math.max(1, limit || 5)]);
    return r.rows || [];
  } catch (e) {
    console.warn('[aegis/experimentLoop] _loadCandidates:', e.message);
    return [];
  }
}

/**
 * Пытается получить confidence для страницы из biobrain.predict.
 * Возвращает {confidence|null, score|null}. Никогда не throw.
 */
async function _probeBiobrain(features) {
  try {
    if (!Array.isArray(features) || !features.length) return { confidence: null, score: null };
    const r = await biobrainClient.predict({ features });
    if (!r || !r.ok || !r.body) return { confidence: null, score: null };
    return {
      confidence: typeof r.body.confidence === 'number' ? r.body.confidence : null,
      score:      typeof r.body.score      === 'number' ? r.body.score      : null,
    };
  } catch (e) {
    return { confidence: null, score: null };
  }
}

// ── core operations ───────────────────────────────────────────────────

async function planExperiment(db, candidate, opts = {}) {
  const flags = getAegisFlags().experiments || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled' };
  const topN = Math.max(1, Math.min(10, Number(flags.hypothesisTopN) || 3));
  const actions = Array.isArray(candidate.actions) ? candidate.actions.slice(0, topN) : [];
  const features = Array.isArray(opts.baselineFeatures) ? opts.baselineFeatures : [];
  const featureLabels = Array.isArray(opts.baselineFeatureLabels) ? opts.baselineFeatureLabels : [];
  const uncertainty = typeof opts.uncertainty === 'number' ? opts.uncertainty : 0;

  try {
    const r = await db.query(
      `INSERT INTO aegis_experiments
          (site_key, target_url, queries, uncertainty, hypothesis,
           baseline_features, baseline_feature_labels,
           baseline_position, baseline_clicks, baseline_impressions, status)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::real[], $7, $8, $9, $10, 'planned')
        ON CONFLICT (site_key, target_url) WHERE status IN ('planned','dispatched')
          DO NOTHING
        RETURNING id`,
      [candidate.site_key, candidate.target_url,
       Array.isArray(candidate.queries) ? candidate.queries : [],
       Number(uncertainty.toFixed ? uncertainty.toFixed(4) : uncertainty),
       JSON.stringify(actions),
       features.map(Number), featureLabels,
       _num(candidate.position), _num(candidate.clicks), _num(candidate.impressions)]
    );
    return { ok: true, id: r.rows && r.rows[0] && r.rows[0].id };
  } catch (e) {
    console.warn('[aegis/experimentLoop] planExperiment:', e.message);
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

/**
 * Помечает запись как 'dispatched'. Если backlog включён и передан
 * githubBot — создаёт issue с описанием гипотезы. Иначе просто переводит
 * статус (валидно: пользователь увидит запись в UI и обновит страницу
 * вручную).
 */
async function dispatchExperiment(db, id, { githubBot = null } = {}) {
  const flags = getAegisFlags().experiments || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled' };
  try {
    const r = await db.query(
      `SELECT id, site_key, target_url, queries, hypothesis, status
         FROM aegis_experiments WHERE id = $1`, [id]);
    const row = r.rows && r.rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'planned') return { ok: false, reason: 'wrong_status', status: row.status };

    let issueNumber = null;
    if (flags.dispatchToBacklog && githubBot && typeof githubBot.createIssue === 'function') {
      try {
        const title = `[Эгида/B4] Эксперимент: ${row.target_url}`;
        const body = _renderHypothesisBody(row);
        const created = await githubBot.createIssue({ title, body, labels: ['aegis:ready', 'aegis:experiment'] });
        if (created && created.ok && created.number) issueNumber = Number(created.number);
      } catch (e) {
        console.warn('[aegis/experimentLoop] dispatch backlog:', e.message);
      }
    }

    await db.query(
      `UPDATE aegis_experiments
          SET status='dispatched', dispatched_at=NOW(), backlog_issue_number=$2
        WHERE id=$1`,
      [id, issueNumber]);
    return { ok: true, id, backlog_issue_number: issueNumber };
  } catch (e) {
    console.warn('[aegis/experimentLoop] dispatchExperiment:', e.message);
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

function _renderHypothesisBody(row) {
  const lines = [];
  lines.push(`URL: ${row.target_url}`);
  if (Array.isArray(row.queries) && row.queries.length) {
    lines.push(`Запросы: ${row.queries.slice(0, 10).join(', ')}`);
  }
  lines.push('', '## Гипотеза мозга (top-N)');
  const arr = Array.isArray(row.hypothesis) ? row.hypothesis : [];
  if (!arr.length) {
    lines.push('_(нет рекомендаций — низкоприоритетный эксперимент)_');
  } else {
    for (const h of arr) {
      const t = (h && h.action_type) ? h.action_type : 'unknown';
      lines.push(`- **${t}**${h && h.cluster ? ` · cluster=${h.cluster}` : ''}`);
    }
  }
  lines.push('', 'Через ' + (Number((getAegisFlags().experiments || {}).measureAfterDays) || 14) +
    ' дней Эгида сама замерит изменение позиции и обновит карточку «🧪 Эксперименты».');
  return lines.join('\n');
}

/**
 * Считает дельты по уже сохранённым post-метрикам и пишет reward в
 * biobrain.feedback. Сами post-метрики передаются снаружи (из GSC pipeline)
 * — этот модуль остаётся транспортно-независимым (как serpOutcomeTracker).
 */
async function closeExperiment(db, id, postMetrics = {}) {
  const flags = getAegisFlags().experiments || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled' };
  try {
    const r0 = await db.query(
      `SELECT id, baseline_position, baseline_clicks, baseline_features,
              baseline_feature_labels, status
         FROM aegis_experiments WHERE id=$1`, [id]);
    const row = r0.rows && r0.rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'measured') return { ok: false, reason: 'already_measured' };

    const post = {
      position:    _num(postMetrics.avgPosition),
      clicks:      _num(postMetrics.clicks),
      impressions: _num(postMetrics.impressions),
    };
    const deltaPosition = (Number.isFinite(post.position) && Number.isFinite(Number(row.baseline_position)))
      ? Number((post.position - Number(row.baseline_position)).toFixed(3)) : null;
    const deltaClicks = (Number.isFinite(post.clicks) && Number.isFinite(Number(row.baseline_clicks)))
      ? Number((post.clicks - Number(row.baseline_clicks)).toFixed(2)) : null;

    const reward = computeExperimentReward({
      baselinePosition: row.baseline_position,
      postPosition:     post.position,
      deltaClicks,
    });
    const outcome = classifyOutcome({ reward, deltaPosition });

    const r = await db.query(
      `UPDATE aegis_experiments
          SET post_position    = $2,
              post_clicks      = $3,
              post_impressions = $4,
              delta_position   = $5,
              delta_clicks     = $6,
              reward           = $7,
              outcome          = $8,
              status           = 'measured',
              measured_at      = NOW(),
              post_features    = COALESCE($9::real[], post_features)
        WHERE id=$1
        RETURNING id`,
      [id, post.position, post.clicks, post.impressions,
       deltaPosition, deltaClicks, reward, outcome,
       Array.isArray(postMetrics.features) ? postMetrics.features.map(Number) : null]);

    // Замыкание петли — отправляем reward в biobrain.feedback по
    // baseline-вектору. Если py недоступен — graceful, status='measured'
    // остаётся, повтор позже.
    let fed = false;
    try {
      const features = Array.isArray(row.baseline_features) ? row.baseline_features.map(Number) : null;
      if (features && features.length) {
        const fb = await biobrainClient.feedback({
          features,
          real_spq_overall: reward * 100,
        });
        fed = Boolean(fb && fb.ok);
      }
    } catch (e) {
      console.warn('[aegis/experimentLoop] biobrain feedback:', e.message);
    }

    return {
      ok: true, id, reward, outcome,
      delta_position: deltaPosition, delta_clicks: deltaClicks, fed,
    };
  } catch (e) {
    console.warn('[aegis/experimentLoop] closeExperiment:', e.message);
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

// ── one tick of the scheduler ─────────────────────────────────────────

/**
 * Помечает зависшие planned/dispatched-эксперименты как 'measured' с
 * outcome='inconclusive', чтобы partial-уникальный индекс
 * uq_aegis_experiments_open освободил (site_key, target_url) и мозг
 * мог выбрать тот же URL снова. Триггер — возраст > measureAfterDays
 * + staleGraceDays.
 *
 * Возвращает { ok, closed }. Никогда не throw.
 */
async function closeStaleExperiments(db = _db) {
  const flags = getAegisFlags().experiments || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled', closed: 0 };
  if (!db) return { ok: false, reason: 'db_not_wired', closed: 0 };
  const measureAfter = Math.max(1, Number(flags.measureAfterDays) || 14);
  const grace        = Math.max(0, Number(flags.staleGraceDays)   || 7);
  const ttlDays      = measureAfter + grace;
  try {
    // Используем COALESCE(dispatched_at, planned_at): для planned-записей
    // отсчитываем от planned_at; для dispatched — от dispatched_at.
    const r = await db.query(
      `UPDATE aegis_experiments
          SET status      = 'measured',
              outcome     = 'inconclusive',
              measured_at = NOW(),
              notes       = COALESCE(notes, '') ||
                            CASE WHEN COALESCE(notes,'')='' THEN '' ELSE E'\n' END ||
                            'auto-closed by closeStaleExperiments after '
                            || $1::int || ' days without measurement'
        WHERE status IN ('planned', 'dispatched')
          AND COALESCE(dispatched_at, planned_at) < NOW() - ($1::int || ' days')::interval
        RETURNING id`,
      [ttlDays]);
    const closed = (r.rows || []).length;
    if (closed > 0) {
      console.log(`[aegis/experimentLoop] closeStaleExperiments: closed ${closed} stale rows (>${ttlDays}d)`);
    }
    return { ok: true, closed };
  } catch (e) {
    console.warn('[aegis/experimentLoop] closeStaleExperiments:', e.message);
    return { ok: false, reason: 'db_error', error: e.message, closed: 0 };
  }
}

/** Сколько незавершённых экспериментов сейчас (для UX-сообщения). */
async function _countInProgress(db) {
  try {
    const r = await db.query(
      `SELECT
         SUM(CASE WHEN status='planned'    THEN 1 ELSE 0 END)::int AS planned,
         SUM(CASE WHEN status='dispatched' THEN 1 ELSE 0 END)::int AS dispatched
       FROM aegis_experiments
       WHERE status IN ('planned','dispatched')`);
    const row = r.rows && r.rows[0] || {};
    return {
      planned:    Number(row.planned)    || 0,
      dispatched: Number(row.dispatched) || 0,
    };
  } catch (_) {
    return { planned: 0, dispatched: 0 };
  }
}

async function runOnce(db = _db) {
  const flags = getAegisFlags().experiments || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled' };
  if (!db) return { ok: false, reason: 'db_not_wired' };

  const stats = { picked: 0, planned: 0, dispatched: 0, stale_closed: 0,
                  in_progress: { planned: 0, dispatched: 0 } };

  // 0) Прежде чем брать новых кандидатов, освобождаем URL'ы с зависшими
  //    экспериментами (старше measureAfterDays + staleGraceDays).
  const sweep = await closeStaleExperiments(db);
  stats.stale_closed = (sweep && sweep.closed) || 0;

  const lookback = Number(flags.candidateLookbackDays) || 30;
  const limit = Math.max(1, Math.min(50, Number(flags.maxNewPerTick) || 3));
  const candidates = await _loadCandidates(db, limit, lookback);
  stats.picked = candidates.length;

  // Подмешиваем biobrain confidence (если py доступен) и считаем композитный
  // uncertainty score для ранжирования; на planExperiment передаём top-K.
  const ranked = [];
  for (const c of candidates) {
    const probe = await _probeBiobrain([]); // фич пока нет — confidence=null
    const u = composeUncertainty({
      confidence: probe.confidence,
      position:   c.position,
      priority:   c.max_priority || 0,
    });
    ranked.push({ ...c, uncertainty: u });
  }
  ranked.sort((a, b) => b.uncertainty - a.uncertainty);

  for (const c of ranked) {
    const planRes = await planExperiment(db, c, { uncertainty: c.uncertainty });
    if (planRes.ok && planRes.id) {
      stats.planned += 1;
      if (flags.autoDispatch) {
        const d = await dispatchExperiment(db, planRes.id);
        if (d.ok) stats.dispatched += 1;
      }
    }
  }

  // Сообщение для UI: даже если picked=0, пользователь должен видеть,
  // сколько экспериментов сейчас в работе — иначе выглядит как «кнопка
  // не работает», хотя дедупликация по uq_aegis_experiments_open
  // отрабатывает корректно.
  stats.in_progress = await _countInProgress(db);
  return { ok: true, ...stats };
}

// ── scheduler wrapper ────────────────────────────────────────────────

let _timer = null;
let _sweepTimer = null;

function startExperimentLoop() {
  if (_timer) return;
  const flags = getAegisFlags().experiments || {};
  if (!flags.enabled) return;
  const intervalSec = Number(flags.intervalSec) || 86400; // раз в сутки
  // Первый прогон — отложенно, после bootstrap'а основных подсистем.
  setTimeout(() => runOnce().catch((e) => console.warn('[aegis/experimentLoop] first run:', e.message)), 60_000).unref?.();
  _timer = setInterval(() => {
    runOnce().catch((e) => console.warn('[aegis/experimentLoop] tick:', e.message));
  }, intervalSec * 1000);
  _timer.unref?.();
  // Дополнительный частый sweep stale-экспериментов раз в час: даже если
  // основной runOnce-тик раз в сутки, освобождение URL по TTL должно
  // идти быстрее, чтобы автопилот не простаивал.
  const sweepSec = 3600;
  _sweepTimer = setInterval(() => {
    closeStaleExperiments().catch((e) => console.warn('[aegis/experimentLoop] sweep:', e.message));
  }, sweepSec * 1000);
  _sweepTimer.unref?.();
}

function stopExperimentLoop() {
  if (_timer) clearInterval(_timer);
  if (_sweepTimer) clearInterval(_sweepTimer);
  _timer = null;
  _sweepTimer = null;
}

// ── list/get для UI/admin ─────────────────────────────────────────────

async function listExperiments(db, { status = null, limit = 50, offset = 0 } = {}) {
  if (!db) return { ok: false, reason: 'db_not_wired' };
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE status = $${params.length}`; }
  params.push(Math.min(500, Math.max(1, Number(limit) || 50)));
  params.push(Math.max(0, Number(offset) || 0));
  try {
    const r = await db.query(
      `SELECT id, site_key, target_url, queries, uncertainty, hypothesis,
              baseline_position, baseline_clicks,
              post_position, post_clicks, delta_position, delta_clicks,
              reward, outcome, status,
              planned_at, dispatched_at, measured_at,
              backlog_issue_number
         FROM aegis_experiments
         ${where}
         ORDER BY planned_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    return { ok: true, items: r.rows };
  } catch (e) {
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

function _num(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

module.exports = {
  // pure (testable):
  binaryEntropy,
  uncertaintyFromConfidence,
  strikingDistanceScore,
  composeUncertainty,
  computeExperimentReward,
  classifyOutcome,
  // core ops:
  setDbConnection,
  planExperiment,
  dispatchExperiment,
  closeExperiment,
  closeStaleExperiments,
  runOnce,
  // scheduler + admin:
  startExperimentLoop,
  stopExperimentLoop,
  listExperiments,
};
