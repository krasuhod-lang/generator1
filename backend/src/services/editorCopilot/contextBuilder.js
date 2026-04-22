'use strict';

const db = require('../../config/db');
const { computeLsiUnused } = require('./lsiUnusedCalc');

/**
 * buildContext — формирует «Пакет контекста» для AI-Copilot редактора.
 * Источник — таблица `tasks` (включая JSONB strategy_context, stage1_result).
 * Не делает LLM-вызовов: всё чисто из БД и in-process кэша.
 *
 * @param {string} taskId
 * @returns {Promise<{
 *   task,
 *   input_data, strategy_context, eeat_brief, lsi_state,
 *   full_article_text, audience_personas, niche_terminology, content_voice,
 * }>}
 */
async function buildContext(taskId) {
  const { rows } = await db.query(
    `SELECT id, user_id,
            input_brand_name, input_region, input_business_type, input_site_type,
            input_target_audience, input_target_service, input_language,
            input_raw_lsi, input_brand_facts, input_project_limits,
            stage0_result, stage1_result, stage2_result,
            strategy_context,
            full_html, full_html_edited
       FROM tasks
      WHERE id = $1`,
    [taskId]
  );
  if (!rows.length) {
    const err = new Error('Task not found');
    err.status = 404;
    throw err;
  }
  const task = rows[0];

  const fullArticleText = (task.full_html_edited && task.full_html_edited.trim())
    ? task.full_html_edited
    : (task.full_html || '');

  const lsi_state = computeLsiUnused(task.input_raw_lsi, fullArticleText);

  const stage1 = safeJson(task.stage1_result);
  const stage0 = safeJson(task.stage0_result);
  const strategy = safeJson(task.strategy_context);

  return {
    task,
    input_data: {
      brand:         task.input_brand_name || '',
      region:        task.input_region     || '',
      business_type: task.input_business_type || '',
      site_type:     task.input_site_type  || '',
      target_audience: task.input_target_audience || '',
      target_service:  task.input_target_service  || '',
      language:        task.input_language || 'ru',
      brand_facts:     task.input_brand_facts || '',
      project_limits:  task.input_project_limits || '',
    },
    strategy_context: strategy || {},
    eeat_brief:       extractEeatBrief(stage0, stage1),
    lsi_state,
    full_article_text: fullArticleText,
    audience_personas: extractAudienceProfile(stage1, strategy),
    niche_terminology: extractNicheTerminology(stage1, strategy),
    content_voice:     extractContentVoice(stage1, strategy),
  };
}

function safeJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function extractAudienceProfile(stage1, strategy) {
  // Несколько источников, выбираем первый непустой.
  const candidates = [
    stage1?.audience_profile,
    stage1?.audience,
    strategy?.audience_profile,
    strategy?.demand_map?.audience,
  ].filter(Boolean);
  if (!candidates.length) return '';
  const first = candidates[0];
  if (typeof first === 'string') return first;
  try { return JSON.stringify(first, null, 2).slice(0, 4000); } catch (_) { return ''; }
}

function extractNicheTerminology(stage1, strategy) {
  const terms = stage1?.niche_terminology
    || stage1?.terminology
    || strategy?.niche_map?.terminology
    || [];
  if (Array.isArray(terms)) return terms.filter(Boolean).slice(0, 80).join(', ');
  if (typeof terms === 'string') return terms;
  return '';
}

function extractContentVoice(stage1, strategy) {
  const voice = stage1?.content_voice
    || stage1?.tone_of_voice
    || stage1?.tov
    || strategy?.content_voice
    || strategy?.demand_map?.tov
    || '';
  if (typeof voice === 'string') return voice;
  try { return JSON.stringify(voice, null, 2).slice(0, 2500); } catch (_) { return ''; }
}

function extractEeatBrief(stage0, stage1) {
  const eeat = stage1?.eeat_requirements
    || stage1?.eeat_brief
    || stage0?.eeat_requirements
    || stage0?.eeat_brief
    || '';
  if (typeof eeat === 'string') return eeat;
  if (Array.isArray(eeat)) return eeat.filter(Boolean).slice(0, 30).join('\n- ');
  try { return JSON.stringify(eeat, null, 2).slice(0, 3000); } catch (_) { return ''; }
}

module.exports = { buildContext };
