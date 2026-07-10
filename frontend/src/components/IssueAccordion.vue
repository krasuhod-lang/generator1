<script setup>
/**
 * IssueAccordion — аккордеон ошибок аудита (ТЗ 7).
 *
 * Заменяет плоский список «URL + JSON». Каждая группа: критичность, название,
 * количество, раскрытие. Внутри — человекочитаемые блоки «ℹ Что это» и
 * «💡 Как исправить» + список URL с «[+N ещё] [Показать все]».
 * duplicate_content дополнительно разбивается на группы по хешу.
 */
import { ref, computed } from 'vue';

const props = defineProps({
  // [{ code, severity, count, urls: [...] }]
  groups: { type: Array, default: () => [] },
  // issue_defs: { code: { title, severity, description, hint, fix } }
  defs: { type: Object, default: () => ({}) },
  // { hash: [urls] } — группы дублей для duplicate_content
  duplicates: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['open-url']);

const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const PREVIEW_LIMIT = 20;

const expanded = ref(new Set());
const showAll = ref(new Set());

const sortedGroups = computed(() => [...props.groups].sort((a, b) =>
  (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
  || (b.count || 0) - (a.count || 0)));

const duplicateGroups = computed(() =>
  Object.entries(props.duplicates || {}).map(([hash, urls], i) => ({ hash, urls, n: i + 1 })));

function toggle(code) {
  const s = new Set(expanded.value);
  if (s.has(code)) s.delete(code); else s.add(code);
  expanded.value = s;
}
function toggleShowAll(key) {
  const s = new Set(showAll.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  showAll.value = s;
}
function visibleUrls(key, urls) {
  return showAll.value.has(key) ? urls : urls.slice(0, PREVIEW_LIMIT);
}
function title(code) { return (props.defs[code] || {}).title || code; }
function description(code) {
  const d = props.defs[code] || {};
  return d.description || d.hint || '';
}
function fix(code) {
  const d = props.defs[code] || {};
  return d.fix || d.hint || '';
}
function shortHash(h) { return String(h || '').slice(0, 10) + '…'; }
</script>

<template>
  <div class="issue-accordion">
    <div v-for="g in sortedGroups" :key="g.code" class="ia-group">
      <div class="ia-head" @click="toggle(g.code)">
        <span class="ia-caret">{{ expanded.has(g.code) ? '▾' : '▸' }}</span>
        <span :class="'ia-sev sev-' + g.severity">{{ SEVERITY_LABELS[g.severity] || g.severity }}</span>
        <b class="ia-title">{{ title(g.code) }}</b>
        <span class="ia-count">{{ g.count }}</span>
        <span class="ia-expand-hint muted">{{ expanded.has(g.code) ? 'Свернуть' : 'Развернуть' }}</span>
      </div>

      <div v-if="expanded.has(g.code)" class="ia-body">
        <p v-if="description(g.code)" class="ia-info">
          <span class="ia-ico">ℹ</span>
          <span><b>Что это:</b> {{ description(g.code) }}</span></p>
        <p v-if="fix(g.code)" class="ia-fix">
          <span class="ia-ico">💡</span>
          <span><b>Как исправить:</b> {{ fix(g.code) }}</span></p>

        <!-- Дубликат контента: группы по хешу -->
        <template v-if="g.code === 'duplicate_content' && duplicateGroups.length">
          <div v-for="d in duplicateGroups" :key="d.hash" class="ia-dup-group">
            <div class="ia-dup-head">
              Группа #{{ d.n }} ({{ d.urls.length }} стр.) — хеш: <code>{{ shortHash(d.hash) }}</code></div>
            <ul class="ia-urls">
              <li v-for="u in visibleUrls('dup:' + d.hash, d.urls)" :key="u">
                <a :href="u" target="_blank" rel="noopener" @click.prevent="emit('open-url', u)">{{ u }}</a></li>
            </ul>
            <button v-if="d.urls.length > PREVIEW_LIMIT" class="ia-more" @click="toggleShowAll('dup:' + d.hash)">
              {{ showAll.has('dup:' + d.hash) ? 'Свернуть' : `[+${d.urls.length - PREVIEW_LIMIT} ещё] Показать все` }}</button>
          </div>
        </template>

        <!-- Обычная группа: список URL -->
        <template v-else>
          <ul class="ia-urls">
            <li v-for="u in visibleUrls(g.code, g.urls || [])" :key="u">
              <a :href="u" target="_blank" rel="noopener" @click.prevent="emit('open-url', u)">{{ u }}</a></li>
          </ul>
          <button v-if="(g.urls || []).length > PREVIEW_LIMIT" class="ia-more" @click="toggleShowAll(g.code)">
            {{ showAll.has(g.code) ? 'Свернуть' : `[+${g.urls.length - PREVIEW_LIMIT} ещё] Показать все` }}</button>
        </template>
      </div>
    </div>
    <p v-if="!sortedGroups.length" class="muted">Ошибок не найдено 🎉</p>
  </div>
</template>

<style scoped>
.ia-group { border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: .5rem; overflow: hidden; }
.ia-head { display: flex; align-items: center; gap: .55rem; padding: .6rem .75rem; cursor: pointer; }
.ia-head:hover { background: #f8fafc; }
.ia-caret { color: #2b7cff; width: 1em; }
.ia-title { color: #111827; }
.ia-count { background: #eef2f7; color: #475569; border-radius: 8px; padding: 0 .45rem;
            font-size: .78rem; font-weight: 700; }
.ia-expand-hint { margin-left: auto; font-size: .75rem; }
.ia-body { border-top: 1px solid #eef2f7; padding: .7rem .9rem; background: #fcfdff; }
.ia-info, .ia-fix { display: flex; gap: .5rem; margin: 0 0 .5rem; font-size: .85rem; color: #334155; }
.ia-info { background: #eff6ff; border-radius: 6px; padding: .45rem .6rem; }
.ia-fix  { background: #f0fdf4; border-radius: 6px; padding: .45rem .6rem; }
.ia-ico { flex: none; }
.ia-urls { margin: .3rem 0; padding-left: 1.3rem; font-size: .83rem; }
.ia-urls a { color: #1d4ed8; text-decoration: none; word-break: break-all; }
.ia-more { border: 0; background: none; color: #2b7cff; cursor: pointer; font-size: .8rem; padding: .15rem 0; }
.ia-dup-group { border: 1px dashed #dbeafe; border-radius: 6px; padding: .45rem .6rem; margin-bottom: .45rem; }
.ia-dup-head { font-size: .82rem; color: #475569; font-weight: 600; margin-bottom: .25rem; }
.ia-dup-head code { background: #f1f5f9; padding: 0 .3rem; border-radius: 4px; }

.ia-sev { display: inline-block; padding: .08rem .45rem; border-radius: 9px; font-size: .72rem; font-weight: 700; }
.sev-critical { background: #fecaca; color: #7f1d1d; }
.sev-high     { background: #fed7aa; color: #7c2d12; }
.sev-medium   { background: #fef08a; color: #713f12; }
.sev-low      { background: #e5e7eb; color: #374151; }
.sev-info     { background: #dbeafe; color: #1e3a8a; }
.muted { color: #6b7280; }
</style>
