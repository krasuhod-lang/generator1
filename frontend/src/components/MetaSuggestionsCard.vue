<script setup>
/**
 * MetaSuggestionsCard — постраничная оптимизация title/description (п.4 ТЗ):
 *   таблица «было → стало» по страницам с CTR-аномалией / page decay,
 *   новые метатеги сгенерированы через инструмент Meta Tags (Gemini).
 *   Кнопка «Перегенерировать» дергает тот же сервис точечно.
 */
import { ref, computed, watch } from 'vue';
import { useProjectsStore } from '../stores/projects.js';
import CopyButton from './CopyButton.vue';
import { copyToClipboard, toTsv } from '../utils/clipboard.js';

const props = defineProps({
  pageMetaAudit: { type: Object, default: null },
  projectId:     { type: [String, Number], default: null },
  analysisId:    { type: [String, Number], default: null },
});
const emit = defineEmits(['updated']);

const store = useProjectsStore();
const available = computed(() => props.pageMetaAudit && props.pageMetaAudit.available);
const pages = ref([]);
const copied = ref(false);

// Локальная копия, чтобы кнопка регенерации могла обновлять строку.
watch(() => props.pageMetaAudit, (val) => {
  pages.value = (val && val.pages) ? [...val.pages] : [];
}, { immediate: true });

const busy = ref({});
const errors = ref({});

function trimUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return (p.pathname + p.search) || u; } catch (_) { return u; }
}

// Title + Description одной строкой для копирования сразу обоих метатегов.
function bothMeta(p) {
  const s = p && p.suggested;
  if (!s) return '';
  return `Title: ${s.title || ''}\nDescription: ${s.description || ''}`;
}

// Непокрытые LSI-слова в готовых тегах (диагностика покрытия ключей).
function missedLsi(p) {
  const m = p && p.lsi_check && p.lsi_check.missed_lsi;
  return Array.isArray(m) ? m : [];
}

async function regenerate(page, idx) {
  if (!props.projectId) return;
  busy.value = { ...busy.value, [idx]: true };
  errors.value = { ...errors.value, [idx]: '' };
  try {
    const res = await store.regenerateMeta(props.projectId, page.url, props.analysisId);
    const updated = res && res.pages && res.pages[0];
    if (updated) pages.value.splice(idx, 1, updated);
    if (res && res.persisted && res.persisted.page_meta_audit) emit('updated', res.persisted.page_meta_audit);
    // Показываем причину, если рекомендация так и не сгенерировалась — иначе
    // кнопка выглядит «нерабочей» (ничего не произошло).
    const reason = (updated && updated.error) || (res && res.error) || '';
    if (updated && !updated.suggested) {
      errors.value = { ...errors.value, [idx]: reason || 'Не удалось сгенерировать — попробуйте ещё раз' };
    }
  } catch (e) {
    const msg = (e && e.response && e.response.data && e.response.data.error)
      || (e && e.message) || 'Ошибка перегенерации';
    errors.value = { ...errors.value, [idx]: msg };
  } finally { busy.value = { ...busy.value, [idx]: false }; }
}

// Копирование всей таблицы в Excel: TSV с разбивкой по колонкам (2 клика).
async function copyAllForExcel() {
  const headers = ['URL', 'Причина', 'Title (было)', 'Title (стало)', 'Description (было)',
    'Description (стало)', 'H1 (было)', 'H1 (стало)', 'Title длина', 'Desc длина', 'Непокрытые LSI'];
  const rows = [headers];
  pages.value.forEach((p) => {
    const b = p.before || {};
    const s = p.suggested || {};
    rows.push([
      p.url || '',
      p.reason || '',
      b.title || '',
      s.title || '',
      b.description || '',
      s.description || '',
      b.h1 || '',
      s.h1 || '',
      s.title ? s.title.length : (b.title ? b.title.length : ''),
      s.description ? s.description.length : (b.description ? b.description.length : ''),
      missedLsi(p).join(', '),
    ]);
  });
  const ok = await copyToClipboard(toTsv(rows));
  if (ok) { copied.value = true; setTimeout(() => { copied.value = false; }, 2000); }
}
</script>

<template>
  <section v-if="available && pages.length" class="card space-y-3">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
        🏷️ Постраничная оптимизация метатегов
      </h2>
      <button class="btn-secondary text-xs" @click="copyAllForExcel"
              title="Скопировать таблицу в формате TSV — вставляется в Excel как таблица (Ctrl+V)">
        {{ copied ? '✓ Скопировано' : '📋 Копировать всё (для Excel)' }}
      </button>
    </div>
    <div class="space-y-3">
      <div v-for="(p, i) in pages" :key="p.url || i" class="rounded-lg bg-gray-800/40 p-3 text-sm space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-indigo-300 text-xs">{{ trimUrl(p.url) }}</span>
          <span v-if="p.reason" class="text-[11px] text-amber-300">{{ p.reason }}</span>
        </div>

        <div v-if="p.error" class="text-xs text-red-300">Не удалось спарсить страницу.</div>

        <template v-else>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div class="rounded bg-gray-900/50 p-2">
              <div class="text-[11px] text-gray-500 uppercase">Было</div>
              <div class="text-xs"><b>Title:</b> {{ p.before && p.before.title || '—' }}</div>
              <div class="text-xs"><b>Desc:</b> {{ p.before && p.before.description || '—' }}</div>
            </div>
            <div class="rounded bg-gray-900/50 p-2">
              <div class="text-[11px] text-gray-500 uppercase">Стало</div>
              <template v-if="p.suggested">
                <div class="flex items-start justify-between gap-2">
                  <div class="text-xs min-w-0"><b>Title:</b> {{ p.suggested.title }}</div>
                  <CopyButton :text="p.suggested.title" label="Title" />
                </div>
                <div class="flex items-start justify-between gap-2 mt-1">
                  <div class="text-xs min-w-0"><b>Desc:</b> {{ p.suggested.description }}</div>
                  <CopyButton :text="p.suggested.description" label="Desc" />
                </div>
              </template>
              <div v-else class="text-xs text-gray-500">
                Рекомендация не сгенерирована.
                <span v-if="p.error" class="block text-amber-300 mt-0.5">⚠ {{ p.error }}</span>
              </div>
            </div>
          </div>

          <!-- Диагностика покрытия ключей (LSI) в готовых тегах -->
          <div v-if="p.suggested" class="text-[11px]">
            <span v-if="missedLsi(p).length === 0" class="text-emerald-300">✓ Все ключи покрыты</span>
            <span v-else class="text-amber-300">
              ⚠ Непокрытые LSI: {{ missedLsi(p).slice(0, 8).join(', ') }}
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button v-if="projectId" class="btn-secondary text-xs" :disabled="busy[i]" @click="regenerate(p, i)">
              {{ busy[i] ? 'Этапы: ЦА → SERP → генерация → LSI…' : 'Перегенерировать через Meta Tags' }}
            </button>
            <CopyButton v-if="p.suggested" :text="bothMeta(p)" label="Title + Description" />
            <span v-if="errors[i]" class="text-[11px] text-rose-300">⚠ {{ errors[i] }}</span>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
