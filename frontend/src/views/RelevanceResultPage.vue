<script setup>
import { ref, computed, onMounted, onUnmounted, watch, unref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '../api.js';
import AppLayout from '../components/AppLayout.vue';
import { useRelevanceStore } from '../stores/relevance.js';
import { findRegionByCode } from '../data/yandexRegions.js';

const route   = useRoute();
const router  = useRouter();
const store   = useRelevanceStore();

const report      = ref(null);
const loadError   = ref(null);
const initialLoad = ref(true);
let pollTimer    = null;

// ── Filters / paging для таблиц ──────────────────────────────────────────
const vocabFilter = ref('all'); // 'all' | 'important' | 'additional'
const ngramFilter = ref('all'); // 'all' | 'bigram' | 'trigram' | '4gram'

// Пагинация для больших таблиц — заказчик: «не должно быть полотном,
// каждый раздел сделать по страницам». Размер страницы общий, дефолт 50.
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const vocabPage     = ref(1);
const vocabPageSize = ref(50);
const ngramPage     = ref(1);
const ngramPageSize = ref(50);
const gapPage       = ref(1);
const gapPageSize   = ref(50);

// Сортировка таблицы LSI (важно: TF-IDF теперь тоже доступен).
const vocabSort = ref({ key: 'bm25_score', dir: 'desc' });

// Сортировка таблицы N-грамм.
const ngramSort = ref({ key: 'df', dir: 'desc' });

// Сортировка таблицы per-term gap (сравнение с нашим сайтом).
const gapSort   = ref({ key: 'bm25_score', dir: 'desc' });

// Сортировка для таблиц теговой зоны и пересечений заголовков.
const tagZoneSort  = ref({ key: 'bm25_score', dir: 'desc' });
const headingsSort = ref({ key: 'df', dir: 'desc' });

// Универсальный обработчик клика по заголовку колонки таблицы.
// Один и тот же ref{key,dir} переиспользуется для разных таблиц.
//
// ВАЖНО: эта функция вызывается и из <script>, куда передаётся сам ref
// (`toggleSort(compTableSort, key)`), и из <template>, куда Vue передаёт
// уже автораспакованное reactive-значение (`@click="toggleSort(gapSort, key)"`).
// Поэтому через `unref` сводим оба варианта к одной reactive-сущности и
// мутируем её свойства — изменения видны и через `state.value` в скрипте,
// и через `state.key` / `state.dir` в шаблоне (плюс срабатывает watch,
// который переключает страницу пагинации на 1).
function toggleSort(state, key) {
  const s = unref(state);
  if (!s) return;
  if (s.key === key) {
    s.dir = s.dir === 'desc' ? 'asc' : 'desc';
  } else {
    s.key = key;
    s.dir = 'desc';
  }
}

// Маленький компонент-helper в template: ↕ / ↑ / ↓ для индикатора активной сортировки.
// Те же соображения с `unref`, что и в `toggleSort` — иначе из шаблона
// прилетает уже автораспакованное значение, и `state.value.key` падает с
// `Cannot read properties of undefined (reading 'key')`, ломая весь рендер
// готового отчёта (пользователь видит «пустой экран»).
function sortArrow(state, key) {
  const s = unref(state);
  if (!s || s.key !== key) return '↕';
  return s.dir === 'desc' ? '↓' : '↑';
}

// Возвращает компаратор для sort() по объектному ключу + направлению.
// numeric=true → числа; иначе localeCompare для строк.
function makeSorter({ key, dir }, { numeric = true } = {}) {
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const av = a == null ? null : a[key];
    const bv = b == null ? null : b[key];
    if (numeric) {
      const na = av == null ? -Infinity : Number(av);
      const nb = bv == null ? -Infinity : Number(bv);
      if (na === nb) return 0;
      return na > nb ? sign : -sign;
    }
    return sign * String(av || '').localeCompare(String(bv || ''), 'ru');
  };
}

// ── Cocoons (PR 2) ────────────────────────────────────────────────────────
const cocoonsBuilding = ref(false);
const cocoonsError    = ref(null);
const cocoonsOpts     = ref({ n_topics: 8, top_terms: 12, top_documents: 5 });

async function buildCocoons() {
  if (!report.value || cocoonsBuilding.value) return;
  cocoonsBuilding.value = true;
  cocoonsError.value = null;
  try {
    await store.buildCocoons(report.value.id, cocoonsOpts.value);
    await reload();
  } catch (err) {
    cocoonsError.value = err.response?.data?.error || err.message || 'Не удалось построить коконы';
  } finally {
    cocoonsBuilding.value = false;
  }
}

async function deleteRawCache() {
  if (!report.value) return;
  if (!confirm('Удалить кэш сырых документов? После этого пересчитать коконы можно будет только создав новый отчёт.')) return;
  try {
    await store.deleteRaw(report.value.id);
    await reload();
  } catch (err) {
    alert(err.response?.data?.error || err.message || 'Не удалось удалить кэш');
  }
}

const cocoons = computed(() => report.value?.cocoons || null);
const cocoonsTopics = computed(() => {
  const list = cocoons.value?.topics;
  return Array.isArray(list) ? list : [];
});

// Размер «чипа» леммы пропорционален |weight| относительно максимума в теме.
function chipStyle(term, topic) {
  const maxW = Math.max(...topic.terms.map((t) => Math.abs(t.weight)), 1e-6);
  const t = Math.abs(term.weight) / maxW;
  const size = 11 + t * 7; // 11–18 px
  if (term.weight < 0) {
    // Антитема — серым outline, чтобы копирайтер видел «что НЕ употреблять».
    return {
      fontSize: size + 'px',
      color:    '#9ca3af',
      borderColor: '#374151',
      background:  'transparent',
    };
  }
  // hue: 220 → 280 (синий → фиол) пропорционально весу.
  const hue = 220 + t * 60;
  return {
    fontSize: size + 'px',
    color:    `hsl(${hue.toFixed(0)}, 80%, 75%)`,
    borderColor: `hsl(${hue.toFixed(0)}, 60%, 35%)`,
    background:  `hsl(${hue.toFixed(0)}, 50%, 18%)`,
  };
}

function formatRawTtl(report) {
  if (!report?.raw_expires_at) return null;
  const ms = new Date(report.raw_expires_at).getTime() - Date.now();
  if (ms <= 0) return { expired: true, label: 'кэш истёк' };
  const days  = Math.floor(ms / (24 * 3600 * 1000));
  const hours = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
  const label = days > 0 ? `${days}д ${hours}ч` : `${hours}ч`;
  return { expired: false, label };
}

async function reload() {
  try {
    report.value = await store.getReport(route.params.id);
    loadError.value = null;
  } catch (err) {
    loadError.value = err.response?.data?.error || err.message || 'Не удалось загрузить отчёт';
  } finally {
    initialLoad.value = false;
  }
}

