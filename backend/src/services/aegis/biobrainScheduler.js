'use strict';

/**
 * aegis/biobrainScheduler — наблюдатель за «живущим своей жизнью» Bio-Brain.
 *
 * Сам мозг эволюционирует автономно внутри Python-сервиса aegis_py (фоновый
 * поток, см. main.py `_biobrain_evolve_loop`). Node-планировщик НЕ обучает
 * мозг — он лишь раз в statusPollIntervalSec пингует /biobrain/status,
 * снимает телеметрию (поколение, фитнес, fast-reject, размер буфера, время
 * последней эволюции, последний совет) и пишет её в Prometheus-метрики. Эта
 * телеметрия поднимается в /api/aegis/status и питает карточку «🧬 Bio-Brain».
 *
 * Если Python-сервис недоступен или библиотека `neat` не установлена —
 * статус вернёт reason (neat_missing / network), и в UI появится понятная
 * причина «почему прочерки». Никаких исключений наружу — best-effort.
 */

const biobrain = require('./biobrainClient');
const telemetry = require('./telemetry');
const { getAegisFlags } = require('./featureFlags');

let _timer = null;
let _running = false;

const _telemetry = {
  last_check_at:    null,
  available:        null,
  reason:           null,
  generation:       null,
  evolve_count:     null,
  last_evolve_at:   null,
  mean_fitness:     null,
  buffer_size:      null,
  fast_reject_rate_24h: null,
  last_advice:      null,
  last_error:       null,
};

function getBiobrainSchedulerTelemetry() {
  return { ..._telemetry };
}

async function tick() {
  if (_running) return;
  _running = true;
  try {
    const flags = getAegisFlags().biobrain || {};
    _telemetry.last_check_at = new Date().toISOString();

    if (!flags.enabled) {
      _telemetry.available = false;
      _telemetry.reason = flags.disabledReason || 'disabled';
      return;
    }

    const r = await biobrain.status();
    if (!r || !r.ok || !r.body) {
      _telemetry.available = false;
      // Причина «почему прочерки»: disabled / network / neat_missing.
      _telemetry.reason = (r && r.reason) || 'unavailable';
      _telemetry.last_error = (r && r.error) || null;
      return;
    }

    const s = r.body;
    _telemetry.available = Boolean(s.available);
    _telemetry.reason = s.reason || null;
    _telemetry.generation = s.generation ?? null;
    _telemetry.evolve_count = s.evolve_count ?? null;
    _telemetry.last_evolve_at = s.last_evolve_at ?? null;
    _telemetry.mean_fitness = s.mean_fitness ?? null;
    _telemetry.buffer_size = s.buffer_size ?? null;
    _telemetry.fast_reject_rate_24h = s.fast_reject_rate_24h ?? null;
    _telemetry.last_advice = Array.isArray(s.last_advice) ? s.last_advice : null;
    _telemetry.last_error = null;

    // Prometheus-метрики (no-op при выключенной телеметрии).
    try { telemetry.recordBiobrainState(s); } catch (_) { /* best-effort */ }
  } catch (e) {
    _telemetry.last_error = e.message;
    console.warn('[aegis/biobrainScheduler] tick failed:', e.message);
  } finally {
    _running = false;
  }
}

function startBiobrainScheduler() {
  if (_timer) return;
  const flags = getAegisFlags().biobrain || {};
  const intervalSec = Number(flags.statusPollIntervalSec) || 300;
  _timer = setInterval(() => {
    tick().catch((e) => console.warn('[aegis/biobrainScheduler] interval:', e.message));
  }, intervalSec * 1000);
  _timer.unref?.();
  // первый пинг — отложенно, чтобы дать app.listen и aegis_py подняться.
  setTimeout(() => tick().catch(() => {}), 20_000).unref?.();
}

function stopBiobrainScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = {
  startBiobrainScheduler,
  stopBiobrainScheduler,
  tick,
  getBiobrainSchedulerTelemetry,
};
