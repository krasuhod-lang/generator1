<script setup>
/**
 * MetaSuggestionsCard — постраничная оптимизация title/description (п.4 ТЗ):
 *   таблица «было → стало» по страницам с CTR-аномалией / page decay,
 *   новые метатеги сгенерированы через инструмент Meta Tags (Gemini).
 *   Кнопка «Перегенерировать» дергает тот же сервис точечно.
 */
import { ref, computed, watch } from 'vue';
import { useProjectsStore } from '../stores/projects.js';

const props = defineProps({
  pageMetaAudit: { type: Object, default: null },
  projectId:     { type: [String, Number], default: null },
});

const store = useProjectsStore();
const available = computed(() => props.pageMetaAudit && props.pageMetaAudit.available);
const pages = ref([]);

// Локальная копия, чтобы кнопка регенерации могла обновлять строку.
watch(() => props.pageMetaAudit, (val) => {
  pages.value = (val && val.pages) ? [...val.pages] : [];
}, { immediate: true });

const busy = ref({});

function trimUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return (p.pathname + p.search) || u; } catch (_) { return u; }
}

async function regenerate(page, idx) {
  if (!props.projectId) return;
  busy.value = { ...busy.value, [idx]: true };
  try {
    const res = await store.regenerateMeta(props.projectId, page.url);
    const updated = res && res.pages && res.pages[0];
    if (updated) pages.value.splice(idx, 1, updated);
  } catch (_) { /* graceful: keep current row */ }
  finally { busy.value = { ...busy.value, [idx]: false }; }
}
</script>

<template>
  <section v-if="available && pages.length" class="card space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">
      🏷️ Постраничная оптимизация метатегов
    </h2>
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
                <div class="text-xs"><b>Title:</b> {{ p.suggested.title }}</div>
                <div class="text-xs"><b>Desc:</b> {{ p.suggested.description }}</div>
              </template>
              <div v-else class="text-xs text-gray-500">Рекомендация не сгенерирована.</div>
            </div>
          </div>

          <button class="btn-secondary text-xs" :disabled="busy[i]" @click="regenerate(p, i)">
            {{ busy[i] ? 'Генерация…' : 'Перегенерировать через Meta Tags' }}
          </button>
        </template>
      </div>
    </div>
  </section>
</template>
