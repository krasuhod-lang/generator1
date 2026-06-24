'use strict';

/**
 * projects/blogArticleBridge — генерация полноценной статьи для блога через
 * наш внутренний инструмент (info-article pipeline), ТЗ п.7:
 * «сделать возможность сгенерировать через наш внутренний инструмент статью
 * для блога с заполнением и сбором всех фактов о компании. Важно, чтобы всё
 * работало как швейцарские часы».
 *
 * Поток:
 *   1. Берём тему из плана публикаций проекта (snapshot.blog_plan.topics).
 *   2. Детерминированно+LLM собираем факты о компании со страницы проекта
 *      (analyzeTargetPage парсит сайт целиком, теперь включая шапку/подвал —
 *      см. scraper._extractChrome), извлекая brand_name / brand_facts / регион.
 *   3. Создаём задачу info_article_tasks, предзаполненную темой и фактами
 *      компании, и запускаем существующий конвейер генерации статьи.
 *
 * Модуль НЕ дублирует логику pipeline — он только «склеивает» проект с уже
 * работающим инструментом статей, поэтому статья проходит весь стандартный
 * путь (стратегия → аудитория → структура → текст → E-E-A-T → картинки).
 */

const db = require('../../config/db');
const { withUserSlot } = require('../../utils/perUserConcurrency');
const { normalizeGeminiCopywritingModel } = require('../llm/geminiModels');

const MAX_TOPIC_LEN = 250;
const MAX_REGION_LEN = 120;
const MAX_BRAND_LEN = 200;
const MAX_FACTS_LEN = 6000;
const DEFAULT_REGION = 'Россия';

function _clip(v, max) {
  const s = (v == null ? '' : String(v)).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function _clampImages(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, n));
}

// URL «домашней» страницы проекта для сбора фактов о компании.
function _projectSiteUrl(project) {
  const raw = project.url || project.gsc_site_url || project.ydx_site_url || '';
  let s = String(raw).trim();
  if (!s) return '';
  // GSC sc-domain:example.com → https://example.com
  if (s.startsWith('sc-domain:')) s = `https://${s.slice('sc-domain:'.length)}`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { return new URL(s).toString(); } catch (_) { return ''; }
}

/**
 * Собирает факты о компании со страницы проекта.
 * @returns {Promise<{brandName:string, brandFacts:string, region:string}|null>}
 */
async function gatherCompanyFacts(project, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const url = _projectSiteUrl(project);
  if (!url) return null;
  try {
    const { analyzeTargetPage } = require('../parser/targetPageAnalyzer');
    const analysis = await analyzeTargetPage(url, { log, taskId: null, onTokens: opts.onTokens });
    if (!analysis || typeof analysis !== 'object') return null;
    return {
      brandName: _clip(analysis.brand_name, MAX_BRAND_LEN),
      brandFacts: _clip(analysis.brand_facts, MAX_FACTS_LEN),
      region: _clip(analysis.detected_region, MAX_REGION_LEN),
    };
  } catch (e) {
    log(`blogArticleBridge: сбор фактов о компании не удался (${e.message})`, 'warn');
    return null;
  }
}

/**
 * Создаёт и запускает задачу генерации статьи в блог из темы плана проекта.
 * @param {object} params
 * @param {object} params.project — строка проекта (с url/gsc_site_url)
 * @param {string} params.userId
 * @param {string} params.topic  — тема статьи (обязательна)
 * @param {string} [params.region]
 * @param {string} [params.geminiModel]
 * @param {number} [params.imagesCount]
 * @param {object} [params.companyFacts] — заранее собранные факты (иначе соберём)
 * @returns {Promise<{task:object, company_facts:object|null}>}
 */
async function generateBlogArticleFromProject(params) {
  const { project, userId } = params;
  const topic = _clip(params.topic, MAX_TOPIC_LEN);
  if (!topic || topic.length < 5) {
    const err = new Error('Тема статьи обязательна (не короче 5 символов)');
    err.statusCode = 400;
    throw err;
  }

  // Факты о компании: либо переданы, либо собираем со страницы проекта.
  let facts = params.companyFacts || null;
  if (!facts) facts = await gatherCompanyFacts(project, { log: params.log });

  const region = _clip(params.region, MAX_REGION_LEN)
    || (facts && facts.region)
    || DEFAULT_REGION;
  const brandName = (facts && facts.brandName) || _clip(project.name, MAX_BRAND_LEN) || null;
  const brandFacts = (facts && facts.brandFacts) || null;
  const geminiModel = normalizeGeminiCopywritingModel(params.geminiModel);
  const imagesCount = _clampImages(params.imagesCount);

  const { rows } = await db.query(
    `INSERT INTO info_article_tasks
       (user_id, topic, region, brand_name, brand_facts, output_format,
         commercial_links, commercial_links_count,
         images_count, gemini_model, project_id, status, progress_pct)
     VALUES ($1, $2, $3, $4, $5, 'html', '[]'::jsonb, 0, $6, $7, $8, 'queued', 0)
     RETURNING id, topic, region, brand_name, output_format,
               images_count, gemini_model, project_id, status, progress_pct, created_at`,
    [userId, topic, region, brandName, brandFacts, imagesCount, geminiModel, project?.id || null],
  );
  const task = rows[0];

  // Запускаем существующий конвейер генерации в фоне (как швейцарские часы —
  // тот же путь, что и при ручном создании статьи).
  const { processInfoArticleTask } = require('../infoArticle/infoArticlePipeline');
  setImmediate(() => {
    withUserSlot(userId, () => processInfoArticleTask(task.id)).catch((err) => {
      console.error('[blogArticleBridge] background task failed:', err.message);
    });
  });

  return { task, company_facts: facts || null };
}

module.exports = {
  generateBlogArticleFromProject,
  gatherCompanyFacts,
  _projectSiteUrl,
};
