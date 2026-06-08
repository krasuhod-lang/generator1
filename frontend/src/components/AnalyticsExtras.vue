<script setup>
/**
 * AnalyticsExtras — компактные карточки новых аналитических слоёв GSC:
 *   • «Что изменилось» (period-over-period) — дельты + декомпозиция Δclicks;
 *   • Срезы по устройствам / странам / search appearance;
 *   • Page decay detector — страницы-кандидаты на content refresh;
 *   • Бренд vs небренд.
 *
 * Все секции независимые: пустые/отсутствующие — не рендерятся.
 */
import { computed } from 'vue';

const props = defineProps({
  periodCompare: { type: Object, default: null },
  breakdowns:    { type: Object, default: null },
  pageDecay:     { type: Object, default: null },
  brandSplit:    { type: Object, default: null },
  seasonality:   { type: Object, default: null },
});

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v}%`;
}
function fmtNum(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString('ru-RU')}`;
}
function deltaClass(v) {
  if (v == null || Number.isNaN(v)) return 'text-gray-400';
  return v > 0 ? 'text-emerald-300' : (v < 0 ? 'text-red-300' : 'text-gray-300');
}
// Для позиции «лучше» = меньше, поэтому раскраска инвертирована.
function positionClass(v) {
  if (v == null || Number.isNaN(v)) return 'text-gray-400';
  return v < 0 ? 'text-emerald-300' : (v > 0 ? 'text-red-300' : 'text-gray-300');
}

const pcAvailable = computed(() => props.periodCompare && props.periodCompare.available);
const pdAvailable = computed(() => props.pageDecay && props.pageDecay.available && Array.isArray(props.pageDecay.items) && props.pageDecay.items.length);
const bsAvailable = computed(() => props.brandSplit && props.brandSplit.available);
const seaAvailable = computed(() => props.seasonality && props.seasonality.available);
const seaTrendClass = computed(() => {
  const d = props.seasonality && props.seasonality.trend && props.seasonality.trend.direction;
  return d === 'down' ? 'text-red-300' : (d === 'up' ? 'text-emerald-300' : 'text-gray-300');
});
const seaTrendLabel = computed(() => {
  const d = props.seasonality && props.seasonality.trend && props.seasonality.trend.direction;
  return d === 'down' ? 'Спад' : (d === 'up' ? 'Рост' : 'Стабильно');
});
const bdAvailable = computed(() => {
  const b = props.breakdowns;
  if (!b) return false;
  return ['device', 'country', 'searchAppearance'].some((k) => Array.isArray(b[k]) && b[k].length);
});

function trimUrl(u) {
  if (!u) return '';
  try {
    const parsed = new URL(u);
    return (parsed.pathname + parsed.search) || u;
  } catch (_) { return u; }
}
</script>