onMounted(() => {
  reload();
  pollTimer = setInterval(() => {
    if (report.value && ['pending', 'fetching', 'analyzing'].includes(report.value.status)) {
      reload();
    }
  }, 2500);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

// ── Derived ──────────────────────────────────────────────────────────────
const vocabulary = computed(() => {
  const list = report.value?.report?.vocabulary;
  return Array.isArray(list) ? list : [];
});
const ngrams = computed(() => {
  const list = report.value?.report?.ngrams;
  return Array.isArray(list) ? list : [];
});
const stats = computed(() => report.value?.report?.stats || {});

// PR3: comparison «наш сайт vs ТОП». Все computed безопасны — возвращают
// null/[] на старых отчётах (поле comparison NULL).
const comparison      = computed(() => report.value?.comparison || null);
const ourReport       = computed(() => report.value?.our_report || null);
const docDiagnostics  = computed(() => {
  const list = report.value?.report?.document_diagnostics;
  return Array.isArray(list) ? list : [];
});
const failBreakdown   = computed(() => report.value?.report?.fail_breakdown || {});
const filterInfo      = computed(() => report.value?.report?.filter || null);

// Сводка причин fail'а — для бейджиков «5×http_403, 3×timeout, 2×SPA».
const failBreakdownEntries = computed(() => {
  const obj = failBreakdown.value || {};
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
});

// Цветовое кодирование per-term статуса.
function statusColor(s) {
  switch (s) {
    case 'missing': return 'bg-red-900/40 text-red-300 border border-red-800/60';
    case 'under':   return 'bg-orange-900/40 text-orange-300 border border-orange-800/60';
    case 'ok':      return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'over':    return 'bg-sky-900/40 text-sky-300 border border-sky-800/60';
    default:        return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}

// Сортировка comp-table уже использует свой стейт — переписываем через
// общий helper для единообразия.
const compTableSort = ref({ key: 'lsi_coverage_pct', dir: 'desc' });
function setCompSort(key) { toggleSort(compTableSort, key); }
const compTable = computed(() => {
  const rows = comparison.value?.competitor_table || [];
  if (!Array.isArray(rows) || rows.length === 0) return [];
  // serp_position требует null→Infinity для корректной сортировки.
  const { key } = compTableSort.value;
  if (key === 'serp_position') {
    const sign = compTableSort.value.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a.serp_position == null ? Infinity : Number(a.serp_position);
      const bv = b.serp_position == null ? Infinity : Number(b.serp_position);
      return (av - bv) * sign;
    });
  }
  return [...rows].sort(makeSorter(compTableSort.value, { numeric: key !== 'url' }));
});

// Фильтр для секции gap (по умолчанию показываем только важные missing/under/over).
const gapFilter = ref('actionable');  // all / actionable / missing / under / over / ok
const gapVisible = computed(() => {
  const arr = comparison.value?.per_term || [];
  if (!Array.isArray(arr)) return [];
  let out = arr;
  if (gapFilter.value === 'actionable') {
    out = arr.filter((t) => t.status !== 'ok');
  } else if (gapFilter.value !== 'all') {
    out = arr.filter((t) => t.status === gapFilter.value);
  }
  // Сортировка: важные → сначала, потом по выбранной колонке.
  return [...out].sort((a, b) => {
    if (a.important !== b.important) return a.important ? -1 : 1;
    return makeSorter(gapSort.value)(a, b);
  }).slice(0, 500);  // защита от гигантских таблиц
});

// ── (9) Фильтр для математических директив ────────────────────────────
// Заказчик: «Что делать (математические директивы) надо разделить, что
// важно, что менее важно, чтобы можно было легко фильтровать».
// Используем уже существующий флаг `important` (выставляется в Python,
// см. comparison.py:_build_directives — он совпадает с important_set
// словаря).
const directiveFilter = ref('important'); // 'all' | 'important' | 'additional'
const directivesVisible = computed(() => {
  const arr = comparison.value?.directives || [];
  if (!Array.isArray(arr)) return [];
  if (directiveFilter.value === 'important') return arr.filter((d) => d.important);
  if (directiveFilter.value === 'additional') return arr.filter((d) => !d.important);
  return arr;
});
const directivesImportantCount = computed(
  () => (comparison.value?.directives || []).filter((d) => d.important).length
);
const directivesAdditionalCount = computed(
  () => (comparison.value?.directives || []).filter((d) => !d.important).length
);

// ── (7) Tag-zone vocabulary + сравнение с нашим сайтом ─────────────────
const tagZoneVocab = computed(() => {
  const list = report.value?.report?.tag_zone_vocabulary;
  return Array.isArray(list) ? list : [];
});
const ourTagZoneSet = computed(() => {
  const arr = report.value?.our_report?.tag_zone_lemmas;
  return new Set(Array.isArray(arr) ? arr : []);
});
const tagZoneRows = computed(() => {
  const set = ourTagZoneSet.value;
  return tagZoneVocab.value.map((v) => ({
    ...v,
    in_our_tag_zone: set.has(v.lemma),
  }));
});
const tagZoneSorted = computed(() => {
  return [...tagZoneRows.value].sort(makeSorter(tagZoneSort.value, {
    numeric: tagZoneSort.value.key !== 'lemma' && tagZoneSort.value.key !== 'status',
  }));
});

// ── (12) Пересечения заголовков h2..h6 ─────────────────────────────────
const headingsIntersection = computed(() => {
  const list = report.value?.report?.headings_intersection;
  return Array.isArray(list) ? list : [];
});
const headingsSorted = computed(() => {
  return [...headingsIntersection.value].sort(makeSorter(headingsSort.value, {
    numeric: headingsSort.value.key !== 'text' && headingsSort.value.key !== 'sample',
  }));
});

// ── (13) Wave 1: SEO-сигналы из утечек Google/Yandex ───────────────────
// См. relevance/app/signals.py + competitorSignalsRequirements.js на бэке.
// Структура: { per_url, top_aggregate, algorithm_signals, doc_count }.
// our_report.competitor_signals — то же самое для нашего сайта (если задан).
const competitorSignals = computed(() => {
  const block = report.value?.report?.competitor_signals;
  return (block && typeof block === 'object') ? block : null;
});
const topAggregate = computed(() => competitorSignals.value?.top_aggregate || {});
const algorithmSignals = computed(() => competitorSignals.value?.algorithm_signals || {});
const ourSignals = computed(() => report.value?.our_report?.competitor_signals || null);

// Mini-чеклист для UI: «наш сайт vs медиана топа» по ключевым метрикам.
// Пороги дублируются в backend/src/services/relevance/competitorSignalsRequirements.js
// (compareOurDocumentToTop) — держать значения в синхронизации.
const GAP_UNDER_THRESHOLD = 0.7;
const GAP_OVER_THRESHOLD = 1.5;
const GAP_OVER_THRESHOLD_INVERSE = 1.3;
const ourVsTopGaps = computed(() => {
  const our = ourSignals.value;
  const top = topAggregate.value;
  if (!our || our.empty_reason || !top || Object.keys(top).length === 0) return [];
  const ux = top.ux_profile || {};
  const exact = top.exact_query_position_targets || {};
  const trust = top.trust_link_quota || {};
  const our_ux = our.ux_profile || {};
  const our_eo = our.exact_occurrences || {};
  const our_tl = our.trust_links || {};
  const cmp = (label, ourVal, topVal, higherIsBetter = true) => {
    if (topVal === null || topVal === undefined) return null;
    const o = Number(ourVal) || 0;
    const t = Number(topVal) || 0;
    let gap = 'ok';
    if (higherIsBetter && o < t * GAP_UNDER_THRESHOLD) gap = 'under';
    if (higherIsBetter && o > t * GAP_OVER_THRESHOLD) gap = 'over';
    if (!higherIsBetter && o > t * GAP_OVER_THRESHOLD_INVERSE) gap = 'over';
    return { label, our: o, top: t, gap };
  };
  return [
    cmp('H2-разделов', our_ux.h2_count, ux.h2_count_median),
    cmp('Заголовков на 1000 слов', our_ux.headings_per_1k_words, ux.headings_per_1k_words_median),
    cmp('Символов до первого H2', our_ux.above_the_fold_chars, ux.above_the_fold_chars_median),
    cmp('Средняя длина абзаца', our_ux.avg_paragraph_chars, ux.avg_paragraph_chars_median, false),
    cmp('Точные вхождения в первых 100 словах', our_eo.first_100_words, exact.first_100_words_median),
    cmp('Точные вхождения в H2', our_eo.in_h2, exact.in_h2_median),
    cmp('Точные вхождения всего', our_eo.total, exact.total_median),
    cmp('Trust-ссылок (gov/wiki/ГОСТ/СМИ)', our_tl.trust_links, trust.trust_links_median),
  ].filter(Boolean);
});

// Per-URL таблица Wave-1 сигналов. Сортировка по effort_score.
const competitorSignalsRows = computed(() => {
  const rows = competitorSignals.value?.per_url || [];
  return rows
    .filter((r) => r && !r.empty_reason)
    .map((r) => ({
      url: r.url,
      title: r.title_meta?.title || '',
      title_chars: r.title_meta?.title_chars || 0,
      title_h1_match: !!r.title_meta?.title_h1_exact_match,
      schemas: (r.schema_types || []).map((t) => t.type).filter(Boolean),
      age_modified: r.freshness?.age_modified_days,
      effort: r.effort_score || 0,
      h2: r.ux_profile?.h2_count || 0,
      trust: r.trust_links?.trust_links || 0,
      exact_total: r.exact_occurrences?.total || 0,
    }))
    .sort((a, b) => (b.effort || 0) - (a.effort || 0));
});

// ── (4) Превью того, что собрал парсер (per-URL) ───────────────────────
// Бэкенд кладёт `parsed_preview` в каждый document_diagnostics при
// `include_parsed_preview=true`. На UI: модалка по клику на «📄 Что собрал».
const previewByUrl = computed(() => {
  const map = new Map();
  for (const d of (docDiagnostics.value || [])) {
    if (d?.url) {
      map.set(String(d.url), {
        text: String(d.parsed_preview || ''),
        text_chars: Number(d.text_chars || 0),
        word_count: Number(d.word_count || 0),
        method:     String(d.method || '—'),
        empty_reason: d.empty_reason || null,
        tag_zone_chars: Number(d.tag_zone_chars || 0),
        headings: Array.isArray(d.headings) ? d.headings : null,
      });
    }
  }
  return map;
});
const previewModalUrl = ref(null);
const previewModal = computed(() => {
  if (!previewModalUrl.value) return null;
  const data = previewByUrl.value.get(previewModalUrl.value);
  if (!data) return null;
  return { url: previewModalUrl.value, ...data };
});
function openPreview(url) {
  previewModalUrl.value = String(url || '') || null;
}
function closePreview() {
  previewModalUrl.value = null;
}

const vocabFiltered = computed(() => {
  let arr = vocabFilter.value === 'all'
    ? vocabulary.value
    : vocabulary.value.filter((v) => v.status === vocabFilter.value);
  arr = [...arr].sort(makeSorter(vocabSort.value, { numeric: vocabSort.value.key !== 'lemma' }));
  return arr;
});
const ngramsFiltered = computed(() => {
  let arr = ngramFilter.value === 'all'
    ? ngrams.value
    : ngrams.value.filter((n) => n.type === ngramFilter.value);
  arr = [...arr].sort(makeSorter(ngramSort.value, { numeric: ngramSort.value.key !== 'phrase' && ngramSort.value.key !== 'pos_pattern' }));
  return arr;
});

// ── Пагинация ─────────────────────────────────────────────────────────────
// При смене фильтра/сортировки сбрасываем страницу на 1 — иначе можно
// попасть на «пустую» страницу.
watch([vocabFilter, vocabSort, vocabPageSize], () => { vocabPage.value = 1; }, { deep: true });
watch([ngramFilter, ngramSort, ngramPageSize], () => { ngramPage.value = 1; }, { deep: true });
watch([gapFilter, gapSort, gapPageSize],       () => { gapPage.value   = 1; }, { deep: true });

function pageCount(total, size) {
  return Math.max(1, Math.ceil((Number(total) || 0) / Math.max(1, Number(size) || 1)));
}
function clampPage(page, total, size) {
  const max = pageCount(total, size);
  const p = Math.min(Math.max(1, Number(page) || 1), max);
  return p;
}
function paginate(arr, page, size) {
  const list = Array.isArray(arr) ? arr : [];
  const sz   = Math.max(1, Number(size) || 1);
  const p    = clampPage(page, list.length, sz);
  const start = (p - 1) * sz;
  return list.slice(start, start + sz);
}

const vocabPaged       = computed(() => paginate(vocabFiltered.value, vocabPage.value, vocabPageSize.value));
const vocabPageCount   = computed(() => pageCount(vocabFiltered.value.length, vocabPageSize.value));
const vocabPageStart   = computed(() => vocabFiltered.value.length === 0 ? 0 : (clampPage(vocabPage.value, vocabFiltered.value.length, vocabPageSize.value) - 1) * vocabPageSize.value);

const ngramsPaged      = computed(() => paginate(ngramsFiltered.value, ngramPage.value, ngramPageSize.value));
const ngramsPageCount  = computed(() => pageCount(ngramsFiltered.value.length, ngramPageSize.value));
const ngramsPageStart  = computed(() => ngramsFiltered.value.length === 0 ? 0 : (clampPage(ngramPage.value, ngramsFiltered.value.length, ngramPageSize.value) - 1) * ngramPageSize.value);

const gapPaged         = computed(() => paginate(gapVisible.value, gapPage.value, gapPageSize.value));
const gapPageCount     = computed(() => pageCount(gapVisible.value.length, gapPageSize.value));
const gapPageStart     = computed(() => gapVisible.value.length === 0 ? 0 : (clampPage(gapPage.value, gapVisible.value.length, gapPageSize.value) - 1) * gapPageSize.value);

function gotoPage(target, total, size, setter) {
  setter(clampPage(target, total, size));
}

// Bar chart: топ-20 по медиане вхождений (как «суммарная частота» по корпусу).
const topByFrequency = computed(() => {
  // Используем bm25_score как «вес» — это и есть рейтинг важности термина.
  // Сортируем по убыванию и берём 20.
  return [...vocabulary.value]
    .filter((v) => v.bm25_score > 0 || v.df >= 5)
    .sort((a, b) => (b.median_count * b.df) - (a.median_count * a.df))
    .slice(0, 20);
});

const barMax = computed(() => {
  const arr = topByFrequency.value;
  return arr.length ? Math.max(...arr.map((v) => v.median_count * v.df)) : 1;
});

// ── (8) Multi-series: median(top) vs our_count vs Zipf-fit ─────────────
// Заказчик: «надо строить формат графика, где будет графики: медиана по
// LSI словам, график по нашему сайту, и расчёт закона ципфа и построение
// графика третьего». Используем те же топ-20 лемм по «суммарной частоте».
// Закон Ципфа: f(rank) ≈ C / rank^s; подбираем C, s по медиане ТОПа
// методом наименьших квадратов в log-log пространстве.
const ourCountByLemma = computed(() => {
  const map = new Map();
  for (const t of (comparison.value?.per_term || [])) {
    if (t?.lemma != null) map.set(String(t.lemma), Number(t.our_count) || 0);
  }
  return map;
});

const topChartData = computed(() => {
  const items = topByFrequency.value;
  if (!items.length) return null;

  // ── 1) Подгонка Zipf: y = C * rank^(-s) → log y = log C - s * log rank.
  // y_i = median_count_i (используем медиану, а не df×median, чтобы
  // получить распределение «частоты слова в одном документе ниши»).
  const ranks = items.map((_, i) => i + 1);
  const yObs  = items.map((v) => Math.max(1e-6, Number(v.median_count) || 0));
  // Линейная регрессия по точкам (log rank, log y).
  const xs = ranks.map((r) => Math.log(r));
  const ys = yObs.map((y) => Math.log(y));
  const n  = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  // Если все x_i равны (n=1 или дисперсия ноль) — закону Ципфа нечем
  // обучаться. Берём s=1 (классический закон Ципфа без отклонений) и
  // intercept = mean(y), чтобы кривая прошла через средний уровень.
  const slope = den > 0 ? num / den : -1; // -s, по умолчанию s=1
  const intercept = den > 0 ? meanY - slope * meanX : meanY;
  const s = -slope;
  const C = Math.exp(intercept);
  const zipf = ranks.map((r) => C * Math.pow(r, -s));

  // ── 2) Серии для графика. Шкала Y: max из всех серий (с округлением).
  const our = items.map((v) => ourCountByLemma.value.get(v.lemma) ?? 0);
  const med = items.map((v) => Number(v.median_count) || 0);
  const yMax = Math.max(
    1,
    ...med, ...our, ...zipf,
  );

  return {
    items,        // полные строки vocab (для tooltip)
    labels: items.map((v) => v.lemma),
    median: med,
    our,
    zipf,
    zipf_C: C,
    zipf_s: s,
    yMax,
    n,
    hasOur: our.some((v) => v > 0),
    hasComparison: !!comparison.value && !comparison.value.error,
  };
});

// ── (6) Word cloud: spiral layout. Возвращает массив элементов с
// абсолютными координатами {x, y, lemma, size, color, title}.
// Главное слово (топ-1 по BM25) — в центре. Остальные размещаются по
// архимедовой спирали с проверкой коллизий (грубая bbox-эвристика).
const cloud = computed(() => {
  const items = [...vocabulary.value]
    .filter((v) => v.bm25_score > 0)
    .sort((a, b) => b.bm25_score - a.bm25_score)
    .slice(0, 60);
  if (!items.length) return { boxes: [], width: 800, height: 420 };

  const max = items[0].bm25_score;
  const min = items[items.length - 1].bm25_score;
  const span = Math.max(1e-6, max - min);

  // Размер шрифта 14–48 px пропорционально BM25 (главное слово — самое крупное).
  const sizes = items.map((v) => 14 + ((v.bm25_score - min) / span) * 34);

  // Канвас словаря.
  const W = 900, H = 460;
  const cx = W / 2, cy = H / 2;

  // Грубая ширина текста: ~0.55 * fontSize * length, высота ≈ fontSize * 1.05
  const charWidth = (size, text) => Math.max(20, size * 0.58 * Math.max(1, text.length));

  const placed = [];

  function intersects(a, b) {
    return !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
  }

  // Размещение по архимедовой спирали r = a + b*theta.
  // Шаг угла маленький; шаг r растёт медленно, чтобы заполнить плотно.
  for (let i = 0; i < items.length; i++) {
    const v    = items[i];
    const text = v.lemma;
    const size = sizes[i];
    const w    = charWidth(size, text);
    const h    = size * 1.1;

    // Центральное слово — без поиска.
    if (i === 0) {
      const left = cx - w / 2, top = cy - h / 2;
      placed.push({
        lemma: text, size, color: cloudColor(1, sizes.length),
        title: `BM25: ${v.bm25_score} · DF: ${v.df} · Median: ${v.median_count}`,
        cx,
        cy,
        left, top,
        right: left + w, bottom: top + h,
        is_center: true,
      });
      continue;
    }

    // Спираль: theta растёт, r растёт линейно.
    const a = 4, b = 4;
    let placedNode = null;
    for (let theta = 0; theta < 80 * Math.PI; theta += 0.18) {
      const r  = a + b * theta;
      const x  = cx + r * Math.cos(theta);
      const y  = cy + r * Math.sin(theta);
      const left = x - w / 2, top = y - h / 2;
      const box  = { left, top, right: left + w, bottom: top + h };
      // Не выходим за границы канваса (с padding).
      if (box.left < 4 || box.top < 4 || box.right > W - 4 || box.bottom > H - 4) continue;
      // Проверка коллизии со всеми ранее размещёнными.
      let collide = false;
      for (const p of placed) {
        if (intersects(box, p)) { collide = true; break; }
      }
      if (!collide) {
        placedNode = {
          lemma: text, size, color: cloudColor(i + 1, items.length),
          title: `BM25: ${v.bm25_score} · DF: ${v.df} · Median: ${v.median_count}`,
          cx: x, cy: y,
          left, top,
          right: box.right, bottom: box.bottom,
          is_center: false,
        };
        break;
      }
    }
    if (placedNode) placed.push(placedNode);
  }

  return { boxes: placed, width: W, height: H };
});

function cloudColor(rank, total) {
  // Топ-1 → ярко-фиолетовый; далее переход к синему.
  const t = Math.max(0, Math.min(1, (rank - 1) / Math.max(1, total - 1)));
  const hue = 280 - t * 80; // 280 → 200
  const lightness = 70 - t * 15; // 70% → 55%
  return `hsl(${hue.toFixed(0)}, 75%, ${lightness.toFixed(0)}%)`;
}

// ── Status helpers ───────────────────────────────────────────────────────
function statusBadgeClass(status) {
  switch (status) {
    case 'done':      return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'analyzing': return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'fetching':  return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'pending':   return 'bg-amber-900/40 text-amber-300 border border-amber-800/60';
    case 'error':     return 'bg-red-900/40 text-red-300 border border-red-800/60';
    default:          return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}
function statusLabel(status) {
  return ({
    done: 'Готово', analyzing: 'Анализ', fetching: 'Сбор данных',
    pending: 'Ожидает', error: 'Ошибка',
  })[status] || status;
}
function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('ru-RU'); } catch (_) { return String(d); }
}
function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 100) / 10;
  return s < 60 ? `${s.toFixed(1)}с` : `${Math.round(s / 60)}м ${Math.round(s % 60)}с`;
}

