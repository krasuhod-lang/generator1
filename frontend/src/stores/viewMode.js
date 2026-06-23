/**
 * stores/viewMode.js — глобальный стор переключателя «Аналитик/Клиент».
 *
 * Используется UI-тумблером в Topbar (PR-3) и axios-перехватчиком в api.js,
 * который при `mode === 'client'` добавляет к каждому запросу заголовок
 * `X-Client-Mode: 1`. Бэкенд интерпретирует его в
 * backend/src/services/projects/viewMode.js#resolveViewMode и срезает
 * технические поля из ответа.
 *
 * Состояние сохраняется в localStorage под ключом `seo_view_mode`, чтобы
 * клиентский режим переживал перезагрузку страницы.
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const VIEW_MODES = Object.freeze({ ANALYST: 'analyst', CLIENT: 'client' });

const STORAGE_KEY = 'seo_view_mode';
const VALID = new Set([VIEW_MODES.ANALYST, VIEW_MODES.CLIENT]);

function _readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.has(v) ? v : VIEW_MODES.ANALYST;
  } catch (_) {
    return VIEW_MODES.ANALYST;
  }
}

function _writeStored(value) {
  try { localStorage.setItem(STORAGE_KEY, value); } catch (_) { /* no-op */ }
}

export const useViewModeStore = defineStore('viewMode', () => {
  const mode = ref(_readStored());

  const isClient  = computed(() => mode.value === VIEW_MODES.CLIENT);
  const isAnalyst = computed(() => mode.value === VIEW_MODES.ANALYST);

  function setMode(value) {
    const next = VALID.has(value) ? value : VIEW_MODES.ANALYST;
    if (mode.value === next) return;
    mode.value = next;
    _writeStored(next);
  }

  function toggle() {
    setMode(mode.value === VIEW_MODES.CLIENT ? VIEW_MODES.ANALYST : VIEW_MODES.CLIENT);
  }

  return { mode, isClient, isAnalyst, setMode, toggle };
});
