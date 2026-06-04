'use strict';

/**
 * Reddit Mapper V2 prompts loader.
 *
 * Источник промтов — директория `Промты/` в корне репозитория (7 этапов
 * исследования аудитории: картография Reddit → боли → язык → ранние сдвиги →
 * приоритизация тем → кластеры/страницы). Файлы перенесены сюда с ASCII-именами,
 * чтобы:
 *   - загружаться единообразно с остальными prompts-as-code модулями
 *     (`prompts/infoArticle`, `prompts/linkArticle`);
 *   - автоматически попадать под Aegis prompt-audit (см. services/aegis/promptAudit.js,
 *     который сканирует backend/src/prompts/**) и связку с DSPy-обучением;
 *   - корректно работать в Docker-образе backend (без зависимости от корня репо).
 *
 * Тонкая обёртка над fs.readFileSync — никакой логики генерации здесь нет.
 */

const fs   = require('fs');
const path = require('path');

const PROMPT_DIR = __dirname;

function readPromptFile(filename) {
  const full = path.join(PROMPT_DIR, filename);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[redditMapper/prompts] Failed to read ${filename}: ${err.message}`);
    return '';
  }
}

// Канонический порядок этапов. Ключи стабильны — на них завязаны
// оркестратор (redditMapperPipeline.js) и DSPy-регистрация.
const STAGE_FILES = [
  { key: 'stage0', file: 'stage0_init.txt',       label: 'Reddit Mapper V2 — Этап 0 (инициализатор/seed)' },
  { key: 'stage1', file: 'stage1_sourcemap.txt',  label: 'Reddit Mapper V2 — Этап 1 (картограф Reddit)' },
  { key: 'stage2', file: 'stage2_painmap.txt',    label: 'Reddit Mapper V2 — Этап 2 (извлекатель болей)' },
  { key: 'stage3', file: 'stage3_language.txt',   label: 'Reddit Mapper V2 — Этап 3 (язык аудитории)' },
  { key: 'stage4', file: 'stage4_emerging.txt',   label: 'Reddit Mapper V2 — Этап 4 (ранние сдвиги)' },
  { key: 'stage5', file: 'stage5_priority.txt',   label: 'Reddit Mapper V2 — Этап 5 (приоритизация тем)' },
  { key: 'stage6', file: 'stage6_clusters.txt',   label: 'Reddit Mapper V2 — Этап 6 (кластеры/страницы)' },
];

const PROMPTS = Object.freeze(
  STAGE_FILES.reduce((acc, s) => {
    acc[s.key] = readPromptFile(s.file);
    return acc;
  }, {}),
);

// DSPy-style регистрация в promptRegistry (best-effort, не критично для работы).
// Делает промты Reddit Mapper V2 видимыми для DSPy-фреймворка (валидация {{VARS}},
// версионирование, A/B) наравне с infoArticle/linkArticle/categoryLead.
try {
  const { registerPrompt } = require('../promptRegistry');
  for (const s of STAGE_FILES) {
    if (PROMPTS[s.key]) {
      registerPrompt(`redditMapper.${s.key}`, {
        prompt: PROMPTS[s.key],
        version: '2.0.0',
        metadata: { module: 'redditMapper', stage: s.key, label: s.label, system: 'reddit_mapper_v2' },
      });
    }
  }
} catch (_) { /* registry optional */ }

function loadRedditMapperPrompt(name) {
  const p = PROMPTS[name];
  if (!p) {
    throw new Error(`[redditMapper/prompts] Unknown prompt "${name}"`);
  }
  return p;
}

function areRedditMapperPromptsAvailable() {
  return Object.values(PROMPTS).every((p) => typeof p === 'string' && p.length > 512);
}

module.exports = {
  PROMPTS,
  STAGE_FILES,
  loadRedditMapperPrompt,
  areRedditMapperPromptsAvailable,
};
