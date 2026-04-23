'use strict';

/**
 * linkArticle prompts loader — thin wrapper around fs.readFileSync.
 * Отдельная папка `prompts/linkArticle/*.txt`, чтобы ни один существующий
 * промт (systemPrompts.js / strategy / editorCopilot / metaTags) не
 * изменялся: генератор ссылочной статьи имеет собственную изолированную
 * логику и собственные промты.
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
    console.warn(`[linkArticle/prompts] Failed to read ${filename}: ${err.message}`);
    return '';
  }
}

const PROMPTS = {
  preStage0:    readPromptFile('preStage0_strategy.txt'),
  stage0:       readPromptFile('stage0_audience.txt'),
  stage1:       readPromptFile('stage1_intents.txt'),
  stage2:       readPromptFile('stage2_structure.txt'),
  stage3:       readPromptFile('stage3_writer.txt'),
  stage4Images: readPromptFile('stage4_image_prompts.txt'),
};

function loadLinkArticlePrompt(name) {
  const p = PROMPTS[name];
  if (!p) {
    throw new Error(`[linkArticle/prompts] Unknown prompt "${name}"`);
  }
  return p;
}

function areLinkArticlePromptsAvailable() {
  return Object.values(PROMPTS).every((p) => typeof p === 'string' && p.length > 512);
}

module.exports = {
  PROMPTS,
  loadLinkArticlePrompt,
  areLinkArticlePromptsAvailable,
};
