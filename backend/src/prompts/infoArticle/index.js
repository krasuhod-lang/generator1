'use strict';

/**
 * infoArticle prompts loader — thin wrapper around fs.readFileSync.
 * Полностью изолирован от prompts/linkArticle/* — у генератора инфо-статьи
 * собственные промты (DSPy-Signature) и собственный набор стадий.
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
    console.warn(`[infoArticle/prompts] Failed to read ${filename}: ${err.message}`);
    return '';
  }
}

const PROMPTS = {
  preStage0:    readPromptFile('preStage0_strategy.txt'),
  stage0:       readPromptFile('stage0_audience.txt'),
  stage1:       readPromptFile('stage1_intents.txt'),
  stage1bWS:    readPromptFile('stage1b_whitespace.txt'),
  stage2:       readPromptFile('stage2_outline.txt'),
  stage2bLsi:   readPromptFile('stage2b_lsi_synthesis.txt'),
  stage2cLink:  readPromptFile('stage2c_link_planner.txt'),
  stage3:       readPromptFile('stage3_writer.txt'),
  stage4Images: readPromptFile('stage4_image_prompts.txt'),
  stage5Eeat:   readPromptFile('stage5_eeat_audit.txt'),
  stage5bLink:  readPromptFile('stage5b_link_audit.txt'),
};

function loadInfoArticlePrompt(name) {
  const p = PROMPTS[name];
  if (!p) {
    throw new Error(`[infoArticle/prompts] Unknown prompt "${name}"`);
  }
  return p;
}

function areInfoArticlePromptsAvailable() {
  return Object.values(PROMPTS).every((p) => typeof p === 'string' && p.length > 512);
}

module.exports = {
  PROMPTS,
  loadInfoArticlePrompt,
  areInfoArticlePromptsAvailable,
};