<template>
  <div class="space-y-4">
    <!-- ── Что изменилось vs предыдущий период ────────────────────── -->
    <section v-if="pcAvailable" class="card space-y-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
        📊 Что изменилось vs предыдущий равный период
      </h2>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div class="rounded-lg bg-gray-800/40 p-3">
          <div class="text-xs text-gray-400">Клики</div>
          <div class="text-lg font-semibold" :class="deltaClass(periodCompare.totals.delta.clicks)">
            {{ fmtNum(periodCompare.totals.delta.clicks) }}
          </div>
          <div class="text-xs" :class="deltaClass(periodCompare.totals.pct.clicks)">{{ fmtPct(periodCompare.totals.pct.clicks) }}</div>
        </div>
        <div class="rounded-lg bg-gray-800/40 p-3">
          <div class="text-xs text-gray-400">Показы</div>
          <div class="text-lg font-semibold" :class="deltaClass(periodCompare.totals.delta.impressions)">
            {{ fmtNum(periodCompare.totals.delta.impressions) }}
          </div>
          <div class="text-xs" :class="deltaClass(periodCompare.totals.pct.impressions)">{{ fmtPct(periodCompare.totals.pct.impressions) }}</div>
        </div>
        <div class="rounded-lg bg-gray-800/40 p-3">
          <div class="text-xs text-gray-400">CTR</div>
          <div class="text-lg font-semibold" :class="deltaClass(periodCompare.totals.delta.ctr)">
            {{ fmtPct(periodCompare.totals.delta.ctr) }}
          </div>
        </div>
        <div class="rounded-lg bg-gray-800/40 p-3">
          <div class="text-xs text-gray-400">Позиция</div>
          <div class="text-lg font-semibold" :class="positionClass(periodCompare.totals.delta.position)">
            {{ periodCompare.totals.delta.position > 0 ? '+' : '' }}{{ periodCompare.totals.delta.position }}
          </div>
          <div class="text-xs text-gray-500">меньше = лучше</div>
        </div>
      </div>

      <div class="text-xs text-gray-400">
        <span class="font-semibold text-indigo-300">Декомпозиция Δкликов:</span>
        вклад спроса
        <span :class="deltaClass(periodCompare.totals.decomposition.demand_contrib_clicks)">
          {{ fmtNum(periodCompare.totals.decomposition.demand_contrib_clicks) }}
        </span>
        <span v-if="periodCompare.totals.decomposition.demand_share_pct != null">
          ({{ periodCompare.totals.decomposition.demand_share_pct }}%)
        </span>;
        вклад CTR/позиций
        <span :class="deltaClass(periodCompare.totals.decomposition.ctr_contrib_clicks)">
          {{ fmtNum(periodCompare.totals.decomposition.ctr_contrib_clicks) }}
        </span>
        <span v-if="periodCompare.totals.decomposition.ctr_share_pct != null">
          ({{ periodCompare.totals.decomposition.ctr_share_pct }}%)
        </span>.
      </div>

      <div class="grid md:grid-cols-2 gap-4 text-sm">
        <div>
          <h3 class="text-xs font-semibold text-emerald-300 mb-1">↗ Топ растущих запросов</h3>
          <ul class="space-y-1 text-xs">
            <li v-for="r in (periodCompare.queries.risers || []).slice(0, 8)" :key="'r'+r.key" class="flex justify-between gap-2">
              <span class="truncate text-gray-200">{{ r.key }}</span>
              <span class="text-emerald-300 shrink-0">{{ fmtNum(r.delta.clicks) }}</span>
            </li>
            <li v-if="!(periodCompare.queries.risers || []).length" class="text-gray-500">—</li>
          </ul>
        </div>
        <div>
          <h3 class="text-xs font-semibold text-red-300 mb-1">↘ Топ падающих запросов</h3>
          <ul class="space-y-1 text-xs">
            <li v-for="r in (periodCompare.queries.fallers || []).slice(0, 8)" :key="'f'+r.key" class="flex justify-between gap-2">
              <span class="truncate text-gray-200">{{ r.key }}</span>
              <span class="text-red-300 shrink-0">{{ fmtNum(r.delta.clicks) }}</span>
            </li>
            <li v-if="!(periodCompare.queries.fallers || []).length" class="text-gray-500">—</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ── Срезы: устройства / страны / search appearance ───────── -->
    <section v-if="bdAvailable" class="card space-y-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
        📱 Срезы: устройства, география, rich snippets
      </h2>
      <div class="grid md:grid-cols-3 gap-4 text-xs">
        <div v-if="(breakdowns.device || []).length">
          <h3 class="text-gray-400 mb-1 uppercase tracking-wide">Устройства</h3>
          <table class="w-full">
            <tbody>
              <tr v-for="d in breakdowns.device" :key="'d'+d.key" class="border-b border-gray-800/40">
                <td class="py-1 text-gray-200">{{ d.key }}</td>
                <td class="py-1 text-right">{{ d.clicks }} кл.</td>
                <td class="py-1 text-right text-gray-400">{{ d.ctr }}% / поз. {{ d.position }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="(breakdowns.country || []).length">
          <h3 class="text-gray-400 mb-1 uppercase tracking-wide">Топ стран</h3>
          <table class="w-full">
            <tbody>
              <tr v-for="c in (breakdowns.country || []).slice(0, 8)" :key="'c'+c.key" class="border-b border-gray-800/40">
                <td class="py-1 text-gray-200 uppercase">{{ c.key }}</td>
                <td class="py-1 text-right">{{ c.clicks }} кл.</td>
                <td class="py-1 text-right text-gray-400">{{ c.impressions }} пок.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="(breakdowns.searchAppearance || []).length">
          <h3 class="text-gray-400 mb-1 uppercase tracking-wide">Rich appearance</h3>
          <table class="w-full">
            <tbody>
              <tr v-for="a in breakdowns.searchAppearance" :key="'a'+a.key" class="border-b border-gray-800/40">
                <td class="py-1 text-gray-200">{{ a.key }}</td>
                <td class="py-1 text-right">{{ a.clicks }} кл.</td>
                <td class="py-1 text-right text-gray-400">{{ a.ctr }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ── Page decay detector ──────────────────────────────────── -->
    <section v-if="pdAvailable" class="card space-y-2">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
        📉 Page decay — кандидаты на content refresh
      </h2>
      <p class="text-xs text-gray-500">
        Проанализировано страниц: {{ pageDecay.pages_analyzed }};
        в decay (системное падение по неделям): <span class="text-red-300">{{ pageDecay.decaying_count }}</span>
      </p>
      <table class="w-full text-xs">
        <thead class="text-gray-500">
          <tr>
            <th class="text-left py-1">Страница</th>
            <th class="text-right py-1">Ср. клики/нед</th>
            <th class="text-right py-1">Тренд</th>
            <th class="text-right py-1">Decay?</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in pageDecay.items.slice(0, 10)" :key="it.page" class="border-b border-gray-800/40">
            <td class="py-1 text-gray-200 truncate max-w-[280px]" :title="it.page">{{ trimUrl(it.page) }}</td>
            <td class="py-1 text-right">{{ it.mean_weekly_clicks }}</td>
            <td class="py-1 text-right" :class="it.slope_norm < 0 ? 'text-red-300' : 'text-emerald-300'">
              {{ (it.slope_norm * 100).toFixed(1) }}% / нед
            </td>
            <td class="py-1 text-right">
              <span v-if="it.decaying" class="text-red-300">⚠ да</span>
              <span v-else class="text-gray-500">нет</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ── Бренд vs небренд ─────────────────────────────────────── -->
    <section v-if="bsAvailable" class="card space-y-2">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
        🏷 Бренд vs небренд
      </h2>
      <p v-if="(brandSplit.brand_tokens || []).length" class="text-xs text-gray-500">
        Брендовые маркеры: <span class="text-gray-300">{{ brandSplit.brand_tokens.join(', ') }}</span>
      </p>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div class="rounded-lg bg-gray-800/40 p-3">
          <div class="text-xs text-gray-400">Branded</div>
          <div class="text-lg font-semibold text-indigo-200">{{ brandSplit.branded.clicks }} кл.</div>
          <div class="text-xs text-gray-500">
            {{ brandSplit.branded.clicks_pct }}% кликов · CTR {{ brandSplit.branded.ctr }}% · поз. {{ brandSplit.branded.position }}
          </div>
        </div>
        <div class="rounded-lg bg-gray-800/40 p-3">
          <div class="text-xs text-gray-400">Non-branded</div>
          <div class="text-lg font-semibold text-emerald-200">{{ brandSplit.nonbranded.clicks }} кл.</div>
          <div class="text-xs text-gray-500">
            {{ brandSplit.nonbranded.clicks_pct }}% кликов · CTR {{ brandSplit.nonbranded.ctr }}% · поз. {{ brandSplit.nonbranded.position }}
          </div>
        </div>
      </div>
    </section>

    <!-- ── Закономерности спада (ТЗ п.4) ────────────────────────── -->
    <section v-if="seaAvailable" class="card space-y-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
        📉 Закономерности спада
      </h2>
      <p class="text-xs text-gray-500">
        Окно {{ seasonality.range.from }} — {{ seasonality.range.to }} · {{ seasonality.days }} дн.
      </p>

      <!-- Общий тренд -->
      <div class="rounded-lg bg-gray-800/40 p-3 flex items-center justify-between text-sm">
        <span class="text-gray-400">Общий тренд</span>
        <span class="font-semibold" :class="seaTrendClass">
          {{ seaTrendLabel }} · {{ fmtNum(seasonality.trend.slope_clicks_per_day) }} кликов/день
        </span>
      </div>

      <!-- Найденные закономерности -->
      <ul v-if="(seasonality.findings || []).length" class="text-xs text-gray-300 space-y-1 list-disc pl-4">
        <li v-for="(f, i) in seasonality.findings" :key="'sf'+i">{{ f }}</li>
      </ul>

      <!-- Помесячная динамика -->
      <div v-if="(seasonality.monthly?.by_month || []).length" class="overflow-x-auto">
        <div class="text-xs text-gray-400 mb-1">Помесячно</div>
        <table class="w-full text-xs">
          <thead><tr class="text-gray-500 text-left">
            <th class="py-1 pr-2">Месяц</th><th class="py-1 pr-2">Клики</th><th class="py-1">MoM</th>
          </tr></thead>
          <tbody>
            <tr v-for="m in seasonality.monthly.by_month" :key="m.month" class="border-b border-gray-800/40">
              <td class="py-1 pr-2 text-gray-300">{{ m.month }}</td>
              <td class="py-1 pr-2 text-gray-200">{{ Number(m.clicks).toLocaleString('ru-RU') }}</td>
              <td class="py-1" :class="deltaClass(m.mom_pct)">{{ m.mom_pct == null ? '—' : fmtPct(m.mom_pct) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Слабые дни недели -->
      <div v-if="(seasonality.weekday?.weak_days || []).length" class="text-xs text-gray-300">
        <span class="text-gray-400">Системно слабые дни: </span>
        <span v-for="(d, i) in seasonality.weekday.weak_days" :key="'wd'+i" class="text-red-300">
          {{ d.name }} ({{ d.below_pct }}%)<span v-if="i < seasonality.weekday.weak_days.length - 1">, </span>
        </span>
      </div>
    </section>
  </div>
</template>
