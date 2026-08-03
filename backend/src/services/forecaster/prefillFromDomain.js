'use strict';
/**
 * prefillFromDomain — авто-заполнение вводных прогнозатора ПО САЙТУ.
 *
 * На вход домен (+ город) → на выход готовые поля формы прогнозатора:
 *   • ключевые слова (фразы домена из keys.so, с частотностью);
 *   • target_url, текущий трафик/мес, главный запрос, конверсия по нише.
 *
 * Переиспользует общую keys.so-механику (keyssoEnrich + reports/keysSoClient)
 * и nicheProfile (конверсия по нише, без LLM). Ничего не создаёт и не пишет —
 * только читает и возвращает данные для формы. Все сбои — грациозные.
 *
 * ИЗОЛЯЦИЯ: новый модуль, существующий прогнозатор не трогает.
 */
const { fetchDomainKeywords, resolveBase } = require('../outreach/provocation/keyssoEnrich');
const { getDomainDashboard } = require('../reports/keysSoClient');
const { getNicheProfile } = require('../outreach/provocation/nicheProfile');
const { selectMarkerV2 } = require('./markerSelectorV2');

// vis (keys.so) → визиты/мес. Множитель общий с keyssoEnrich (env-калибруемый).
const VIS_TO_MONTH = Number(process.env.KEYSSO_VIS_TO_MONTH) || 30;

function _normUrl(domain) {
  const s = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return s ? `https://${s}` : '';
}

/** Тип проекта (intent) по распознанной нише. Значения — как в форме/бэке. */
function _intentFromNiche(matched) {
  if (matched === 'ecom') return 'ecommerce';
  if (matched === 'b2b') return 'b2b';
  if (['medical', 'legal', 'beauty', 'auto', 'repair', 'windows', 'edu', 'realty', 'tourism'].includes(matched)) {
    return 'lead_gen';
  }
  return 'commercial';
}

/**
 * @param {string} domain
 * @param {object} [opts]
 * @param {string} [opts.region]       город (задаёт базу региона keys.so)
 * @param {number} [opts.maxKeywords]  сколько ключей собрать (по умолч. 300)
 * @returns {Promise<
 *   { ok:false, reason:string } |
 *   { ok:true, source:{keywords:string[]}, keywords_detailed:Array,
 *     options:object, meta:object }
 * >}
 */
async function prefillForecasterFromDomainV2(domain, opts = {}) {
  const dom = String(domain || '').trim();
  if (!dom) return { ok: false, reason: 'no_domain' };

  const key = process.env.KEYS_SO_API_KEY || process.env.KEYSSO_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };

  const region = String(opts.region || '').trim();
  const maxKeywords = Math.max(1, Math.min(5000, Number(opts.maxKeywords) || 300));
  const base = resolveBase(region);

  // Ключи домена + дашборд — параллельно, каждый со своим fallback.
  // fetchDomainKeywords используем КАК ЕСТЬ (не меняем общий модуль).
  // perPage держим небольшим (100): keys.so на больших per_page отвечает
  // очень долго (был таймаут > 60с). 100 фраз приходят за пару секунд —
  // это достаточный стартовый охват ядра, остальное можно добрать позже.
  const [keywordsRaw, dashboard] = await Promise.all([
    fetchDomainKeywords(dom, { base, perPage: 100 }).catch(() => []),
    getDomainDashboard(dom, { base }).catch((e) => {
      console.warn(`[prefillFromDomain] dashboard ${dom}@${base} failed: ${e.message}`);
      return null;
    }),
  ]);
  const keywords = keywordsRaw.slice(0, maxKeywords);

  if (!keywords.length && !dashboard) {
    return { ok: false, reason: 'no_data' };
  }

  // Сортируем по частотности (убыв.) + дедуп по фразе (защитно, на случай дублей).
  const seenPhrase = new Set();
  const sorted = keywords
    .slice()
    .sort((a, b) => (b.volume || 0) - (a.volume || 0))
    .filter((k) => {
      if (!k.phrase || seenPhrase.has(k.phrase)) return false;
      seenPhrase.add(k.phrase);
      return true;
    });
  const phrases = sorted.map((k) => k.phrase);
  // Главный запрос — по методике (markerSelectorV2): НЕ гео-хвост «фрязино юрист»,
  // а центр коммерческого ядра. Фолбэк на топ-частотность, если селектор пуст.
  const marker = selectMarkerV2(sorted);
  const mainQuery = marker.main_query || sorted[0]?.phrase || '';

  const vis = Number(dashboard?.overview?.visibility) || 0;
  const trafficMonth = Math.round(vis * VIS_TO_MONTH);

  // Ниша/конверсия по ключам (эвристика по маркерам, без LLM — бесплатно).
  const prof = getNicheProfile('', { keyword: phrases.slice(0, 40).join(' ') });

  const cleanDomain = _normUrl(dom).replace(/^https?:\/\//, '');

  return {
    ok: true,
    // Автоимя задачи (поле name формы).
    name: `Прогноз · ${cleanDomain}`,
    // Для формы: source.keywords (массив фраз) — как ждёт createForecasterTask.
    source: { keywords: phrases },
    // Полные данные (частотность/позиция) — для таблицы-превью в UI.
    keywords_detailed: sorted,
    options: {
      target_url: _normUrl(dom),
      current_traffic_per_month: trafficMonth,
      region,
      main_query: mainQuery,
      conversion_rate: prof.conversion_rate,
      intent: _intentFromNiche(prof.matched),
    },
    meta: {
      domain: dom,
      base,
      keywords_count: phrases.length,
      traffic_month: trafficMonth,
      keywords_top10: Number(dashboard?.overview?.keywords_top10) || 0,
      lead_unit: prof.lead_unit_gen,
      // Прозрачность выбора главного запроса (для UI/отладки).
      main_query: mainQuery,
      core_token: marker.core_token,
      markers: marker.markers.slice(0, 5),
      marker_stats: marker.stats,
    },
  };
}

module.exports = { prefillForecasterFromDomainV2 };