// Подпись региона: вместо «lr=213» показываем «Москва (lr=213)».
function regionLabel(lr) {
  const r = findRegionByCode(lr);
  return r ? `${r.name} (lr=${r.code})` : `lr=${lr}`;
}

// ── Export — берём напрямую с бэка через apiBaseURL+токен ────────────────
async function exportFile(kind) {
  try {
    const ext = kind === 'json' ? 'json' : 'csv';
    const res = await api.get(`/relevance/${route.params.id}/export.${ext}`, {
      responseType: 'blob',
    });
    // Если бэк отдал JSON-ошибку (400/500) с responseType:'blob', содержимое
    // всё равно придёт как Blob. Распознаём по типу и парсим, чтобы показать
    // нормальный alert вместо «качаем 100 байт мусора».
    const ct = (res?.headers?.['content-type'] || '').toLowerCase();
    if (kind === 'csv' && ct.includes('application/json') && res.data?.text) {
      try {
        const txt = await res.data.text();
        const parsed = JSON.parse(txt);
        throw new Error(parsed?.error || 'Ошибка экспорта');
      } catch (e) {
        alert(e.message || 'Ошибка экспорта');
        return;
      }
    }
    const blob = new Blob([res.data], {
      type: kind === 'json' ? 'application/json' : 'text/csv',
    });
    const safeName = String(report.value?.query || 'report').replace(/[^a-zа-яё0-9_-]+/gi, '_').slice(0, 60);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relevance_${safeName}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Браузеру нужно время на инициирование загрузки до того, как мы освободим URL.
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (err) {
    // Если ответ axios — пытаемся распарсить blob как JSON.
    let msg = err.message || 'Ошибка экспорта';
    const blob = err?.response?.data;
    if (blob && typeof blob.text === 'function') {
      try {
        const txt = await blob.text();
        const parsed = JSON.parse(txt);
        msg = parsed?.error || msg;
      } catch (_) { /* keep original */ }
    } else if (typeof err?.response?.data?.error === 'string') {
      msg = err.response.data.error;
    }
    alert(msg);
  }
}

// ── Copy helpers ─────────────────────────────────────────────────────────
const copyHint = ref('');     // временный feedback, что скопировано
let copyHintTimer = null;

async function copyToClipboard(text, label) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback для старых браузеров / небезопасных origin'ов
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    copyHint.value = `✓ Скопировано: ${label}`;
  } catch (err) {
    copyHint.value = `⚠ Не удалось скопировать: ${err.message || ''}`;
  }
  if (copyHintTimer) clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => { copyHint.value = ''; }, 2500);
}

function copyImportantLsi() {
  const items = vocabulary.value.filter((v) => v.status === 'important').map((v) => v.lemma);
  copyToClipboard(items.join(', '), `важные LSI (${items.length})`);
}
function copyAllLsi() {
  const items = vocabulary.value.map((v) => v.lemma);
  copyToClipboard(items.join(', '), `все LSI (${items.length})`);
}
function copyImportantNgrams() {
  // «Важные» n-граммы — те, что встречаются у максимума сайтов (топ по df).
  // Если в выдаче есть фразы с df ≥ 3, считаем их важными; иначе берём top-30.
  const ng = ngrams.value;
  const important = ng.filter((n) => n.df >= 3);
  const list = important.length >= 5
    ? important
    : [...ng].sort((a, b) => b.df - a.df).slice(0, 30);
  const text = list.map((n) => n.phrase).join('\n');
  copyToClipboard(text, `важные n-граммы (${list.length})`);
}
function copyAllNgrams() {
  const text = ngrams.value.map((n) => n.phrase).join('\n');
  copyToClipboard(text, `все n-граммы (${ngrams.value.length})`);
}
function copyFilteredVocab() {
  const text = vocabFiltered.value.map((v) => v.lemma).join(', ');
  copyToClipboard(text, `видимые LSI (${vocabFiltered.value.length})`);
}
function copyFilteredNgrams() {
  const text = ngramsFiltered.value.map((n) => n.phrase).join('\n');
  copyToClipboard(text, `видимые n-граммы (${ngramsFiltered.value.length})`);
}

// (4) Скопировать содержимое модалки «что собрал парсер» (для выбранного URL).
function copyPreviewText() {
  const data = previewModal.value;
  if (!data || !data.text) return;
  copyToClipboard(data.text, `текст ${data.url}`);
}

// (12) Скопировать рекомендованные заголовки (для копирайтера).
function copyHeadings() {
  const list = headingsIntersection.value || [];
  if (!list.length) return;
  const text = list.map((h) => `${h.sample}  (df=${h.df}, ${h.df_share_pct}%)`).join('\n');
  copyToClipboard(text, `рекомендованные h2..h6 (${list.length})`);
}

