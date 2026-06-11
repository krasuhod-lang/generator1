'use strict';

/**
 * aegis/trainingHealth — единая диагностика готовности контура обучения
 * мозга A.E.G.I.S. (Phase 6 DSPy + Phase 7 GA4 RL/PPO).
 *
 * Зачем: до этого оператору приходилось вручную сверять ENV прод-инстанса,
 * GitHub-секреты, размер `aegis_dspy_dataset`, `aegis_brain_versions` и
 * baseline-yaml, чтобы понять, почему «мозг застрял в 1baseline». Этот
 * модуль собирает всю проверку в один JSON, доступный по
 * `GET /api/aegis/training/health`, и используется на старте сервера для
 * единого WARN-сообщения в логе.
 *
 * Графейс-деградирует: любые ошибки PostgreSQL/aegis_py не выбрасываются,
 * а попадают в отчёт как `reason`. Без новых deps.
 */

const fs   = require('fs');
const path = require('path');

const { getAegisFlags } = require('./featureFlags');
const { getBrainSummary } = require('./brainStateRegistry');
const dspy = require('./dspyClient');

const BASELINE_YAML_RELATIVE = path.join('brain_state', 'compiled_writer.yaml');
// Repo root = three levels up from this file: backend/src/services/aegis → repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function _envPresence(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0;
}

function _baselineYamlInfo() {
  try {
    const p = path.join(REPO_ROOT, BASELINE_YAML_RELATIVE);
    const st = fs.statSync(p);
    return {
      exists: true,
      size_bytes: st.size,
      mtime: st.mtime.toISOString(),
      // baseline-стаб ~600 байт; если размер не вырос — мозг ещё не обучен.
      looks_like_baseline_stub: st.size < 2048,
      path: BASELINE_YAML_RELATIVE,
    };
  } catch (_) {
    return { exists: false, size_bytes: 0, mtime: null, looks_like_baseline_stub: true, path: BASELINE_YAML_RELATIVE };
  }
}

