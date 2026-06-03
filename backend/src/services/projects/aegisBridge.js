'use strict';

/**
 * projects/aegisBridge.js — мост из «Проектов»/GSC-аналитики в обучающую
 * петлю A.E.G.I.S.
 *
 * Что делает после успешного `project_analyses`:
 *   1) Маппит сэмпл из `gsc_snapshot` (top_pages + commercial.cannibalization +
 *      page_decay) в массив `pages[]`, понятный seoBrain.normalizePage().
 *   2) Вызывает seoBrain.buildSeoBrainSnapshot() и persistSnapshot() —
 *      обновляет aegis_seo_memory + aegis_seo_actions для домена проекта.
 *   3) Записывает обучающий пример в aegis_dspy_dataset
 *      (kind='projects_analysis') — чтобы dspyAutoRetrain видел тематику
 *      проекта.
 *   4) (опц.) Шлёт сигнал в Bio-Brain (NEAT) через biobrainClient.feedback() —
 *      reward = функция от Δclicks / Δposition в periodCompare.
 *
 * Конфигурация: aegis/featureFlags.js → projects.aegisHooks. Без новых ENV.
 *
 * Best-effort: любая ошибка проглатывается и логируется warn'ом — реальная
 * аналитика проекта не должна валиться из-за сбоя нашей обвязки.
 */

const seoBrain = require('../aegis/seoBrain');
const { recordTrainingExample } = require('../aegis/datasetWriter');
const biobrainClient = require('../aegis/biobrainClient');
const { getAegisFlags } = require('../aegis/featureFlags');

const MAX_PAGES = 200;
const MAX_CANNIB_PAGES = 30;
const MAX_DECAY_PAGES = 30;

function _num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _str(v, max = 500) {
  if (v == null) return '';
  return String(v).slice(0, max).trim();
}

function _hostFromUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return (u.host || '').toLowerCase();
  } catch (_) { return ''; }
}

function _siteKeyForProject(project) {
  // Стабильный ключ домена (gsc_site_url приоритетнее, потом url, потом id).
  if (project && project.gsc_site_url) {
    const s = String(project.gsc_site_url);
    // sc-domain:example.com → example.com; иначе host из URL.
    if (s.startsWith('sc-domain:')) return `gsc:${s.slice('sc-domain:'.length)}`;
    const host = _hostFromUrl(s);
    if (host) return `gsc:${host}`;
  }
  if (project && project.url) {
    const host = _hostFromUrl(project.url);
    if (host) return `gsc:${host}`;
  }
  return `project:${project && project.id ? project.id : 'unknown'}`;
}

function _classifyClusterByQuery(query) {
  // Безопасный fallback-кластер: первое значимое слово запроса (для агрегатов
  // в seoBrain). seoBrain.normalizePage() уже умеет input.cluster | topic | niche.
  const q = String(query || '').toLowerCase().replace(/[^a-zа-я0-9\s-]/gi, ' ').trim();
  if (!q) return 'unknown';
  const w = q.split(/\s+/).filter(Boolean)[0] || 'unknown';
  return w.slice(0, 40);
}

/**
 * mapSnapshotToPages — собирает компактный pages[] из gsc_snapshot.
 *
 * Выходной формат совместим с seoBrain.normalizePage:
 *   { url, path, title, cluster, intent, position, ctr, clicks, impressions, ... }
 */