// (7) Скопировать LSI теговой зоны.
function copyTagZone() {
  const list = tagZoneVocab.value || [];
  if (!list.length) return;
  const text = list.map((t) => t.lemma).join(', ');
  copyToClipboard(text, `LSI теговой зоны (${list.length})`);
}
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <!-- Toast: feedback от кнопок «Скопировать» -->
      <Transition name="fade">
        <div v-if="copyHint"
             class="fixed bottom-6 right-6 z-50 px-4 py-2 rounded-lg shadow-lg
                    bg-emerald-900/90 text-emerald-100 border border-emerald-700 text-sm">
          {{ copyHint }}
        </div>
      </Transition>

      <!-- Шапка -->
      <div class="flex items-start justify-between gap-4 border-b border-gray-800 pb-4">
        <div class="min-w-0">
          <button @click="router.push('/relevance')" class="btn-ghost text-xs mb-2">← К списку</button>
          <h1 class="text-2xl font-bold text-white truncate" :title="report?.query">
            📊 {{ report?.query || 'Загрузка отчёта...' }}
          </h1>
          <div class="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span v-if="report">📍 {{ regionLabel(report.lr) }}</span>
            <span v-if="report">📅 {{ formatDate(report.created_at) }}</span>
            <span v-if="report?.duration_ms">⏱ {{ formatDuration(report.duration_ms) }}</span>
            <span v-if="report">🔗 {{ report.fetched_count }}/{{ (report.serp || []).length }} страниц</span>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span v-if="report" :class="['badge', statusBadgeClass(report.status)]">
            {{ statusLabel(report.status) }}
            <span v-if="report.current_stage && report.status !== 'done' && report.status !== 'error'"
                  class="ml-1 text-[10px] opacity-80">· {{ report.current_stage }}</span>
          </span>
          <button v-if="report?.status === 'done'" @click="exportFile('json')"
                  class="btn-secondary text-xs">⬇ JSON</button>
          <button v-if="report?.status === 'done'" @click="exportFile('csv')"
                  class="btn-secondary text-xs">⬇ CSV</button>
        </div>
      </div>

      <!-- Loading / Error -->
      <div v-if="initialLoad" class="card text-center py-10 text-gray-500 text-sm">Загрузка...</div>
      <div v-else-if="loadError"
           class="card border-red-800 bg-red-900/20 text-red-300 text-sm">
        ⚠ {{ loadError }}
      </div>

      <!-- В процессе -->
      <div v-else-if="report && report.status !== 'done' && report.status !== 'error'"
           class="card text-center py-10">
        <div class="text-4xl mb-2 animate-pulse">⏳</div>
        <div class="text-gray-300 font-semibold">{{ statusLabel(report.status) }}</div>
        <div class="text-xs text-gray-500 mt-1">{{ report.current_stage || '...' }}</div>
        <div class="text-xs text-gray-600 mt-3">Страница обновляется автоматически.</div>
      </div>

      <!-- Ошибка -->
      <div v-else-if="report?.status === 'error'"
           class="card border-red-800 bg-red-900/20">
        <div class="text-red-300 font-semibold mb-1">⚠ Ошибка обработки</div>
        <div class="text-red-200 text-sm whitespace-pre-wrap">{{ report.error_message || 'Неизвестная ошибка' }}</div>
      </div>

      <!-- ── Готовый отчёт ── -->
      <template v-else-if="report?.status === 'done'">

        <!-- Stats summary -->
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-white">{{ stats.parsed_doc_count || 0 }}<span class="text-gray-500 text-base">/{{ stats.doc_count || 0 }}</span></div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Документов</div>
          </div>
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-indigo-300">{{ (stats.total_tokens || 0).toLocaleString('ru-RU') }}</div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Токенов</div>
          </div>
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-sky-300">{{ Math.round(stats.avg_doc_length || 0) }}</div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Сред. длина</div>
          </div>
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-emerald-300">{{ vocabulary.length }}</div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Лемм в словаре</div>
          </div>
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-fuchsia-300">{{ ngrams.length }}</div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">N-грамм</div>
          </div>
        </div>

        <!-- ── PR3: Сравнение «наш сайт vs ТОП» ── -->
        <div v-if="comparison && !comparison.error" class="card border-indigo-700/50">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-2">
              ⚖ Сравнение: ваш сайт vs ТОП конкурентов
            </h2>
            <a v-if="ourReport?.url" :href="ourReport.url" target="_blank" rel="noopener"
               class="text-xs text-indigo-300 hover:text-indigo-200 underline truncate max-w-[400px]">
              {{ ourReport.url }}
            </a>
          </div>

          <!-- Сводка: 4 числа + подсказки -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div class="rounded bg-gray-950 border border-gray-800 p-3 text-center">
              <div class="text-2xl font-bold text-emerald-300">
                {{ (comparison.summary?.lsi_coverage_pct ?? 0).toFixed(1) }}%
              </div>
              <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">LSI-покрытие</div>
              <div class="text-[10px] text-gray-600 mt-0.5">
                {{ comparison.summary?.important_lemmas_hit || 0 }} из
                {{ comparison.summary?.important_lemmas_total || 0 }} важных
              </div>
              <div class="text-[9px] text-gray-600 mt-0.5 italic">
                считается только по важным LSI
              </div>
            </div>
            <div class="rounded bg-gray-950 border border-gray-800 p-3 text-center">
              <div class="text-2xl font-bold text-sky-300">
                {{ (comparison.summary?.bm25_score ?? 0).toFixed(2) }}
              </div>
              <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">BM25 vs ТОП</div>
              <div class="text-[10px] text-gray-600 mt-0.5">
                норм. {{ ((comparison.summary?.bm25_score_norm ?? 0) * 100).toFixed(0) }}%
              </div>
            </div>
            <div class="rounded bg-gray-950 border border-gray-800 p-3 text-center">
              <div class="text-2xl font-bold text-fuchsia-300">
                {{ (comparison.summary?.tf_idf_cosine ?? 0).toFixed(3) }}
              </div>
              <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">TF-IDF cosine</div>
              <div class="text-[10px] text-gray-600 mt-0.5">с медианой ТОПа</div>
            </div>
            <div class="rounded bg-gray-950 border border-gray-800 p-3 text-center">
              <div class="text-2xl font-bold text-amber-300">
                {{ ((comparison.summary?.our_text_html_ratio ?? 0) * 100).toFixed(1) }}%
              </div>
              <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Text/HTML ratio</div>
              <div class="text-[10px] text-gray-600 mt-0.5">
                ТОП медиана:
                {{ ((comparison.summary?.median_text_html_ratio_top ?? 0) * 100).toFixed(1) }}%
              </div>
            </div>
          </div>

          <!-- Сводная таблица «ТОП-N + наш сайт» с сортировкой -->
          <div v-if="compTable.length > 0" class="mb-5">
            <h3 class="text-xs font-bold text-gray-300 uppercase tracking-wider mb-2">
              📊 Сравнительная таблица
              <span class="text-[10px] text-gray-500 font-normal normal-case ml-1">
                (наш сайт — ★, участвует в рейтинге наравне с конкурентами)
              </span>
            </h3>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead class="text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                  <tr>
                    <th class="text-right py-2 px-2 w-8">#</th>
                    <th class="text-left py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('url')">URL</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('serp_position')" title="Позиция в выдаче Яндекса">Поз.</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('lsi_coverage_pct')">LSI %</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('bm25_score')">BM25</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('tf_idf_cosine')">TF-IDF cos</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('text_chars')" title="Длина основного текста (символы)">Симв.</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('word_count')" title="Сырое число словоформ (без учёта лемматизации)">Слов</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('tokens')" title="Лемм после нормализации (BM25-токены)">Лемм</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in compTable" :key="row.url + ':' + i"
                      :class="row.is_ours
                        ? 'bg-indigo-900/30 border-b border-indigo-800/50'
                        : 'border-b border-gray-800/60 hover:bg-gray-900/40'">
                    <td class="text-right py-1.5 px-2 text-gray-500 tabular-nums font-bold">{{ i + 1 }}</td>
                    <td class="py-1.5 px-2">
                      <span v-if="row.is_ours" class="text-indigo-300 font-bold mr-1">★ ВЫ:</span>
                      <a :href="row.url" target="_blank" rel="noopener"
                         class="text-gray-200 hover:text-indigo-300 truncate inline-block max-w-[360px] align-middle"
                         :title="row.url">{{ row.url }}</a>
                    </td>
                    <td class="text-right py-1.5 px-2 tabular-nums"
                        :class="row.serp_position == null ? 'text-gray-600' : 'text-amber-300'">
                      <span v-if="row.serp_position != null">#{{ row.serp_position }}</span>
                      <span v-else title="URL не найден в ТОП-выдаче Яндекса">—</span>
                    </td>
                    <td class="text-right py-1.5 px-2 text-emerald-300 tabular-nums">
                      {{ (row.lsi_coverage_pct ?? 0).toFixed(1) }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-sky-300 tabular-nums">
                      {{ (row.bm25_score ?? 0).toFixed(2) }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-fuchsia-300 tabular-nums">
                      {{ (row.tf_idf_cosine ?? 0).toFixed(3) }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-gray-300 tabular-nums">
                      {{ (row.text_chars || 0).toLocaleString('ru-RU') }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-gray-300 tabular-nums">
                      {{ (row.word_count || 0).toLocaleString('ru-RU') }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-gray-400 tabular-nums">
                      {{ row.tokens || 0 }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="text-[10px] text-gray-600 mt-2 leading-relaxed">
              «Симв.» — длина основного текста, «Слов» — сырое число словоформ
              (с латиницей и цифрами), «Лемм» — нормализованные токены, идущие
              в BM25 (короткие слова, стоп-слова и не-кириллица отфильтрованы).
            </div>
          </div>

          <!-- Математические директивы для копирайтера -->
          <div v-if="(comparison.directives || []).length > 0" class="mb-5">
            <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h3 class="text-xs font-bold text-gray-300 uppercase tracking-wider">
                ✍ Что делать (математические директивы)
              </h3>
              <div class="flex items-center gap-1 text-[11px]">
                <button class="btn-ghost"
                        :class="directiveFilter === 'important' ? 'text-indigo-300' : 'text-gray-500'"
                        @click="directiveFilter = 'important'"
                        title="Только важные LSI (★) — приоритетные правки">
                  ★ Важные ({{ directivesImportantCount }})
                </button>
                <button class="btn-ghost"
                        :class="directiveFilter === 'additional' ? 'text-indigo-300' : 'text-gray-500'"
                        @click="directiveFilter = 'additional'"
                        title="Менее приоритетные — после того как важные закрыты">
                  · Менее важные ({{ directivesAdditionalCount }})
                </button>
                <button class="btn-ghost"
                        :class="directiveFilter === 'all' ? 'text-indigo-300' : 'text-gray-500'"
                        @click="directiveFilter = 'all'">
                  Все ({{ comparison.directives.length }})
                </button>
              </div>
            </div>
            <ol class="space-y-1 text-xs">
              <li v-for="(d, i) in directivesVisible.slice(0, 100)" :key="d.lemma + ':' + i"
                  :class="['flex items-start gap-2 py-1 px-2 rounded',
                           d.important ? 'hover:bg-indigo-900/20' : 'hover:bg-gray-900/40']">
                <span class="text-gray-500 tabular-nums w-6 flex-shrink-0 text-right">{{ i + 1 }}.</span>
                <span :class="['badge text-[10px] px-1.5 py-0', statusColor(d.status)]">{{ d.status }}</span>
                <span v-if="d.important" class="text-[10px] text-indigo-300 font-bold" title="Important LSI-key">★</span>
                <span class="text-gray-200">{{ d.text }}</span>
              </li>
            </ol>
            <div v-if="directivesVisible.length > 100" class="text-[11px] text-gray-500 mt-2">
              … и ещё {{ directivesVisible.length - 100 }} директив (см. подсветку слов ниже).
            </div>
            <div v-if="directivesVisible.length === 0" class="text-[11px] text-gray-500 mt-2 italic">
              Нет директив по выбранному фильтру.
            </div>
          </div>

          <!-- Подсветка слов: per-term gap-таблица -->
          <div v-if="(comparison.per_term || []).length > 0">
            <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h3 class="text-xs font-bold text-gray-300 uppercase tracking-wider">
                🎨 Подсветка слов (per-term gap) — {{ gapVisible.length }}
              </h3>
              <div class="flex items-center gap-1 text-[11px] flex-wrap">
                <button v-for="opt in ['actionable','all','missing','under','ok','over']" :key="opt"
                        class="btn-ghost"
                        :class="gapFilter === opt ? 'text-indigo-300' : 'text-gray-500'"
                        @click="gapFilter = opt">{{ opt }}</button>
              </div>
            </div>
            <div class="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                  <tr>
                    <th class="text-left py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(gapSort, 'lemma')">Лемма {{ sortArrow(gapSort, 'lemma') }}</th>
                    <th class="text-center py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(gapSort, 'status')">Статус {{ sortArrow(gapSort, 'status') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(gapSort, 'our_count')">У вас {{ sortArrow(gapSort, 'our_count') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(gapSort, 'median_top')">Медиана ТОПа {{ sortArrow(gapSort, 'median_top') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(gapSort, 'df')">DF {{ sortArrow(gapSort, 'df') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(gapSort, 'bm25_score')">BM25 {{ sortArrow(gapSort, 'bm25_score') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in gapPaged" :key="t.lemma"
                      class="border-b border-gray-800/40 hover:bg-gray-900/30">
                    <td class="py-1 px-2 text-gray-200">
                      <span v-if="t.important" class="text-indigo-300 mr-0.5" title="Important LSI">★</span>
                      {{ t.lemma }}
                    </td>
                    <td class="text-center py-1 px-2">
                      <span :class="['badge text-[10px] px-1.5 py-0', statusColor(t.status)]">{{ t.status }}</span>
                    </td>
                    <td class="text-right py-1 px-2 text-gray-300 tabular-nums">{{ t.our_count }}</td>
                    <td class="text-right py-1 px-2 text-gray-400 tabular-nums">{{ t.median_top }}</td>
                    <td class="text-right py-1 px-2 text-gray-500 tabular-nums">{{ t.df }}</td>
                    <td class="text-right py-1 px-2 text-sky-300 tabular-nums">{{ (t.bm25_score || 0).toFixed(2) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="gapVisible.length === 0" class="text-gray-500 text-sm py-4 text-center">
                Нет лемм по выбранному фильтру.
              </div>
            </div>
            <!-- Pager -->
            <div v-if="gapVisible.length > 0" class="flex items-center justify-between mt-2 text-[11px] text-gray-400 flex-wrap gap-2">
              <div>
                {{ gapPageStart + 1 }}–{{ Math.min(gapPageStart + gapPageSize, gapVisible.length) }}
                из <span class="text-gray-300">{{ gapVisible.length }}</span>
              </div>
              <div class="flex items-center gap-1">
                <label class="text-gray-500">На странице:
                  <select v-model.number="gapPageSize"
                          class="ml-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                    <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</option>
                  </select>
                </label>
                <button class="btn-ghost px-2" :disabled="gapPage <= 1"
                        @click="gotoPage(gapPage - 1, gapVisible.length, gapPageSize, (v) => gapPage = v)">←</button>
                <span class="tabular-nums">
                  стр.
                  <input type="number" min="1" :max="gapPageCount"
                         :value="Math.min(gapPage, gapPageCount)"
                         @change="(e) => gotoPage(Number(e.target.value), gapVisible.length, gapPageSize, (v) => gapPage = v)"
                         class="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-gray-200 text-center" />
                  / {{ gapPageCount }}
                </span>
                <button class="btn-ghost px-2" :disabled="gapPage >= gapPageCount"
                        @click="gotoPage(gapPage + 1, gapVisible.length, gapPageSize, (v) => gapPage = v)">→</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Если comparison был запрошен, но упал — показываем мягкую ошибку -->
        <div v-else-if="comparison && comparison.error" class="card border-amber-800/60 bg-amber-900/10">
          <h2 class="text-base font-bold text-amber-300 uppercase tracking-wider mb-2">
            ⚠ Сравнение «ваш сайт vs ТОП» не выполнилось
          </h2>
          <div class="text-amber-200 text-sm">{{ comparison.error }}</div>
          <div class="text-[11px] text-amber-300/70 mt-2">
            Отчёт ТОПа сохранён полностью — это «мягкая» ошибка только нашего URL.
            Попробуйте проверить, открывается ли страница в браузере без авторизации
            и не блокирует ли её WAF (Cloudflare/Qrator) для серверных запросов.
          </div>
        </div>

        <!-- Сводка причин fail'а — оператор сразу видит, где WAF/SPA/DNS -->
        <div v-if="failBreakdownEntries.length > 0" class="card">
          <h3 class="text-xs font-bold text-gray-300 uppercase tracking-wider mb-2">
            📉 Причины недоступности страниц ТОПа
          </h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="[code, count] in failBreakdownEntries" :key="code"
                  class="text-xs px-2 py-1 rounded bg-gray-950 border border-gray-800">
              <span class="text-gray-400 font-mono">{{ code }}</span>
              <span class="text-amber-300 font-bold ml-1">×{{ count }}</span>
            </span>
          </div>
          <div v-if="filterInfo?.removed_aggregators?.length"
               class="text-[11px] text-gray-500 mt-3">
            Также отфильтровано как агрегаторы:
            <span class="text-gray-400">{{ filterInfo.removed_aggregators.length }}</span>
            (<span class="font-mono">{{ filterInfo.removed_aggregators.slice(0,5).map(r => r.host).join(', ') }}{{ filterInfo.removed_aggregators.length > 5 ? '…' : '' }}</span>)
          </div>
        </div>

        <!-- ── Multi-series chart: ТОП-20 по частоте + наш сайт + Ципф ── -->
        <div class="card">
          <div class="flex items-baseline justify-between flex-wrap gap-2 mb-3">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              📈 ТОП-20 слов: медиана ТОПа · наш сайт · закон Ципфа
            </h2>
            <div v-if="topChartData" class="text-[11px] text-gray-500">
              Zipf: f(rank) ≈
              <span class="text-gray-300 tabular-nums">{{ topChartData.zipf_C.toFixed(2) }}</span>
              / rank<sup>{{ topChartData.zipf_s.toFixed(2) }}</sup>
            </div>
          </div>
          <div v-if="!topChartData" class="text-gray-500 text-sm py-4 text-center">
            Нет данных для построения графика.
          </div>
          <div v-else>
            <!-- Легенда -->
            <div class="flex items-center gap-4 text-[11px] text-gray-400 mb-2 flex-wrap">
              <span class="flex items-center gap-1.5">
                <span class="inline-block w-3 h-3 rounded-sm bg-sky-500/80"></span>
                Медиана ТОПа (по корпусу)
              </span>
              <span v-if="topChartData.hasComparison" class="flex items-center gap-1.5">
                <span class="inline-block w-3 h-3 rounded-sm bg-emerald-500/80"></span>
                Ваш сайт (фактические вхождения)
              </span>
              <span class="flex items-center gap-1.5">
                <span class="inline-block w-3 h-3 rounded-sm border-2 border-fuchsia-400"></span>
                Закон Ципфа (теоретическая кривая)
              </span>
            </div>
            <!-- Сам график: SVG со столбиками (median + our) и линией Zipf -->
            <div class="overflow-x-auto">
              <svg :viewBox="`0 0 ${40 + topChartData.n * 44} 240`"
                   :width="40 + topChartData.n * 44"
                   height="260"
                   class="block">
                <!-- сетка Y -->
                <g v-for="(yv, i) in [0, 0.25, 0.5, 0.75, 1]" :key="'g' + i">
                  <line :x1="32" :x2="40 + topChartData.n * 44 - 8"
                        :y1="200 - 180 * yv" :y2="200 - 180 * yv"
                        stroke="#1f2937" stroke-width="1" stroke-dasharray="3,3" />
                  <text :x="28" :y="200 - 180 * yv + 4" text-anchor="end"
                        class="fill-gray-500" style="font-size:9px">
                    {{ Math.round(yv * topChartData.yMax) }}
                  </text>
                </g>
                <!-- столбики и линия -->
                <g v-for="(label, i) in topChartData.labels" :key="label">
                  <!-- median bar -->
                  <rect :x="40 + i * 44 + 4" :y="200 - 180 * (topChartData.median[i] / topChartData.yMax)"
                        :width="14" :height="180 * (topChartData.median[i] / topChartData.yMax)"
                        class="fill-sky-500/80">
                    <title>{{ label }} · медиана ТОПа: {{ topChartData.median[i] }}</title>
                  </rect>
                  <!-- our bar -->
                  <rect v-if="topChartData.hasComparison"
                        :x="40 + i * 44 + 22" :y="200 - 180 * (topChartData.our[i] / topChartData.yMax)"
                        :width="14" :height="180 * (topChartData.our[i] / topChartData.yMax)"
                        class="fill-emerald-500/80">
                    <title>{{ label }} · ваш сайт: {{ topChartData.our[i] }}</title>
                  </rect>
                  <!-- xtick label -->
                  <text :x="40 + i * 44 + 22" :y="220"
                        text-anchor="end"
                        :transform="`rotate(-50, ${40 + i * 44 + 22}, 220)`"
                        class="fill-gray-400" style="font-size:10px">
                    {{ label }}
                  </text>
                </g>
                <!-- Zipf curve (через точки центра баров) -->
                <polyline
                  fill="none"
                  stroke="#e879f9"
                  stroke-width="2"
                  stroke-dasharray="4,3"
                  :points="topChartData.zipf.map((y, i) =>
                    `${40 + i * 44 + 22},${200 - 180 * Math.min(1, y / topChartData.yMax)}`
                  ).join(' ')" />
                <!-- точки на кривой Zipf -->
                <circle v-for="(y, i) in topChartData.zipf" :key="'z' + i"
                        :cx="40 + i * 44 + 22"
                        :cy="200 - 180 * Math.min(1, y / topChartData.yMax)"
                        r="3"
                        class="fill-fuchsia-400">
                  <title>{{ topChartData.labels[i] }} · Zipf: {{ y.toFixed(2) }}</title>
                </circle>
              </svg>
            </div>
            <p class="text-[10px] text-gray-500 mt-2 italic">
              Чем ближе зелёные столбики (ваш сайт) к синим (медиана ТОПа) и к
              фиолетовой кривой Ципфа — тем естественнее распределение частот
              у вас. Сильные провалы зелёного по топ-1…топ-5 — сигнал нарастить
              «ядро» темы.
            </p>
          </div>
        </div>

        <!-- ── Word cloud (spiral, в центре — топ-1 BM25) ── -->
        <div class="card">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider mb-3">
            ☁ Облако слов (центр — главное слово; размер ∝ BM25)
          </h2>
          <div v-if="cloud.boxes.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет слов с положительным BM25-весом.
          </div>
          <div v-else class="bg-gray-950 rounded overflow-hidden flex justify-center">
            <svg :viewBox="`0 0 ${cloud.width} ${cloud.height}`"
                 :width="cloud.width" :height="cloud.height"
                 preserveAspectRatio="xMidYMid meet"
                 class="max-w-full h-auto">
              <text v-for="b in cloud.boxes" :key="b.lemma"
                    :x="b.cx" :y="b.cy"
                    :font-size="b.size"
                    :fill="b.color"
                    :font-weight="b.is_center ? 800 : 600"
                    text-anchor="middle"
                    dominant-baseline="middle"
                    style="cursor: default; font-family: Inter, system-ui, sans-serif">
                <title>{{ b.title }}</title>
                {{ b.lemma }}
              </text>
            </svg>
          </div>
        </div>

        <!-- ── Таблица 1: LSI словарь (BM25 + TF-IDF) ── -->
        <div class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              📑 Словарь LSI (BM25 + TF-IDF) — {{ vocabFiltered.length }} лемм
            </h2>
            <div class="flex items-center gap-1 text-xs flex-wrap">
              <button class="btn-ghost"
                      :class="vocabFilter === 'all' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'all'">Все</button>
              <button class="btn-ghost"
                      :class="vocabFilter === 'important' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'important'">Важное</button>
              <button class="btn-ghost"
                      :class="vocabFilter === 'additional' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'additional'">Доп</button>
              <span class="mx-1 text-gray-700">·</span>
              <button class="btn-ghost text-emerald-300"
                      @click="copyImportantLsi" title="Скопировать только важные леммы">
                📋 Важные
              </button>
              <button class="btn-ghost text-sky-300"
                      @click="copyFilteredVocab" title="Скопировать видимые в таблице">
                📋 Видимые
              </button>
              <button class="btn-ghost text-gray-400"
                      @click="copyAllLsi" title="Скопировать все леммы">
                📋 Все
              </button>
            </div>
          </div>
          <div v-if="vocabFiltered.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет лемм по выбранному фильтру.
          </div>
          <div v-else>
            <div class="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                  <tr>
                    <th class="text-left py-2 px-2 w-10">#</th>
                    <th class="text-left py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(vocabSort, 'lemma')">Лемма {{ sortArrow(vocabSort, 'lemma') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(vocabSort, 'df')">DF (сайтов) {{ sortArrow(vocabSort, 'df') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(vocabSort, 'median_count')">Медиана вх. {{ sortArrow(vocabSort, 'median_count') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(vocabSort, 'bm25_score')">BM25 score {{ sortArrow(vocabSort, 'bm25_score') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(vocabSort, 'tf_idf_score')">TF-IDF {{ sortArrow(vocabSort, 'tf_idf_score') }}</th>
                    <th class="text-center py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(vocabSort, 'status')">Статус {{ sortArrow(vocabSort, 'status') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(v, i) in vocabPaged" :key="v.lemma"
                      class="border-b border-gray-900 hover:bg-gray-900/50">
                    <td class="py-1.5 px-2 text-gray-500 tabular-nums">{{ vocabPageStart + i + 1 }}</td>
                    <td class="py-1.5 px-2 text-gray-100 font-medium">{{ v.lemma }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ v.df }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ v.median_count }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ Number(v.bm25_score || 0).toFixed(4) }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ Number(v.tf_idf_score || 0).toFixed(4) }}</td>
                    <td class="py-1.5 px-2 text-center">
                      <span v-if="v.status === 'important'"
                            class="inline-block px-2 py-0.5 rounded text-[10px] bg-indigo-900/50 text-indigo-300 border border-indigo-800">
                        Важное
                      </span>
                      <span v-else class="inline-block px-2 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 border border-gray-700">
                        Доп
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- Pager: LSI -->
            <div class="flex items-center justify-between mt-2 text-[11px] text-gray-400 flex-wrap gap-2">
              <div>
                {{ vocabPageStart + 1 }}–{{ Math.min(vocabPageStart + vocabPageSize, vocabFiltered.length) }}
                из <span class="text-gray-300">{{ vocabFiltered.length }}</span>
              </div>
              <div class="flex items-center gap-1">
                <label class="text-gray-500">На странице:
                  <select v-model.number="vocabPageSize"
                          class="ml-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                    <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</option>
                  </select>
                </label>
                <button class="btn-ghost px-2" :disabled="vocabPage <= 1"
                        @click="gotoPage(vocabPage - 1, vocabFiltered.length, vocabPageSize, (v) => vocabPage = v)">←</button>
                <span class="tabular-nums">
                  стр.
                  <input type="number" min="1" :max="vocabPageCount"
                         :value="Math.min(vocabPage, vocabPageCount)"
                         @change="(e) => gotoPage(Number(e.target.value), vocabFiltered.length, vocabPageSize, (v) => vocabPage = v)"
                         class="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-gray-200 text-center" />
                  / {{ vocabPageCount }}
                </span>
                <button class="btn-ghost px-2" :disabled="vocabPage >= vocabPageCount"
                        @click="gotoPage(vocabPage + 1, vocabFiltered.length, vocabPageSize, (v) => vocabPage = v)">→</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Таблица 2: N-граммы ── -->
        <div class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              🔗 N-граммы — {{ ngramsFiltered.length }} фраз
              <span class="text-[10px] text-gray-500 font-normal normal-case ml-1">
                (показаны фразы, встретившиеся у ≥ 40% сайтов)
              </span>
            </h2>
            <div class="flex items-center gap-1 text-xs flex-wrap">
              <button class="btn-ghost"
                      :class="ngramFilter === 'all' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'all'">Все</button>
              <button class="btn-ghost"
                      :class="ngramFilter === 'bigram' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'bigram'">Биграммы</button>
              <button class="btn-ghost"
                      :class="ngramFilter === 'trigram' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'trigram'">Триграммы</button>
              <button class="btn-ghost"
                      :class="ngramFilter === '4gram' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = '4gram'">4-граммы</button>
              <span class="mx-1 text-gray-700">·</span>
              <button class="btn-ghost text-emerald-300"
                      @click="copyImportantNgrams" title="Скопировать наиболее частые n-граммы">
                📋 Важные
              </button>
              <button class="btn-ghost text-sky-300"
                      @click="copyFilteredNgrams" title="Скопировать видимые в таблице">
                📋 Видимые
              </button>
              <button class="btn-ghost text-gray-400"
                      @click="copyAllNgrams" title="Скопировать все n-граммы">
                📋 Все
              </button>
            </div>
          </div>
          <div v-if="ngramsFiltered.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет n-грамм по выбранному фильтру.
          </div>
          <div v-else>
            <div class="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                  <tr>
                    <th class="text-left py-2 px-2 w-10">#</th>
                    <th class="text-left py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(ngramSort, 'phrase')">Фраза {{ sortArrow(ngramSort, 'phrase') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(ngramSort, 'df')">DF (сайтов) {{ sortArrow(ngramSort, 'df') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(ngramSort, 'df_share_pct')"
                        title="Доля сайтов из ТОПа (порог = 40%)">% сайтов {{ sortArrow(ngramSort, 'df_share_pct') }}</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(ngramSort, 'median_count')">Медиана вх. {{ sortArrow(ngramSort, 'median_count') }}</th>
                    <th class="text-center py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(ngramSort, 'type')">Тип {{ sortArrow(ngramSort, 'type') }}</th>
                    <th class="text-center py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="toggleSort(ngramSort, 'pos_pattern')">POS {{ sortArrow(ngramSort, 'pos_pattern') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(n, i) in ngramsPaged" :key="n.phrase + ':' + n.type"
                      class="border-b border-gray-900 hover:bg-gray-900/50">
                    <td class="py-1.5 px-2 text-gray-500 tabular-nums">{{ ngramsPageStart + i + 1 }}</td>
                    <td class="py-1.5 px-2 text-gray-100 font-medium">{{ n.phrase }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ n.df }}</td>
                    <td class="py-1.5 px-2 text-right text-emerald-300 tabular-nums">{{ Number(n.df_share_pct || 0).toFixed(1) }}%</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ n.median_count }}</td>
                    <td class="py-1.5 px-2 text-center">
                      <span :class="{
                              'text-sky-300':    n.type === 'bigram',
                              'text-fuchsia-300':n.type === 'trigram',
                              'text-amber-300':  n.type === '4gram',
                            }"
                            class="text-[10px] uppercase">
                        {{ n.type === 'bigram' ? 'Би' : (n.type === 'trigram' ? 'Три' : '4-гр') }}
                      </span>
                    </td>
                    <td class="py-1.5 px-2 text-center text-gray-500 text-[10px]">{{ n.pos_pattern }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- Pager: N-grams -->
            <div class="flex items-center justify-between mt-2 text-[11px] text-gray-400 flex-wrap gap-2">
              <div>
                {{ ngramsPageStart + 1 }}–{{ Math.min(ngramsPageStart + ngramPageSize, ngramsFiltered.length) }}
                из <span class="text-gray-300">{{ ngramsFiltered.length }}</span>
              </div>
              <div class="flex items-center gap-1">
                <label class="text-gray-500">На странице:
                  <select v-model.number="ngramPageSize"
                          class="ml-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                    <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</option>
                  </select>
                </label>
                <button class="btn-ghost px-2" :disabled="ngramPage <= 1"
                        @click="gotoPage(ngramPage - 1, ngramsFiltered.length, ngramPageSize, (v) => ngramPage = v)">←</button>
                <span class="tabular-nums">
                  стр.
                  <input type="number" min="1" :max="ngramsPageCount"
                         :value="Math.min(ngramPage, ngramsPageCount)"
                         @change="(e) => gotoPage(Number(e.target.value), ngramsFiltered.length, ngramPageSize, (v) => ngramPage = v)"
                         class="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-gray-200 text-center" />
                  / {{ ngramsPageCount }}
                </span>
                <button class="btn-ghost px-2" :disabled="ngramPage >= ngramsPageCount"
                        @click="gotoPage(ngramPage + 1, ngramsFiltered.length, ngramPageSize, (v) => ngramPage = v)">→</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Семантические коконы (PR 2) ── -->
        <div class="card">
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 class="text-lg font-bold text-purple-300">🧬 Семантические коконы</h2>
              <p class="text-xs text-gray-400 mt-1">
                Группировка лемм по латентным темам ниши (Truncated SVD / LSI).
                Положительные веса — «о теме», отрицательные (серым) — антитема,
                которую копирайтеру стоит избегать в этом разделе.
              </p>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <span v-if="report.has_raw" class="badge bg-emerald-900/40 text-emerald-300 border border-emerald-800">
                📦 raw-кэш активен
                <span v-if="formatRawTtl(report)" class="ml-1 text-emerald-400/70">
                  · ещё {{ formatRawTtl(report).label }}
                </span>
              </span>
              <span v-else class="badge bg-gray-800 text-gray-400 border border-gray-700">
                🧊 raw-кэш истёк
              </span>
              <button v-if="report.has_raw" @click="deleteRawCache"
                      class="text-xs text-rose-400 hover:text-rose-300 underline">
                удалить кэш
              </button>
            </div>
          </div>

          <div v-if="report.has_raw" class="mt-3 flex items-center gap-2 flex-wrap">
            <label class="text-xs text-gray-400">Тем:
              <input type="number" v-model.number="cocoonsOpts.n_topics" min="2" max="32"
                     class="ml-1 w-16 bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-xs" />
            </label>
            <label class="text-xs text-gray-400">Лемм/тему:
              <input type="number" v-model.number="cocoonsOpts.top_terms" min="3" max="50"
                     class="ml-1 w-16 bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-xs" />
            </label>
            <button @click="buildCocoons"
                    :disabled="cocoonsBuilding"
                    class="btn-primary text-xs disabled:opacity-50">
              {{ cocoonsBuilding ? 'Строим…' : (cocoons ? 'Пересчитать коконы' : 'Построить коконы') }}
            </button>
          </div>

          <div v-if="cocoonsError" class="mt-2 text-rose-400 text-xs">{{ cocoonsError }}</div>

          <div v-if="cocoonsTopics.length > 0" class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div v-for="t in cocoonsTopics" :key="t.id"
                 class="bg-gray-900/60 border border-gray-800 rounded-lg p-3">
              <div class="flex items-baseline justify-between gap-2 mb-2">
                <div class="text-purple-300 font-semibold truncate" :title="t.label">
                  #{{ t.id + 1 }} · {{ t.label }}
                </div>
                <div class="text-[10px] text-gray-500 flex-shrink-0">
                  {{ (t.explained_variance * 100).toFixed(1) }}%
                </div>
              </div>
              <div class="flex flex-wrap gap-1.5 mb-2">
                <span v-for="term in t.terms" :key="term.lemma"
                      class="px-1.5 py-0.5 rounded border leading-tight"
                      :style="chipStyle(term, t)"
                      :title="`weight: ${term.weight}`">
                  {{ term.lemma }}
                </span>
              </div>
              <details v-if="t.top_documents?.length" class="text-[11px] text-gray-400 mt-1">
                <summary class="cursor-pointer hover:text-gray-200">
                  топ-документы ({{ t.top_documents.length }})
                </summary>
                <ul class="mt-1.5 space-y-0.5">
                  <li v-for="d in t.top_documents" :key="d.url" class="truncate">
                    <a :href="d.url" target="_blank" rel="noopener noreferrer"
                       class="text-sky-400 hover:underline break-all">{{ d.url }}</a>
                    <span class="text-gray-600 ml-1">{{ d.score.toFixed(3) }}</span>
                  </li>
                </ul>
              </details>
            </div>
          </div>
          <div v-else-if="cocoons" class="mt-3 text-xs text-amber-400">
            ⚠ SVD не нашёл тем (вероятно, слишком мало уникальных лемм или
            однообразный корпус — попробуйте увеличить диапазон ТОП SERP).
          </div>
          <div v-else-if="!report.has_raw" class="mt-3 text-xs text-gray-500">
            Для расчёта коконов нужны processed-документы из Redis-кэша.
            После истечения TTL (7 дней по умолчанию) пересчёт невозможен —
            создайте новый отчёт.
          </div>
        </div>

        <!-- ── (7) LSI теговой зоны (header/footer/sidemenu) ── -->
        <div v-if="tagZoneVocab.length > 0" class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              🧱 LSI теговой зоны (шапка / подвал / сквозное меню) — {{ tagZoneVocab.length }} лемм
            </h2>
            <div class="flex items-center gap-1 text-xs flex-wrap">
              <button class="btn-ghost text-sky-300" @click="copyTagZone"
                      title="Скопировать леммы теговой зоны">📋 Скопировать</button>
            </div>
          </div>
          <p class="text-[11px] text-gray-500 mb-2">
            Леммы, которые конкуренты выводят в шапке/подвале/сквозном меню сайта
            (BM25-словарь по «теговой» зоне отдельно от основного контента). Колонка
            «У вас в тег.зоне» показывает, есть ли эта лемма в шапке/подвале вашего сайта.
          </p>
          <div class="overflow-x-auto max-h-[50vh] overflow-y-auto border border-gray-800 rounded">
            <table class="w-full text-xs">
              <thead class="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                <tr>
                  <th class="text-left py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(tagZoneSort, 'lemma')">Лемма {{ sortArrow(tagZoneSort, 'lemma') }}</th>
                  <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(tagZoneSort, 'df')">DF {{ sortArrow(tagZoneSort, 'df') }}</th>
                  <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(tagZoneSort, 'median_count')">Медиана {{ sortArrow(tagZoneSort, 'median_count') }}</th>
                  <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(tagZoneSort, 'bm25_score')">BM25 {{ sortArrow(tagZoneSort, 'bm25_score') }}</th>
                  <th class="text-center py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(tagZoneSort, 'status')">Статус {{ sortArrow(tagZoneSort, 'status') }}</th>
                  <th class="text-center py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(tagZoneSort, 'in_our_tag_zone')">У вас {{ sortArrow(tagZoneSort, 'in_our_tag_zone') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="t in tagZoneSorted" :key="t.lemma"
                    class="border-b border-gray-900 hover:bg-gray-900/50">
                  <td class="py-1.5 px-2 text-gray-100 font-medium">{{ t.lemma }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ t.df }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ t.median_count }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ Number(t.bm25_score || 0).toFixed(3) }}</td>
                  <td class="py-1.5 px-2 text-center">
                    <span v-if="t.status === 'important'"
                          class="inline-block px-2 py-0.5 rounded text-[10px] bg-indigo-900/50 text-indigo-300 border border-indigo-800">Важное</span>
                    <span v-else class="inline-block px-2 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 border border-gray-700">Доп</span>
                  </td>
                  <td class="py-1.5 px-2 text-center">
                    <span v-if="t.in_our_tag_zone" class="text-emerald-400" title="есть в шапке/подвале вашего сайта">✓</span>
                    <span v-else class="text-rose-400" title="отсутствует у вашего сайта">✗</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── (13) Wave 1: SEO-сигналы из утечек Google/Yandex ── -->
        <div v-if="competitorSignals && (competitorSignals.doc_count || 0) > 0" class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-fuchsia-300 uppercase tracking-wider">
              🎯 Сигналы топа (утечки Google / Yandex) — {{ competitorSignals.doc_count }} страниц
            </h2>
          </div>
          <p class="text-[11px] text-gray-500 mb-3">
            Wave 1: HTML-сигналы из утечек Google Content Warehouse (май 2024) и
            Яндекс (январь 2023, 1922 фактора). Чеклист для writer/audit-стадий.
            Эмбеддинги, NER, PAA-mining (Wave 2/3) добавятся отдельно.
          </p>

          <!-- Наш сайт vs медиана топа -->
          <div v-if="ourVsTopGaps.length > 0" class="mb-4">
            <h3 class="text-xs font-bold text-amber-300 uppercase tracking-wider mb-2">
              📊 Наш сайт vs медиана топа
            </h3>
            <div class="overflow-x-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="text-[10px] text-gray-500 uppercase border-b border-gray-800 bg-gray-900">
                  <tr>
                    <th class="text-left py-2 px-2">Метрика</th>
                    <th class="text-right py-2 px-2">У нас</th>
                    <th class="text-right py-2 px-2">Медиана топа</th>
                    <th class="text-center py-2 px-2">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="g in ourVsTopGaps" :key="g.label" class="border-b border-gray-900">
                    <td class="py-1.5 px-2 text-gray-100">{{ g.label }}</td>
                    <td class="py-1.5 px-2 text-right tabular-nums"
                        :class="g.gap === 'under' ? 'text-rose-300' : g.gap === 'over' ? 'text-amber-300' : 'text-emerald-300'">
                      {{ Number(g.our).toFixed(1) }}
                    </td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ Number(g.top).toFixed(1) }}</td>
                    <td class="py-1.5 px-2 text-center">
                      <span v-if="g.gap === 'under'" class="text-rose-400" title="Отстаём от медианы топа">▼ ниже</span>
                      <span v-else-if="g.gap === 'over'" class="text-amber-400">▲ выше</span>
                      <span v-else class="text-emerald-400">✓ ок</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 4 колонки сводок -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 text-xs">
            <!-- Title-template -->
            <div v-if="topAggregate.title_template" class="border border-gray-800 rounded p-3">
              <div class="text-[11px] font-bold text-sky-300 uppercase tracking-wider mb-2">📝 Title-шаблон топа</div>
              <ul class="space-y-1 text-gray-300">
                <li>Длина (медиана): <b class="text-gray-100">{{ Math.round(topAggregate.title_template.title_chars_median || 0) }} симв.</b>
                  ({{ topAggregate.title_template.title_chars_min }}–{{ topAggregate.title_template.title_chars_max }})</li>
                <li>Точная фраза в title: <b class="text-gray-100">{{ Number(topAggregate.title_template.exact_query_in_title_share_pct || 0).toFixed(0) }}%</b></li>
                <li>Год в title: <b>{{ Number(topAggregate.title_template.title_has_year_share_pct || 0).toFixed(0) }}%</b></li>
                <li>Число в title: <b>{{ Number(topAggregate.title_template.title_has_number_share_pct || 0).toFixed(0) }}%</b></li>
                <li>title↔H1 совпадают: <b>{{ Number(topAggregate.title_template.title_h1_match_share_pct || 0).toFixed(0) }}%</b></li>
                <li v-if="(topAggregate.title_template.modifiers_top || []).length > 0">
                  CTR-модификаторы:
                  <span v-for="m in (topAggregate.title_template.modifiers_top || []).slice(0, 5)" :key="m.modifier"
                        class="inline-block bg-gray-800 text-emerald-300 px-1.5 py-0.5 rounded text-[10px] mr-1">
                    {{ m.modifier }} <span class="text-gray-500">{{ Number(m.share_pct).toFixed(0) }}%</span>
                  </span>
                </li>
              </ul>
            </div>

            <!-- Schema-профиль -->
            <div v-if="topAggregate.schema_profile" class="border border-gray-800 rounded p-3">
              <div class="text-[11px] font-bold text-emerald-300 uppercase tracking-wider mb-2">🏷 Schema.org-профиль</div>
              <div v-if="(topAggregate.schema_profile.mandatory || []).length > 0" class="mb-2">
                <span class="text-rose-300 text-[10px] uppercase">Обязательные:</span>
                <span v-for="t in topAggregate.schema_profile.mandatory" :key="'m-'+t"
                      class="inline-block bg-rose-900/40 border border-rose-800 text-rose-200 px-1.5 py-0.5 rounded text-[10px] ml-1">
                  {{ t }}
                </span>
              </div>
              <div v-if="(topAggregate.schema_profile.types || []).length > 0">
                <span class="text-gray-500 text-[10px] uppercase">Все встреченные:</span>
                <span v-for="r in topAggregate.schema_profile.types" :key="'t-'+r.type"
                      class="inline-block bg-gray-800 text-emerald-300 px-1.5 py-0.5 rounded text-[10px] ml-1 mt-1">
                  {{ r.type }} <span class="text-gray-500">{{ r.share_pct }}%</span>
                </span>
              </div>
              <div v-else class="text-gray-500">Schema-разметка не обнаружена в топе.</div>
            </div>

            <!-- Freshness -->
            <div v-if="topAggregate.freshness_profile" class="border border-gray-800 rounded p-3">
              <div class="text-[11px] font-bold text-cyan-300 uppercase tracking-wider mb-2">🕒 Freshness</div>
              <ul class="space-y-1 text-gray-300">
                <li>Возраст по dateModified (медиана):
                  <b class="text-gray-100">
                    {{ topAggregate.freshness_profile.median_age_modified_days !== null
                        ? topAggregate.freshness_profile.median_age_modified_days + ' дн.'
                        : '—' }}
                  </b>
                </li>
                <li>Свежих за 90 дн: <b>{{ Number(topAggregate.freshness_profile.share_fresh_90_pct || 0).toFixed(0) }}%</b></li>
                <li>Свежих за 180 дн: <b>{{ Number(topAggregate.freshness_profile.share_fresh_180_pct || 0).toFixed(0) }}%</b></li>
                <li>Свежих за 365 дн: <b>{{ Number(topAggregate.freshness_profile.share_fresh_365_pct || 0).toFixed(0) }}%</b></li>
                <li v-if="topAggregate.freshness_profile.current_year">
                  Актуальный год: <b class="text-emerald-300">{{ topAggregate.freshness_profile.current_year }}</b>
                </li>
              </ul>
            </div>

            <!-- UX-профиль -->
            <div v-if="topAggregate.ux_profile" class="border border-gray-800 rounded p-3">
              <div class="text-[11px] font-bold text-violet-300 uppercase tracking-wider mb-2">🧠 UX-профиль (NavBoost-прокси)</div>
              <ul class="space-y-1 text-gray-300">
                <li>H2 (медиана): <b class="text-gray-100">{{ topAggregate.ux_profile.h2_count_median }}</b>,
                    H3: <b>{{ topAggregate.ux_profile.h3_count_median }}</b></li>
                <li>Заголовков на 1k слов: <b>{{ topAggregate.ux_profile.headings_per_1k_words_median }}</b></li>
                <li>Длина абзаца (медиана): <b>{{ topAggregate.ux_profile.avg_paragraph_chars_median }} симв.</b></li>
                <li>До первого H2: <b>{{ topAggregate.ux_profile.above_the_fold_chars_median }} симв.</b></li>
                <li>С ToC: <b>{{ Number(topAggregate.ux_profile.share_with_toc_pct || 0).toFixed(0) }}%</b></li>
                <li>С FAQ в начале: <b>{{ Number(topAggregate.ux_profile.share_with_faq_early_pct || 0).toFixed(0) }}%</b></li>
                <li>С TL;DR: <b>{{ Number(topAggregate.ux_profile.share_with_tldr_early_pct || 0).toFixed(0) }}%</b></li>
                <li>С ALT первой картинки: <b>{{ Number(topAggregate.ux_profile.share_with_first_img_alt_pct || 0).toFixed(0) }}%</b></li>
              </ul>
            </div>

            <!-- Slug -->
            <div v-if="topAggregate.slug_pattern" class="border border-gray-800 rounded p-3">
              <div class="text-[11px] font-bold text-amber-300 uppercase tracking-wider mb-2">🔗 URL/Slug</div>
              <ul class="space-y-1 text-gray-300">
                <li>Длина slug (медиана): <b class="text-gray-100">{{ topAggregate.slug_pattern.slug_chars_median }} симв.</b></li>
                <li>Глубина URL: <b>{{ topAggregate.slug_pattern.depth_slashes_median }}</b></li>
                <li>Кириллица в URL: <b>{{ Number(topAggregate.slug_pattern.share_cyrillic_url_pct || 0).toFixed(0) }}%</b></li>
                <li>Год в URL: <b>{{ Number(topAggregate.slug_pattern.share_year_in_url_pct || 0).toFixed(0) }}%</b></li>
                <li>Slug содержит ключ: <b>{{ Number(topAggregate.slug_pattern.share_slug_has_query_pct || 0).toFixed(0) }}%</b></li>
                <li v-if="topAggregate.slug_pattern.recommendation" class="text-emerald-300 italic mt-1">
                  → {{ topAggregate.slug_pattern.recommendation }}
                </li>
              </ul>
            </div>

            <!-- Trust-link density -->
            <div v-if="topAggregate.trust_link_quota" class="border border-gray-800 rounded p-3">
              <div class="text-[11px] font-bold text-rose-300 uppercase tracking-wider mb-2">🛡 Trust-link density (Yandex hostrank)</div>
              <ul class="space-y-1 text-gray-300">
                <li>Trust-ссылок (медиана): <b class="text-gray-100">{{ topAggregate.trust_link_quota.trust_links_median }}</b></li>
                <li>Внешних ссылок (медиана): <b>{{ topAggregate.trust_link_quota.external_links_median }}</b></li>
                <li>На 1000 слов (target): <b class="text-emerald-300">{{ Number(topAggregate.trust_link_quota.per_1000_words_target || 0).toFixed(2) }}</b></li>
                <li>Доля топа с trust-ссылками: <b>{{ Number(topAggregate.trust_link_quota.share_with_any_trust_pct || 0).toFixed(0) }}%</b></li>
              </ul>
              <div class="text-[10px] text-gray-500 mt-2">
                Trust-домены: .gov / .edu / Wikipedia / ГОСТ / Минздрав / Росстат / крупные СМИ.
              </div>
            </div>

            <!-- Exact-position match -->
            <div v-if="topAggregate.exact_query_position_targets" class="border border-gray-800 rounded p-3">
              <div class="text-[11px] font-bold text-pink-300 uppercase tracking-wider mb-2">🎯 Exact-position match (Yandex FI_BCLM_*)</div>
              <ul class="space-y-1 text-gray-300">
                <li>В первых 100 словах: <b>{{ topAggregate.exact_query_position_targets.first_100_words_median }}</b></li>
                <li>В первом абзаце: <b>{{ topAggregate.exact_query_position_targets.first_paragraph_median }}</b></li>
                <li>В H2: <b>{{ topAggregate.exact_query_position_targets.in_h2_median }}</b></li>
                <li>В H3: <b>{{ topAggregate.exact_query_position_targets.in_h3_median }}</b></li>
                <li>В alt: <b>{{ topAggregate.exact_query_position_targets.in_alt_median }}</b></li>
                <li>Всего (медиана): <b>{{ topAggregate.exact_query_position_targets.total_median }}</b></li>
                <li>Density на 1000 слов (target): <b class="text-emerald-300">{{ Number(topAggregate.exact_query_position_targets.density_target || 0).toFixed(2) }}</b></li>
              </ul>
            </div>

            <!-- Host hygiene -->
            <div v-if="topAggregate.host_hygiene_checklist" class="border border-gray-800 rounded p-3">
              <div class="text-[11px] font-bold text-teal-300 uppercase tracking-wider mb-2">🧰 Host-hygiene (SEO-инфра)</div>
              <ul class="space-y-1 text-gray-300">
                <li v-for="(v, k) in (topAggregate.host_hygiene_checklist.shares_pct || {})" :key="k">
                  <span :class="v >= 50 ? 'text-emerald-300' : 'text-gray-500'">
                    {{ v >= 50 ? '✓' : '·' }}
                  </span>
                  {{ k.replace(/^has_/, '').replace(/_/g, ' ') }}:
                  <b>{{ Number(v).toFixed(0) }}%</b>
                </li>
              </ul>
              <div v-if="(topAggregate.host_hygiene_checklist.must_have || []).length > 0"
                   class="mt-2 text-[10px] text-rose-300">
                Обязательно (≥50% топа): {{ topAggregate.host_hygiene_checklist.must_have.join(', ') }}
              </div>
            </div>
          </div>

          <!-- Anchor bank -->
          <div v-if="(topAggregate.anchor_bank?.top_anchors || []).length > 0" class="mb-4">
            <h3 class="text-xs font-bold text-orange-300 uppercase tracking-wider mb-2">
              ⚓ Банк анкоров топа ({{ (topAggregate.anchor_bank.top_anchors || []).length }})
            </h3>
            <p class="text-[11px] text-gray-500 mb-2">
              Внутренние анкоры из основной зоны конкурентов — кандидаты для перелинковки.
            </p>
            <div class="flex flex-wrap gap-1">
              <span v-for="a in (topAggregate.anchor_bank.top_anchors || []).slice(0, 60)" :key="a.text"
                    class="inline-block bg-gray-800 text-orange-200 px-2 py-1 rounded text-[10px]">
                {{ a.text }} <span class="text-gray-500">×{{ a.df }}</span>
              </span>
            </div>
            <div v-if="topAggregate.anchor_bank.class_shares_pct" class="mt-2 text-[10px] text-gray-500">
              Доли: brand {{ Number(topAggregate.anchor_bank.class_shares_pct.brand || 0).toFixed(0) }}% ·
              exact {{ Number(topAggregate.anchor_bank.class_shares_pct.exact || 0).toFixed(0) }}% ·
              partial {{ Number(topAggregate.anchor_bank.class_shares_pct.partial || 0).toFixed(0) }}% ·
              generic {{ Number(topAggregate.anchor_bank.class_shares_pct.generic || 0).toFixed(0) }}%
            </div>
          </div>

          <!-- ═══════════════ Wave 2 / Wave 3 sections ═══════════════ -->
          <!-- 🎯 SERP-intent + commercial blocks (Wave 2 #9) -->
          <div v-if="topAggregate.serp_intent" class="mb-4 border border-gray-800 rounded p-3">
            <h3 class="text-xs font-bold text-pink-300 uppercase tracking-wider mb-2">
              🎯 Интент SERP (Wave 2)
            </h3>
            <p class="text-xs text-gray-300">
              Доминирующий интент: <b class="text-pink-200">{{ topAggregate.serp_intent.dominant_intent }}</b>
              · коммерческий счёт: <b>{{ Number(topAggregate.serp_intent.commercial_score || 0).toFixed(0) }}</b>
            </p>
            <div class="mt-2 text-[11px] text-gray-400">
              Распределение:
              <span v-for="(v, k) in (topAggregate.serp_intent.distribution_pct || {})" :key="k"
                    class="inline-block bg-gray-800 px-2 py-0.5 mr-1 mb-1 rounded">
                {{ k }} <b class="text-gray-200">{{ Number(v).toFixed(0) }}%</b>
              </span>
            </div>
            <div v-if="(topAggregate.commercial_blocks_required || []).length > 0"
                 class="mt-2 text-[11px] text-pink-200 bg-pink-950/40 border border-pink-900 rounded p-2">
              <b>Обязательные коммерческие блоки:</b>
              <ul class="list-disc ml-4 mt-1">
                <li v-for="b in topAggregate.commercial_blocks_required" :key="b">{{ b }}</li>
              </ul>
            </div>
          </div>

          <!-- 📋 Format winner + H2 canva (Wave 2 #10) -->
          <div v-if="topAggregate.format_winner && topAggregate.format_winner.winner !== 'unknown'"
               class="mb-4 border border-gray-800 rounded p-3">
            <h3 class="text-xs font-bold text-indigo-300 uppercase tracking-wider mb-2">
              📋 Формат-победитель (Wave 2)
            </h3>
            <p class="text-xs text-gray-300">
              <b class="text-indigo-200">{{ topAggregate.format_winner.winner }}</b>
              ({{ Number(topAggregate.format_winner.share_pct || 0).toFixed(0) }}% топа)
            </p>
            <div class="mt-2 text-[11px] text-gray-400">
              Распределение:
              <span v-for="(v, k) in (topAggregate.format_winner.distribution_pct || {})" :key="k"
                    class="inline-block bg-gray-800 px-2 py-0.5 mr-1 mb-1 rounded">
                {{ k }} <b class="text-gray-200">{{ Number(v).toFixed(0) }}%</b>
              </span>
            </div>
            <div v-if="(topAggregate.format_winner.recommended_h2_canva || []).length > 0" class="mt-2">
              <p class="text-[11px] text-gray-500 mb-1">Рекомендованная H2-канва (DF≥2):</p>
              <ul class="list-disc ml-4 text-[11px] text-gray-300">
                <li v-for="c in (topAggregate.format_winner.recommended_h2_canva || []).slice(0, 12)"
                    :key="c.h2">
                  {{ c.h2 }} <span class="text-gray-500">×{{ c.df }}</span>
                </li>
              </ul>
            </div>
          </div>

          <!-- ❓ Mandatory questions (Wave 2 #11) -->
          <div v-if="(topAggregate.mandatory_questions || []).length > 0"
               class="mb-4 border border-gray-800 rounded p-3">
            <h3 class="text-xs font-bold text-amber-300 uppercase tracking-wider mb-2">
              ❓ Обязательные вопросы топа (Wave 2)
            </h3>
            <p class="text-[11px] text-gray-500 mb-2">
              Вопросы из H2/H3 + предложений конкурентов с DF≥2 (всего {{ topAggregate.mandatory_questions.length }}).
            </p>
            <ul class="list-disc ml-4 text-[11px] text-gray-300 max-h-48 overflow-y-auto">
              <li v-for="q in topAggregate.mandatory_questions" :key="q.text">
                {{ q.text }}
                <span class="text-gray-500">— DF {{ q.df }} ({{ Number(q.df_share_pct || 0).toFixed(0) }}%)</span>
              </li>
            </ul>
          </div>

          <!-- 🏷 Entity coverage (Wave 2 #12) -->
          <div v-if="topAggregate.entity_coverage && (topAggregate.entity_coverage.mandatory_entities || []).length > 0"
               class="mb-4 border border-gray-800 rounded p-3">
            <h3 class="text-xs font-bold text-emerald-300 uppercase tracking-wider mb-2">
              🏷 Сущности топа (Wave 2)
            </h3>
            <p class="text-xs text-gray-300">
              Mandatory (DF≥{{ topAggregate.entity_coverage.df_threshold || 2 }}):
              <span class="text-gray-500">цель покрытия — </span>
              <b class="text-emerald-200">{{ Number(topAggregate.entity_coverage.coverage_target_pct || 0).toFixed(0) }}%</b>
            </p>
            <div class="mt-2 flex flex-wrap gap-1">
              <span v-for="e in topAggregate.entity_coverage.mandatory_entities" :key="e"
                    class="inline-block bg-emerald-950/60 border border-emerald-900 text-emerald-200 px-2 py-1 rounded text-[10px]">
                {{ e }}
              </span>
            </div>
            <details v-if="(topAggregate.entity_coverage.top_entities || []).length > 0" class="mt-2">
              <summary class="cursor-pointer text-[10px] text-gray-500">
                ▸ ещё {{ topAggregate.entity_coverage.top_entities.length }} сущностей по DF
              </summary>
              <div class="mt-2 flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                <span v-for="e in topAggregate.entity_coverage.top_entities" :key="e.text"
                      class="inline-block bg-gray-800 text-gray-300 px-2 py-1 rounded text-[10px]">
                  {{ e.text }} <span class="text-gray-500">×{{ e.df }}</span>
                </span>
              </div>
            </details>
          </div>

          <!-- 🧬 Headings n-grams (Wave 2 #3.4) -->
          <div v-if="(topAggregate.heading_ngrams?.bigrams || []).length > 0"
               class="mb-4 border border-gray-800 rounded p-3">
            <h3 class="text-xs font-bold text-cyan-300 uppercase tracking-wider mb-2">
              🧬 N-граммы заголовков (Wave 2)
            </h3>
            <p class="text-[11px] text-gray-500 mb-2">
              Биграммы и триграммы только из H2/H3 конкурентов (отдельно от body).
            </p>
            <div class="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <p class="text-gray-500 mb-1">Биграммы:</p>
                <div class="flex flex-wrap gap-1">
                  <span v-for="b in (topAggregate.heading_ngrams.bigrams || []).slice(0, 30)" :key="b.phrase"
                        class="inline-block bg-gray-800 text-cyan-200 px-2 py-1 rounded text-[10px]">
                    {{ b.phrase }} <span class="text-gray-500">×{{ b.df }}</span>
                  </span>
                </div>
              </div>
              <div>
                <p class="text-gray-500 mb-1">Триграммы:</p>
                <div class="flex flex-wrap gap-1">
                  <span v-for="b in (topAggregate.heading_ngrams.trigrams || []).slice(0, 20)" :key="b.phrase"
                        class="inline-block bg-gray-800 text-cyan-200 px-2 py-1 rounded text-[10px]">
                    {{ b.phrase }} <span class="text-gray-500">×{{ b.df }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- 🎨 Title patterns (Wave 3 #15) -->
          <div v-if="(topAggregate.title_template?.detected_patterns?.patterns || []).length > 0"
               class="mb-4 border border-gray-800 rounded p-3">
            <h3 class="text-xs font-bold text-rose-300 uppercase tracking-wider mb-2">
              🎨 Шаблоны title (Wave 3)
            </h3>
            <p class="text-xs text-gray-300">
              Рекомендуем:
              <b class="text-rose-200">{{ topAggregate.title_template.detected_patterns.recommended || '—' }}</b>
              <span class="text-gray-500"> ({{ topAggregate.title_template.detected_patterns.total_titles }} title из топа)</span>
            </p>
            <div class="mt-2 flex flex-wrap gap-1">
              <span v-for="p in topAggregate.title_template.detected_patterns.patterns" :key="p.pattern"
                    class="inline-block bg-gray-800 text-rose-200 px-2 py-1 rounded text-[10px]">
                {{ p.pattern }} <span class="text-gray-500">{{ Number(p.share_pct).toFixed(0) }}%</span>
              </span>
            </div>
          </div>

          <!-- 🧠 Lexical diversity (Wave 3 #14) -->
          <div v-if="topAggregate.lexical_diversity_target && topAggregate.lexical_diversity_target.mtld_median"
               class="mb-4 border border-gray-800 rounded p-3">
            <h3 class="text-xs font-bold text-violet-300 uppercase tracking-wider mb-2">
              🧠 Лексическое разнообразие (Wave 3)
            </h3>
            <ul class="text-xs text-gray-300 space-y-1">
              <li>MTLD (медиана): <b class="text-violet-200">{{ Number(topAggregate.lexical_diversity_target.mtld_median || 0).toFixed(0) }}</b>
                <span class="text-gray-500"> (диапазон {{ Number(topAggregate.lexical_diversity_target.mtld_min || 0).toFixed(0) }}–{{ Number(topAggregate.lexical_diversity_target.mtld_max || 0).toFixed(0) }})</span></li>
              <li>TTR (медиана): <b>{{ Number(topAggregate.lexical_diversity_target.ttr_median || 0).toFixed(3) }}</b></li>
              <li class="text-[11px] text-gray-500">
                Прокси Google contentEffort / originalContentScore. Цель — попасть в коридор топа или выше.
              </li>
            </ul>
          </div>

          <!-- ⚙ Embeddings status (Wave 3 #13) — UI-индикатор активации -->
          <div v-if="topAggregate.embeddings || competitorSignals?.embeddings"
               class="mb-4 border border-gray-800 rounded p-3">
            <h3 class="text-xs font-bold text-teal-300 uppercase tracking-wider mb-2">
              🧬 Embeddings (Wave 3, опционально)
            </h3>
            <div v-if="(topAggregate.embeddings || competitorSignals.embeddings).enabled" class="text-xs text-gray-300">
              <p>Модель: <code class="text-teal-200">{{ (topAggregate.embeddings || competitorSignals.embeddings).model }}</code></p>
              <p v-if="(topAggregate.embeddings || competitorSignals.embeddings).topical_distance">
                Topical pairwise (медиана): <b>{{ Number((topAggregate.embeddings || competitorSignals.embeddings).topical_distance.top_pairwise_median || 0).toFixed(3) }}</b>
              </p>
            </div>
            <p v-else class="text-[11px] text-gray-500">
              Embeddings не активированы. Включите <code>RELEVANCE_EMBEDDINGS=true</code> и установите
              <code>sentence-transformers</code> (модель ~120 МБ).
              <span v-if="(topAggregate.embeddings || competitorSignals.embeddings).reason">
                Причина: {{ (topAggregate.embeddings || competitorSignals.embeddings).reason }}
              </span>
            </p>
          </div>

          <!-- Per-URL signals table -->
          <details class="border border-gray-800 rounded">
            <summary class="cursor-pointer text-xs font-bold text-gray-400 uppercase tracking-wider p-2">
              📋 Per-URL: сигналы по каждому конкуренту ({{ competitorSignalsRows.length }})
            </summary>
            <div class="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table class="w-full text-xs">
                <thead class="text-[10px] text-gray-500 uppercase border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                  <tr>
                    <th class="text-left py-2 px-2">URL</th>
                    <th class="text-right py-2 px-2">Title</th>
                    <th class="text-center py-2 px-2">T↔H1</th>
                    <th class="text-left py-2 px-2">Schemas</th>
                    <th class="text-right py-2 px-2">Возраст</th>
                    <th class="text-right py-2 px-2">H2</th>
                    <th class="text-right py-2 px-2">Trust</th>
                    <th class="text-right py-2 px-2">Точн.</th>
                    <th class="text-right py-2 px-2">Effort</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in competitorSignalsRows" :key="r.url" class="border-b border-gray-900 hover:bg-gray-900/50">
                    <td class="py-1.5 px-2">
                      <a :href="r.url" target="_blank" rel="noopener noreferrer"
                         class="text-sky-300 hover:underline truncate block max-w-[220px]" :title="r.url">
                        {{ r.url }}
                      </a>
                    </td>
                    <td class="py-1.5 px-2 text-right text-gray-400 tabular-nums">{{ r.title_chars }}</td>
                    <td class="py-1.5 px-2 text-center">
                      <span v-if="r.title_h1_match" class="text-emerald-400">✓</span>
                      <span v-else class="text-gray-600">·</span>
                    </td>
                    <td class="py-1.5 px-2 text-emerald-300 text-[10px]">
                      {{ (r.schemas || []).slice(0, 4).join(', ') || '—' }}
                    </td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">
                      {{ r.age_modified !== null && r.age_modified !== undefined ? r.age_modified + 'д' : '—' }}
                    </td>
                    <td class="py-1.5 px-2 text-right tabular-nums">{{ r.h2 }}</td>
                    <td class="py-1.5 px-2 text-right text-rose-300 tabular-nums">{{ r.trust }}</td>
                    <td class="py-1.5 px-2 text-right text-pink-300 tabular-nums">{{ r.exact_total }}</td>
                    <td class="py-1.5 px-2 text-right text-fuchsia-300 tabular-nums font-bold">{{ Number(r.effort).toFixed(1) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <!-- Algorithm-signal summary -->
          <details v-if="algorithmSignals && (algorithmSignals.google || algorithmSignals.yandex)"
                   class="mt-3 border border-gray-800 rounded">
            <summary class="cursor-pointer text-xs font-bold text-gray-400 uppercase tracking-wider p-2">
              🧪 algorithm_signals (Google / Yandex)
            </summary>
            <pre class="text-[10px] text-gray-300 p-3 overflow-x-auto bg-gray-950">{{ JSON.stringify(algorithmSignals, null, 2) }}</pre>
          </details>
        </div>

        <!-- ── (12) Пересечения заголовков h2..h6 → рекомендации структуры ── -->
        <div v-if="headingsIntersection.length > 0" class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              🧩 Заголовки конкурентов (h2–h6) — {{ headingsIntersection.length }} рекомендаций
            </h2>
            <div class="flex items-center gap-1 text-xs flex-wrap">
              <button class="btn-ghost text-sky-300" @click="copyHeadings"
                      title="Скопировать список рекомендованных заголовков">📋 Скопировать</button>
            </div>
          </div>
          <p class="text-[11px] text-gray-500 mb-2">
            Заголовки h2..h6, которые встречаются у нескольких сайтов из ТОП-20.
            Это «пересечение» подсказывает, какие разделы стоит завести в вашей
            статье — чтобы перекрыть структуру ниши.
          </p>
          <div class="overflow-x-auto max-h-[50vh] overflow-y-auto border border-gray-800 rounded">
            <table class="w-full text-xs">
              <thead class="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                <tr>
                  <th class="text-left py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(headingsSort, 'sample')">Заголовок {{ sortArrow(headingsSort, 'sample') }}</th>
                  <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(headingsSort, 'df')">Сайтов {{ sortArrow(headingsSort, 'df') }}</th>
                  <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                      @click="toggleSort(headingsSort, 'df_share_pct')">% сайтов {{ sortArrow(headingsSort, 'df_share_pct') }}</th>
                  <th class="text-center py-2 px-2">Уровни</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="h in headingsSorted" :key="h.text"
                    class="border-b border-gray-900 hover:bg-gray-900/50">
                  <td class="py-1.5 px-2 text-gray-100">{{ h.sample }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ h.df }}</td>
                  <td class="py-1.5 px-2 text-right text-emerald-300 tabular-nums">{{ Number(h.df_share_pct || 0).toFixed(1) }}%</td>
                  <td class="py-1.5 px-2 text-center text-[10px] text-gray-400 uppercase">
                    {{ (h.levels || []).join(', ') }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── SERP список ── -->
        <details class="card">
          <summary class="cursor-pointer text-sm font-bold text-gray-300 uppercase tracking-wider">
            🔗 ТОП-20 Яндекса ({{ (report.serp || []).length }} URL)
            <span v-if="(report.failed_urls || []).length > 0"
                  class="ml-2 text-amber-400 text-xs normal-case">
              · не открылось: {{ report.failed_urls.length }}
            </span>
            <span v-if="(report.filter?.skipped_same_host?.length || 0) > 0"
                  class="ml-2 text-gray-500 text-xs normal-case">
              · дублей домена пропущено: {{ report.filter.skipped_same_host.length }}
            </span>
          </summary>
          <ol class="mt-3 space-y-1.5 text-xs">
            <li v-for="(s, i) in (report.serp || [])" :key="s.url" class="flex gap-2 items-start">
              <span class="w-6 text-gray-500 text-right flex-shrink-0">{{ i + 1 }}.</span>
              <div class="min-w-0 flex-1">
                <a :href="s.url" target="_blank" rel="noopener noreferrer"
                   class="text-sky-300 hover:underline break-all">{{ s.url }}</a>
                <div v-if="s.title" class="text-gray-400 truncate">{{ s.title }}</div>
              </div>
              <button v-if="previewByUrl.get(s.url)?.text"
                      @click.stop="openPreview(s.url)"
                      class="btn-ghost text-emerald-300 text-[10px] flex-shrink-0"
                      title="Показать, что собрал парсер с этой страницы">
                📄 Что собрал
              </button>
              <span v-else-if="previewByUrl.has(s.url)"
                    class="text-[10px] text-amber-400 flex-shrink-0"
                    :title="previewByUrl.get(s.url)?.empty_reason || 'парсер ничего не вытащил'">
                ⚠ нет текста
              </span>
            </li>
          </ol>
          <div v-if="(report.failed_urls || []).length > 0" class="mt-4 pt-3 border-t border-gray-800">
            <div class="text-amber-400 text-xs uppercase tracking-wider mb-2">⚠ Не удалось загрузить:</div>
            <ul class="text-xs space-y-1">
              <li v-for="f in report.failed_urls" :key="f.url" class="text-gray-400">
                <span class="text-gray-500">{{ f.url }}</span> — <span class="text-amber-400">{{ f.error }}</span>
              </li>
            </ul>
          </div>
          <div v-if="(report.filter?.skipped_same_host?.length || 0) > 0" class="mt-4 pt-3 border-t border-gray-800">
            <div class="text-gray-400 text-xs uppercase tracking-wider mb-2">
              ⏭ Пропущено как дубли домена (оставлен первый URL хоста):
            </div>
            <ul class="text-[11px] space-y-0.5">
              <li v-for="x in report.filter.skipped_same_host" :key="x.url" class="text-gray-500 break-all">
                <span class="text-gray-400 font-mono">{{ x.host }}</span> — {{ x.url }}
              </li>
            </ul>
          </div>
        </details>

        <!-- ── (4) Модалка «Что собрал парсер» ── -->
        <div v-if="previewModal" @click.self="closePreview"
             class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-start justify-center p-4 overflow-y-auto">
          <div class="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-w-4xl w-full mt-8 mb-8">
            <div class="flex items-start justify-between p-4 border-b border-gray-800 sticky top-0 bg-gray-900 z-10 rounded-t-lg">
              <div class="min-w-0 flex-1">
                <div class="text-[10px] text-gray-500 uppercase tracking-wider">Что собрал парсер</div>
                <a :href="previewModal.url" target="_blank" rel="noopener noreferrer"
                   class="text-sky-300 hover:underline text-xs break-all">{{ previewModal.url }}</a>
                <div class="text-[11px] text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>метод: <span class="text-gray-300 font-mono">{{ previewModal.method }}</span></span>
                  <span>символов: <span class="text-gray-300 tabular-nums">{{ previewModal.text_chars }}</span></span>
                  <span>слов: <span class="text-gray-300 tabular-nums">{{ previewModal.word_count }}</span></span>
                  <span>тег.зона: <span class="text-gray-300 tabular-nums">{{ previewModal.tag_zone_chars }}</span> симв.</span>
                  <span v-if="previewModal.empty_reason" class="text-amber-400">
                    {{ previewModal.empty_reason }}
                  </span>
                </div>
              </div>
              <div class="flex items-center gap-2 flex-shrink-0 ml-3">
                <button @click="copyPreviewText"
                        class="btn-ghost text-emerald-300 text-xs"
                        title="Скопировать весь текст в буфер">
                  📋 Скопировать
                </button>
                <button @click="closePreview"
                        class="btn-ghost text-gray-400 text-xs"
                        title="Закрыть">
                  ✕
                </button>
              </div>
            </div>
            <div class="p-4">
              <div v-if="previewModal.headings && previewModal.headings.length > 0" class="mb-4">
                <div class="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                  заголовки (h2–h6):
                </div>
                <ul class="text-[11px] text-gray-300 space-y-0.5 max-h-32 overflow-y-auto">
                  <li v-for="(h, hi) in previewModal.headings" :key="hi"
                      :class="{
                        'pl-0':  h.level === 'h2',
                        'pl-3':  h.level === 'h3',
                        'pl-6':  h.level === 'h4',
                        'pl-9':  h.level === 'h5',
                        'pl-12': h.level === 'h6',
                      }">
                    <span class="text-gray-500 font-mono uppercase mr-1">{{ h.level }}</span>{{ h.text }}
                  </li>
                </ul>
              </div>
              <pre class="text-xs text-gray-200 whitespace-pre-wrap break-words bg-gray-950 p-3 rounded border border-gray-800 max-h-[60vh] overflow-y-auto"
                   style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">{{ previewModal.text || '— парсер не вернул текста —' }}</pre>
            </div>
          </div>
        </div>
      </template>
    </div>
  </AppLayout>
</template>