async function _datasetStats(db) {
  if (!db || typeof db.query !== 'function') return { available: false, total_rows: 0, real_rows: 0 };
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE COALESCE(is_seed, FALSE) = FALSE)::int AS real_rows
         FROM aegis_dspy_dataset`,
    );
    const row = r.rows[0] || {};
    return {
      available: true,
      total_rows: Number(row.total) || 0,
      real_rows: Number(row.real_rows) || 0,
    };
  } catch (e) {
    return { available: false, total_rows: 0, real_rows: 0, error: e.message };
  }
}

async function _lastBrainVersion(db) {
  if (!db || typeof db.query !== 'function') return { available: false };
  try {
    const r = await db.query(
      `SELECT id, sha, deployed_at, improvement_pct, dataset_size
         FROM aegis_brain_versions
        WHERE rolled_back_at IS NULL
        ORDER BY deployed_at DESC LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row) return { available: true, exists: false };
    return {
      available: true,
      exists: true,
      id: row.id,
      sha: row.sha,
      deployed_at: row.deployed_at,
      improvement_pct: row.improvement_pct == null ? null : Number(row.improvement_pct),
      dataset_size: row.dataset_size == null ? null : Number(row.dataset_size),
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * buildDspySection(opts) — собирает раздел DSPy.
 *
 * @param {object} opts
 * @param {object} opts.db                 - pg pool (optional)
 * @param {object} opts.flags              - getAegisFlags() output
 * @param {Function} [opts.pyStatusFn]     - override dspy.status (for tests)
 * @param {Function} [opts.envHas]         - override _envPresence (for tests)
 * @param {object} [opts.autoTelemetry]    - dspyAutoRetrain telemetry snapshot
 * @param {object} [opts.brainSummary]     - getBrainSummary() output
 * @param {Function} [opts.baselineInfoFn] - override _baselineYamlInfo (for tests)
 */
async function buildDspySection(opts = {}) {
  const flags = opts.flags || getAegisFlags();
  const envHas = opts.envHas || _envPresence;
  const pyStatusFn = opts.pyStatusFn || dspy.status;
  const dspyCfg = flags.dspy || {};
  const baselineInfo = (opts.baselineInfoFn || _baselineYamlInfo)();

  const envChecks = [
    { name: 'AEGIS_DSPY_ENABLED',          set: envHas('AEGIS_DSPY_ENABLED'),          required: true,
      help: 'Главный гейт DSPy retrain. Без него autopilot и POST /aegis/dspy/retrain игнорируются.' },
    { name: 'AEGIS_PY_URL',                set: envHas('AEGIS_PY_URL'),                required: true,
      help: 'URL микросервиса aegis_py (FastAPI), который запускает MIPROv2. Без него все вызовы возвращают not_configured.' },
    { name: 'AEGIS_DSPY_MAX_TRIALS',       set: envHas('AEGIS_DSPY_MAX_TRIALS'),       required: false,
      help: 'Опционально: число trials MIPROv2 (по умолчанию 20).' },
    { name: 'AEGIS_DSPY_MAX_COST_USD',     set: envHas('AEGIS_DSPY_MAX_COST_USD'),     required: false,
      help: 'Опционально: бюджет в USD на один retrain (по умолчанию 50).' },
    { name: 'AEGIS_DSPY_MIN_IMPROVEMENT_PCT', set: envHas('AEGIS_DSPY_MIN_IMPROVEMENT_PCT'), required: false,
      help: 'Опционально: минимальный прирост Spq, чтобы новый yaml был задеплоен (по умолчанию 5%).' },
  ];

  // Pинг aegis_py делаем только если URL вообще выставлен — иначе шумим сетью зря.
  let pyReachable = null;
  let pyStatus = null;
  if (envHas('AEGIS_PY_URL')) {
    try {
      const r = await pyStatusFn();
      pyReachable = Boolean(r && r.ok);
      pyStatus = (r && r.body) || null;
    } catch (e) {
      pyReachable = false;
      pyStatus = { error: e.message };
    }
  }

  const [datasetStats, lastVersion] = await Promise.all([
    _datasetStats(opts.db),
    _lastBrainVersion(opts.db),
  ]);

  const brainSummary = opts.brainSummary || (typeof getBrainSummary === 'function' ? getBrainSummary() : null);

  const missingRequired = envChecks.filter((c) => c.required && !c.set).map((c) => c.name);

  // Validation / advice — что конкретно нужно сделать оператору.
  const issues = [];
  if (!dspyCfg.enabled) {
    issues.push({
      level: 'error',
      code: 'dspy_disabled',
      message: 'AEGIS_DSPY_ENABLED не выставлен в `true` — autopilot и POST /aegis/dspy/retrain игнорируются.',
      fix: 'На прод-backend выставить `AEGIS_DSPY_ENABLED=true` и рестартнуть сервис.',
    });
  }
  for (const name of missingRequired) {
    issues.push({
      level: 'error',
      code: `env_missing:${name}`,
      message: `Не выставлена обязательная переменная ${name}.`,
      fix: `Добавить ${name} в .env прод-инстанса.`,
    });
  }
  if (envHas('AEGIS_PY_URL') && pyReachable === false) {
    issues.push({
      level: 'error',
      code: 'py_unreachable',
      message: 'aegis_py (AEGIS_PY_URL) не отвечает на /dspy/status.',
      fix: 'Проверить, что FastAPI сервис aegis_py запущен и доступен из backend (network/firewall).',
    });
  }
  const minRows = Number(dspyCfg.autoRetrainMinRows) || 10;
  if (datasetStats.available && datasetStats.total_rows < minRows) {
    issues.push({
      level: 'warn',
      code: 'dataset_too_small',
      message: `В aegis_dspy_dataset ${datasetStats.total_rows} строк, нужно ≥ ${minRows} для первого retrain.`,
      fix: 'Дождаться накопления реальных генераций или включить cold-start seeds (`dspy.coldStartUseSeeds`).',
    });
  }
  if (baselineInfo.exists && baselineInfo.looks_like_baseline_stub
      && lastVersion.available && !lastVersion.exists) {
    issues.push({
      level: 'warn',
      code: 'brain_never_trained',
      message: `Мозг ещё ни разу не обучался: brain_state/${baselineInfo.path} весит ${baselineInfo.size_bytes} B (baseline-стаб), aegis_brain_versions пуст.`,
      fix: 'После настройки ENV дёрнуть `POST /api/aegis/dspy/retrain {"dry_run": false}` и проверить, что появилась запись в aegis_brain_versions с deployed_at.',
    });
  }
  // GitHub secrets для weekly workflow (`.github/workflows/aegis-dspy-retrain.yml`).
  // Backend их не видит напрямую, но мы хотя бы напоминаем о них.
  const workflowAdvice = {
    level: 'info',
    code: 'github_secrets_reminder',
    message: 'Weekly workflow aegis-dspy-retrain.yml требует GitHub-секретов AEGIS_API_URL, AEGIS_API_TOKEN, AEGIS_PY_URL — без них шаг "Trigger retrain" тихо завершится.',
    fix: 'Settings → Secrets and variables → Actions → New repository secret для каждого из трёх ключей.',
  };
  issues.push(workflowAdvice);

  // Готовность к первому retrain: нет error-issues + py доступен + dataset не пустой.
  const blockingErrors = issues.filter((i) => i.level === 'error');
  const datasetReady = datasetStats.available && datasetStats.total_rows >= minRows;
  const readyForFirstRetrain = blockingErrors.length === 0 && pyReachable === true && datasetReady;

  return {
    enabled: Boolean(dspyCfg.enabled),
    env: envChecks,
    py_reachable: pyReachable,
    py_status: pyStatus,
    dataset: { ...datasetStats, min_rows: minRows },
    last_brain_version: lastVersion,
    baseline_yaml: baselineInfo,
    brain_summary: brainSummary,
    auto_retrain: opts.autoTelemetry || null,
    issues,
    missing_required_env: missingRequired,
    ready_for_first_retrain: readyForFirstRetrain,
  };
}

/**
 * buildGa4Section(opts) — собирает раздел RL/GA4.
 */
function buildGa4Section(opts = {}) {
  const flags = opts.flags || getAegisFlags();
  const envHas = opts.envHas || _envPresence;
  const cfg = flags.rlGa4 || {};

  const envChecks = [
    { name: 'AEGIS_RL_GA4_ENABLED',  set: envHas('AEGIS_RL_GA4_ENABLED'),  required: true,
      help: 'Главный гейт PPO-весов по CTR. Без него RL-контур использует uniform-веса.' },
    { name: 'AEGIS_GA4_PROPERTY_ID', set: envHas('AEGIS_GA4_PROPERTY_ID'), required: true,
      help: 'GA4 Data API property (например, properties/000000000).' },
    { name: 'AEGIS_GA4_SA_JSON',     set: envHas('AEGIS_GA4_SA_JSON'),     required: true,
      help: 'JSON сервисного аккаунта Google (одной строкой). Должен иметь Viewer к GA4 property.' },
    { name: 'AEGIS_PY_URL',          set: envHas('AEGIS_PY_URL'),          required: true,
      help: 'OAuth/JWT для GA4 делегируется в aegis_py (/ga4/fetch).' },
  ];

  // Sanity-проверка JSON сервисного аккаунта: парсится и содержит client_email + private_key.
  let saJsonValid = null;
  let saClientEmail = null;
  const saRaw = process.env.AEGIS_GA4_SA_JSON;
  if (saRaw) {
    try {
      const parsed = JSON.parse(saRaw);
      saJsonValid = Boolean(parsed && parsed.client_email && parsed.private_key);
      saClientEmail = parsed && parsed.client_email ? String(parsed.client_email) : null;
    } catch (_) {
      saJsonValid = false;
    }
  }

  const missingRequired = envChecks.filter((c) => c.required && !c.set).map((c) => c.name);

  const issues = [];
  if (!cfg.enabled) {
    issues.push({
      level: 'info',
      code: 'rl_ga4_disabled',
      message: 'AEGIS_RL_GA4_ENABLED не выставлен — RL-контур использует uniform-веса (=1 для всех страниц).',
      fix: 'Опционально: настроить GA4 service account и выставить AEGIS_RL_GA4_ENABLED=true.',
    });
  }
  for (const name of missingRequired) {
    issues.push({
      level: cfg.enabled ? 'error' : 'info',
      code: `env_missing:${name}`,
      message: `Не выставлена ${name}.`,
      fix: `Добавить ${name} в .env прод-инстанса.`,
    });
  }
  if (saRaw && saJsonValid === false) {
    issues.push({
      level: 'error',
      code: 'sa_json_invalid',
      message: 'AEGIS_GA4_SA_JSON задан, но не парсится как JSON / не содержит client_email+private_key.',
      fix: 'Выгрузить новый ключ сервис-аккаунта в JSON и записать в одну строку.',
    });
  }

  const blockingErrors = issues.filter((i) => i.level === 'error');
  const ready = cfg.enabled
    && missingRequired.length === 0
    && saJsonValid === true
    && blockingErrors.length === 0;

  return {
    enabled: Boolean(cfg.enabled),
    env: envChecks,
    sa_json_valid: saJsonValid,
    sa_client_email: saClientEmail,
    property_id: cfg.propertyId || null,
    top_ctr_quantile: cfg.topCtrQuantile,
    ppo_weight: cfg.ppoWeight,
    issues,
    missing_required_env: missingRequired,
    ready,
  };
}

/**
 * buildTrainingHealth({ db }) — полный отчёт.
 */
async function buildTrainingHealth({ db } = {}) {
  const flags = getAegisFlags();
  let autoTelemetry = null;
  try { autoTelemetry = require('./dspyAutoRetrain').getDspyAutoTelemetry(); } catch (_) {}

  const dspySection = await buildDspySection({ db, flags, autoTelemetry });
  const ga4Section  = buildGa4Section({ flags });

  return {
    generated_at: new Date().toISOString(),
    aegis_enabled: Boolean(flags.enabled),
    dspy: dspySection,
    rl_ga4: ga4Section,
    ready_for_first_retrain: dspySection.ready_for_first_retrain,
  };
}

/**
 * logStartupAdvice(report, logger?) — печатает один WARN со списком
 * конкретных недостающих шагов, если контур обучения не готов. Вызывается
 * из server.js на старте — после bootstrap'а аэгиса.
 */
function logStartupAdvice(report, logger) {
  const log = logger || console;
  if (!report || !report.aegis_enabled) return;
  const blocking = [
    ...((report.dspy && report.dspy.issues) || []).filter((i) => i.level === 'error'),
    ...((report.rl_ga4 && report.rl_ga4.issues) || []).filter((i) => i.level === 'error'),
  ];
  if (!blocking.length) {
    log.log('[aegis/trainingHealth] ✓ контур обучения готов к первому retrain.');
    return;
  }
  const lines = blocking.map((i) => `  • [${i.code}] ${i.message} → ${i.fix}`);
  log.warn(
    '[aegis/trainingHealth] контур обучения мозга НЕ готов. Что нужно сделать:\n'
    + lines.join('\n')
    + '\nПолный отчёт: GET /api/aegis/training/health',
  );
}

module.exports = {
  buildTrainingHealth,
  buildDspySection,
  buildGa4Section,
  logStartupAdvice,
};
