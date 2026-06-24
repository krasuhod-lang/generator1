/**
 * Лёгкий модульный кеш для ProjectPicker (см. components/ProjectPicker.vue).
 * Вынесен в отдельный файл, потому что `<script setup>` не допускает
 * именованных экспортов — а cache нужен и компоненту, и потенциальным
 * консьюмерам (например, страницам, которые создают новые проекты и
 * хотят сбросить кеш списка проектов).
 */
import api from '../api.js';

let _cache = null;
let _cachePromise = null;

export function clearProjectsCache() {
  _cache = null;
  _cachePromise = null;
}

export async function loadProjectsOptions() {
  if (_cache) return _cache;
  if (_cachePromise) return _cachePromise;
  _cachePromise = api.get('/projects/options')
    .then((r) => {
      _cache = r.data?.items || [];
      return _cache;
    })
    .catch((e) => {
      _cachePromise = null;
      throw e;
    });
  return _cachePromise;
}