function mapSnapshotToPages(snapshot, project, opts = {}) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const limit = _num(opts.limit) || MAX_PAGES;
  const out = [];
  const seenUrls = new Set();

  // 1) top_pages — основное «тело» страниц.
  const topPages = Array.isArray(snapshot.top_pages) ? snapshot.top_pages : [];
  for (const p of topPages.slice(0, limit)) {
    if (!p) continue;
    const url = _str(p.key || p.page || p.url, 2000);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    out.push({
      url,
      path: url,
      title: '',
      cluster: 'page',
      intent: 'unknown',
      position: _num(p.position, null),
      ctr: _num(p.ctr, null),
      clicks: _num(p.clicks, 0),
      impressions: _num(p.impressions, 0),
    });
  }

  // 2) commercial.cannibalization — отдельные «проблемные» страницы помечаем
  //    cluster=cannibalization, intent=ambiguous (если не пересекается с top).
  const commercial = snapshot.commercial && typeof snapshot.commercial === 'object'
    ? snapshot.commercial : null;
  if (commercial && Array.isArray(commercial.cannibalization)) {
    for (const c of commercial.cannibalization.slice(0, MAX_CANNIB_PAGES)) {
      if (!c) continue;
      const urls = Array.isArray(c.pages) ? c.pages : [c.page, c.url].filter(Boolean);
      for (const rawUrl of urls) {
        const url = _str(rawUrl, 2000);
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        out.push({
          url,
          path: url,
          cluster: _classifyClusterByQuery(c.query || c.key),
          intent: 'ambiguous',
          impressions: _num(c.impressions, 0),
          clicks: _num(c.clicks, 0),
        });
      }
    }
  }

  // 3) page_decay — страницы с трендом «вниз» помечаем weak_spq=null, но сам
  //    факт страницы сохраняется, чтобы seoBrain мог уловить thin/stale.
  const decay = snapshot.page_decay && typeof snapshot.page_decay === 'object'
    ? snapshot.page_decay : null;
  if (decay && Array.isArray(decay.declining_pages)) {
    for (const d of decay.declining_pages.slice(0, MAX_DECAY_PAGES)) {
      if (!d) continue;
      const url = _str(d.page || d.url, 2000);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      out.push({
        url,
        path: url,
        cluster: 'declining',
        intent: 'unknown',
        position: _num(d.last_position ?? d.position, null),
        clicks: _num(d.last_clicks ?? d.clicks, 0),
        impressions: _num(d.last_impressions ?? d.impressions, 0),
      });
    }
  }

  return out.slice(0, limit);
}

/**
 * computeProjectReward — простая reward-функция на базе periodCompare.
 *   reward = clamp(Δclicks_pct / 100, -1, +1)
 * Если periodCompare отсутствует — возвращает null.
 */
function computeProjectReward(snapshot) {
  const pc = snapshot && snapshot.period_compare && typeof snapshot.period_compare === 'object'
    ? snapshot.period_compare : null;
  if (!pc || pc.available === false) return null;
  const totals = pc.totals || pc.totals_delta || pc;
  const clicksPct = _num(totals.clicks_pct ?? totals.delta_clicks_pct, null);
  if (clicksPct == null) return null;
  const r = clicksPct / 100;
  if (r > 1) return 1;
  if (r < -1) return -1;
  return r;
}

/**
 * onAnalysisDone — главный «после успешного project_analyses» хук.
 * Вызывается из analysisRunner.processAnalysis() в самом конце.
 *
 * Все шаги best-effort и независимы — если seoBrain упадёт, datasetWriter
 * всё равно отработает.
 *
 * @param {object} db — pg-клиент (с методом query)
 * @param {object} args
 * @param {string} args.analysisId
 * @param {object} args.project — id, name, url, gsc_site_url
 * @param {object} args.snapshot — gsc_snapshot (как сохранили в DB)
 * @param {object} args.result   — meta из deepseek (model, tokens, cost)
 * @returns {Promise<{seoBrain:object, dataset:object, biobrain:object}>}
 */
async function onAnalysisDone(db, { analysisId, project, snapshot, result } = {}) {
  let flags;
  try { flags = (getAegisFlags().projects || {}).aegisHooks || {}; }
  catch (_e) { flags = {}; }

  const out = { seoBrain: null, dataset: null, biobrain: null };

  // 1) seoBrain snapshot
  if (flags.seoBrain !== false) {
    try {
      const pages = mapSnapshotToPages(snapshot, project);
      if (pages.length > 0) {
        const siteKey = _siteKeyForProject(project);
        const brainSnapshot = seoBrain.buildSeoBrainSnapshot({
          site: { site_key: siteKey, site_url: project && project.url ? project.url : '' },
          pages,
          signals: { source: 'projects_analysis', analysis_id: analysisId },
          autonomyStage: 'recommend',
        });
        out.seoBrain = await seoBrain.persistSnapshot(db, brainSnapshot);
      } else {
        out.seoBrain = { ok: false, reason: 'no_pages' };
      }
    } catch (e) {
      console.warn('[projects/aegisBridge] seoBrain failed:', e.message);
      out.seoBrain = { ok: false, reason: 'error', error: e.message };
    }
  }

  // 2) datasetWriter — обучающий пример с тематикой проекта.
  if (flags.trainingDataset !== false) {
    try {
      const niche = _str(project && project.name, 200) || _hostFromUrl(project && project.url) || null;
      const reportSummary = JSON.stringify({
        analysis_id: analysisId,
        site_key: _siteKeyForProject(project),
        totals: snapshot && snapshot.totals ? snapshot.totals : {},
        commercial: {
          available: !!(snapshot && snapshot.commercial && snapshot.commercial.available),
          commercial_clicks_pct: snapshot && snapshot.commercial ? _num(snapshot.commercial.commercial_clicks_pct, 0) : 0,
          striking_distance_count: snapshot && snapshot.commercial && Array.isArray(snapshot.commercial.striking_distance)
            ? snapshot.commercial.striking_distance.length : 0,
          cannibalization_count: snapshot && snapshot.commercial && Array.isArray(snapshot.commercial.cannibalization)
            ? snapshot.commercial.cannibalization.length : 0,
        },
        period_compare: snapshot && snapshot.period_compare ? {
          available: snapshot.period_compare.available !== false,
        } : null,
      });
      const userPrompt = [
        `project: ${project && project.name || ''}`,
        `url: ${project && project.url || ''}`,
        `gsc_site_url: ${project && project.gsc_site_url || ''}`,
      ].join('\n');
      out.dataset = await recordTrainingExample({
        articleRef: `projects_analysis:${analysisId}`,
        kind: 'projects_analysis',
        niche,
        userPrompt,
        htmlOutput: reportSummary,
        // SPQ для проектного анализа агрегированно не считается; используем
        // фиктивный 85, как делает meta_tags pipeline (см. memory/citations).
        qualityScore: { overall: 85, subscores: { eeat: 85, fact_check: 85, plagiarism: 85 } },
        gaMetrics: null,
        modelUsed: result && result.model || null,
        costUsd: _num(result && result.cost_usd, 0),
        userId: project && project.user_id || null,
      });
    } catch (e) {
      console.warn('[projects/aegisBridge] dataset failed:', e.message);
      out.dataset = { ok: false, reason: 'error', error: e.message };
    }
  }

  // 3) biobrainClient.feedback — необязательный сигнал NEAT-эволверу.
  if (flags.biobrain !== false) {
    const reward = computeProjectReward(snapshot);
    if (reward != null) {
      try {
        out.biobrain = await biobrainClient.feedback({
          features: {
            kind: 'projects_analysis',
            site_key: _siteKeyForProject(project),
            analysis_id: analysisId,
          },
          signals: {
            clicks: snapshot && snapshot.totals ? _num(snapshot.totals.clicks, 0) : 0,
            impressions: snapshot && snapshot.totals ? _num(snapshot.totals.impressions, 0) : 0,
          },
          // real_spq_overall в нашем контексте — это не SPQ статьи, а просто
          // нормализованный reward, размещённый в [0..100] для совместимости
          // с биобрейновским scale: reward в [-1..+1] → [0..100].
          real_spq_overall: Math.round((reward + 1) * 50),
        });
      } catch (e) {
        out.biobrain = { ok: false, reason: 'error', error: e.message };
      }
    } else {
      out.biobrain = { ok: false, reason: 'no_period_compare' };
    }
  }

  return out;
}

module.exports = {
  onAnalysisDone,
  mapSnapshotToPages,
  computeProjectReward,
  _siteKeyForProject,
};
