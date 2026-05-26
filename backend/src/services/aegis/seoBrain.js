'use strict';

/**
 * A.E.G.I.S. SEO Brain.
 *
 * Детерминированный центральный слой автономного SEO-агента:
 *   • SEO-память сайта (страницы / кластеры / интенты / ссылки / история);
 *   • reward model из GSC/GA4/keys.so/SPQ сигналов;
 *   • диагност просадок, каннибализации, thin/stale/intent issues;
 *   • безопасный планировщик действий (recommend → task → draft → human_review → autopilot).
 *
 * Здесь нет сетевых вызовов и LLM: модуль можно тестировать и запускать как
 * pure-function ядро, а контроллер уже решает, сохранять ли снапшот в БД.
 */

const DEFAULTS = Object.freeze({
  staleDays: 180,
  thinWordCount: 800,
  minCtr: 0.015,
  ctrDropPct: 0.25,
  positionDrop: 3,
  weakSpq: 78,
  cannibalizationPosition: 20,
  maxActions: 30,
  // A3: ограничения для persist — не хранить весь массив страниц в JSONB.
  maxPagesInMemory: 50,        // top-N проблемных URL вместо полного списка
  maxSnapshotBytes: 256 * 1024, // 256 KB на запись aegis_seo_memory
  // B5: верхний кап на /seo-brain/analyze, чтобы 200 MB JSON не прилетел.
  maxPagesPerAnalyze: 5000,
  lowRiskActionTypes: Object.freeze(['add_internal_links', 'refresh_title_meta', 'add_faq_block']),
  autonomyStages: Object.freeze(['recommend', 'task', 'draft', 'human_review', 'autopilot']),
});

function _num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _str(v, fallback = '') {
  return typeof v === 'string' ? v.trim() : fallback;
}

function _clamp(v, min = 0, max = 100) {
  const n = _num(v, min);
  return Math.max(min, Math.min(max, n));
}

function _pctDelta(current, previous) {
  const c = _num(current);
  const p = _num(previous);
  if (c == null || p == null || p === 0) return null;
  return (c - p) / Math.abs(p);
}

function _dateAgeDays(value, now = new Date()) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}

function _canonicalPath(urlOrPath) {
  const raw = _str(urlOrPath, '/');
  try {
    const u = new URL(raw, 'https://example.invalid');
    const p = u.pathname || '/';
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
  } catch (_) {
    const p = raw.split('?')[0].split('#')[0] || '/';
    return p.startsWith('/') ? p : `/${p}`;
  }
}

function normalizePage(input = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const path = _canonicalPath(input.path || input.url || input.pagePath || input.page_path);
  const history = Array.isArray(input.history) ? input.history : [];
  const previous = input.previous || history[history.length - 1] || {};
  const wordCount = _num(input.word_count ?? input.wordCount, null);
  const updatedAt = input.updated_at || input.updatedAt || input.published_at || input.publishedAt || null;
  const qualityScore = input.quality_score || input.qualityScore || {};
  const spq = _num(input.spq_overall ?? input.spqOverall ?? qualityScore.overall, null);
  const keysso = input.keysso_signals || input.keyssoSignals || {};
  const gsc = input.gsc || {};
  const ga4 = input.ga4 || {};

  return {
    url: _str(input.url, path),
    path,
    title: _str(input.title),
    cluster: _str(input.cluster || input.topic || input.niche, 'unknown') || 'unknown',
    intent: _str(input.intent || input.serp_intent || input.serpIntent, 'unknown') || 'unknown',
    detected_intent: _str(input.detected_intent || input.detectedIntent || input.intent_verdict?.detected_intent),
    position: _num(input.position ?? input.avg_position ?? input.avgPosition ?? gsc.position ?? keysso.avg_current_position, null),
    previous_position: _num(input.previous_position ?? input.previousPosition ?? previous.position, null),
    ctr: _num(input.ctr ?? gsc.ctr, null),
    previous_ctr: _num(input.previous_ctr ?? input.previousCtr ?? previous.ctr, null),
    clicks: _num(input.clicks ?? gsc.clicks, null),
    previous_clicks: _num(input.previous_clicks ?? input.previousClicks ?? previous.clicks, null),
    impressions: _num(input.impressions ?? gsc.impressions, null),
    previous_impressions: _num(input.previous_impressions ?? input.previousImpressions ?? previous.impressions, null),
    sessions: _num(input.sessions ?? ga4.sessions, null),
    engagement_rate: _num(input.engagement_rate ?? input.engagementRate ?? ga4.engagementRate, null),
    spq_overall: spq,
    quality_score: qualityScore,
    word_count: wordCount,
    updated_at: updatedAt,
    age_days: _dateAgeDays(updatedAt, now),
    internal_links_in: _num(input.internal_links_in ?? input.internalLinksIn, null),
    internal_links_out: _num(input.internal_links_out ?? input.internalLinksOut, null),
    keysso_signals: keysso,
    history,
  };
}

function buildSiteMemory({ pages = [], site = {}, now = new Date() } = {}) {
  const normalized = (Array.isArray(pages) ? pages : []).map((p) => normalizePage(p, { now }));
  const clusters = {};
  for (const p of normalized) {
    if (!clusters[p.cluster]) {
      clusters[p.cluster] = {
        key: p.cluster,
        pages: [],
        intents: {},
        avg_position: null,
        avg_ctr: null,
        avg_spq: null,
        total_clicks: 0,
        total_impressions: 0,
      };
    }
    const c = clusters[p.cluster];
    c.pages.push(p.path);
    c.intents[p.intent] = (c.intents[p.intent] || 0) + 1;
    c.total_clicks += _num(p.clicks, 0) || 0;
    c.total_impressions += _num(p.impressions, 0) || 0;
  }

  for (const c of Object.values(clusters)) {
    const clusterPages = normalized.filter((p) => p.cluster === c.key);
    c.avg_position = _avg(clusterPages.map((p) => p.position));
    c.avg_ctr = _avg(clusterPages.map((p) => p.ctr));
    c.avg_spq = _avg(clusterPages.map((p) => p.spq_overall));
    c.intent_count = Object.keys(c.intents).length;
    c.page_count = c.pages.length;
  }

  return {
    site_key: _str(site.site_key || site.siteKey || site.url || site.domain, 'default') || 'default',
    site_url: _str(site.site_url || site.siteUrl || site.url || site.domain),
    pages: normalized,
    clusters,
    totals: {
      pages: normalized.length,
      clusters: Object.keys(clusters).length,
      clicks: normalized.reduce((s, p) => s + (_num(p.clicks, 0) || 0), 0),
      impressions: normalized.reduce((s, p) => s + (_num(p.impressions, 0) || 0), 0),
    },
    updated_at: now.toISOString(),
  };
}

function computeSeoReward({ page = {}, previous = {}, weights = {} } = {}) {
  const w = {
    clicks: _num(weights.clicks, 0.18),
    impressions: _num(weights.impressions, 0.12),
    ctr: _num(weights.ctr, 0.18),
    position: _num(weights.position, 0.18),
    engagement: _num(weights.engagement, 0.12),
    quality: _num(weights.quality, 0.22),
  };

  const clickScore = _growthScore(_pctDelta(page.clicks, previous.clicks ?? page.previous_clicks));
  const impressionScore = _growthScore(_pctDelta(page.impressions, previous.impressions ?? page.previous_impressions));
  const ctrScore = page.ctr == null
    ? 50
    : _clamp((page.ctr / 0.08) * 100);
  const pos = _num(page.position);
  const prevPos = _num(previous.position ?? page.previous_position);
  const positionScore = pos == null
    ? 50
    : _clamp(105 - (pos * 5) + (prevPos != null ? (prevPos - pos) * 6 : 0));
  const engagementScore = page.engagement_rate == null ? 50 : _clamp(page.engagement_rate * 100);
  const qualityScore = page.spq_overall == null ? 50 : _clamp(page.spq_overall);

  const totalWeight = Object.values(w).reduce((s, x) => s + x, 0) || 1;
  const overall = (
    clickScore * w.clicks +
    impressionScore * w.impressions +
    ctrScore * w.ctr +
    positionScore * w.position +
    engagementScore * w.engagement +
    qualityScore * w.quality
  ) / totalWeight;

  return {
    overall: Math.round(_clamp(overall) * 10) / 10,
    components: {
      clicks: Math.round(clickScore * 10) / 10,
      impressions: Math.round(impressionScore * 10) / 10,
      ctr: Math.round(ctrScore * 10) / 10,
      position: Math.round(positionScore * 10) / 10,
      engagement: Math.round(engagementScore * 10) / 10,
      quality: Math.round(qualityScore * 10) / 10,
    },
  };
}

function diagnoseSiteMemory(siteMemory, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const pages = (siteMemory && siteMemory.pages) || [];
  const issues = [];

  for (const p of pages) {
    const ctrDelta = _pctDelta(p.ctr, p.previous_ctr);
    if (p.position != null && p.previous_position != null && p.position - p.previous_position >= cfg.positionDrop) {
      issues.push(_issue('position_drop', p, 'Позиция заметно просела', 90, {
        from: p.previous_position,
        to: p.position,
      }));
    }
    if (ctrDelta != null && ctrDelta <= -cfg.ctrDropPct) {
      issues.push(_issue('ctr_drop', p, 'CTR заметно снизился', 82, {
        previous_ctr: p.previous_ctr,
        ctr: p.ctr,
        delta_pct: Math.round(ctrDelta * 1000) / 10,
      }));
    }
    if (p.ctr != null && p.ctr < cfg.minCtr && p.impressions >= 100) {
      issues.push(_issue('low_ctr', p, 'Много показов, но слабый CTR', 72, {
        ctr: p.ctr,
        impressions: p.impressions,
      }));
    }
    if (p.word_count != null && p.word_count < cfg.thinWordCount) {
      issues.push(_issue('thin_content', p, 'Страница выглядит тонкой по объёму', 65, {
        word_count: p.word_count,
      }));
    }
    if (p.age_days != null && p.age_days > cfg.staleDays) {
      issues.push(_issue('stale_content', p, 'Контент давно не обновлялся', 60, {
        age_days: p.age_days,
      }));
    }
    if (p.spq_overall != null && p.spq_overall < cfg.weakSpq) {
      issues.push(_issue('weak_spq', p, 'SPQ ниже целевого уровня', 78, {
        spq_overall: p.spq_overall,
      }));
    }
    if (p.intent !== 'unknown' && p.detected_intent && p.detected_intent !== p.intent) {
      issues.push(_issue('intent_mismatch', p, 'Фактический intent не совпадает с целевым', 84, {
        expected: p.intent,
        detected: p.detected_intent,
      }));
    }
  }
  // B3: weak_internal_links — только когда сигнал реально доставлен.
  // Триггерим если: (a) явно задано in == 0, ИЛИ (b) хоть у одной страницы того же
  // кластера есть out > 0 (значит есть откуда линковать). Иначе шум.
  const someoneLinksOut = pages.some((p) => _num(p.internal_links_out, 0) > 0);
  for (const p of pages) {
    const linksInExplicit = p.internal_links_in != null;
    const noIncoming = linksInExplicit
      ? p.internal_links_in <= 0
      : someoneLinksOut && pages.length > 1; // если кто-то линкует, а сюда не приходят — подозрительно
    if (noIncoming && pages.length > 1) {
      const sameCluster = pages.filter((q) => q.cluster === p.cluster && q.path !== p.path);
      const candidatesExist = sameCluster.some((q) => _num(q.internal_links_out, 0) > 0);
      if (linksInExplicit || candidatesExist) {
        issues.push(_issue('weak_internal_links', p, 'На страницу не ведут внутренние ссылки', 55, {
          internal_links_in: p.internal_links_in,
        }));
      }
    }
  }

  const byIntent = new Map();
  for (const p of pages) {
    const key = `${p.cluster}::${p.intent}`;
    if (!byIntent.has(key)) byIntent.set(key, []);
    byIntent.get(key).push(p);
  }
  for (const group of byIntent.values()) {
    const contenders = group
      .filter((p) => p.intent !== 'unknown' && p.position != null && p.position <= cfg.cannibalizationPosition)
      .sort((a, b) => a.position - b.position);
    if (contenders.length >= 2) {
      issues.push({
        type: 'cannibalization',
        severity: 88,
        cluster: contenders[0].cluster,
        intent: contenders[0].intent,
        target_url: contenders[0].path,
        affected_urls: contenders.map((p) => p.path),
        message: 'Несколько страниц конкурируют за один cluster+intent',
        evidence: contenders.map((p) => ({ path: p.path, position: p.position })),
      });
    }
  }

  return {
    issues: issues.sort((a, b) => b.severity - a.severity).slice(0, 200),
    summary: _summarizeIssues(issues),
  };
}

function planSeoActions(siteMemory, diagnostics, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const stage = DEFAULTS.autonomyStages.includes(opts.autonomyStage) ? opts.autonomyStage : 'recommend';
  const issues = (diagnostics && diagnostics.issues) || [];
  const actions = [];

  for (const issue of issues) {
    const action = _actionForIssue(issue, stage, cfg);
    if (action) actions.push(action);
  }

  const dedup = new Map();
  for (const a of actions) {
    const key = `${a.action_type}:${a.target_url}:${a.cluster || ''}:${a.intent || ''}`;
    const prev = dedup.get(key);
    if (!prev || a.priority > prev.priority) dedup.set(key, a);
  }

  return {
    autonomy_stage: stage,
    actions: Array.from(dedup.values())
      .sort((a, b) => b.priority - a.priority)
      .slice(0, cfg.maxActions),
  };
}

function buildSeoBrainSnapshot({ site = {}, pages = [], signals = {}, autonomyStage = 'recommend', now = new Date() } = {}) {
  const memory = buildSiteMemory({ site, pages, now });
  const rewardByPage = {};
  for (const p of memory.pages) {
    rewardByPage[p.path] = computeSeoReward({ page: p });
  }
  const diagnostics = diagnoseSiteMemory(memory);
  const actionPlan = planSeoActions(memory, diagnostics, { autonomyStage });
  return {
    site_key: memory.site_key,
    site_url: memory.site_url,
    memory,
    signals: signals || {},
    reward: {
      overall: _avg(Object.values(rewardByPage).map((r) => r.overall)),
      pages: rewardByPage,
    },
    diagnostics,
    action_plan: actionPlan,
    capabilities: buildCapabilities(),
    updated_at: memory.updated_at,
  };
}

function buildCapabilities() {
  return {
    goal: 'автономная SEO-нейросистема: память → диагностика → reward → действия → обучение',
    inputs: ['GSC', 'GA4', 'keys.so', 'SPQ', 'SERP/relevance', 'internal_links', 'content_history'],
    memory: ['pages', 'clusters', 'intents', 'positions', 'ctr', 'cannibalization', 'links', 'change_history'],
    diagnostics: ['position_drop', 'ctr_drop', 'cannibalization', 'thin_content', 'stale_content', 'intent_mismatch', 'weak_spq'],
    reward: ['click_growth', 'impression_growth', 'ctr', 'position', 'engagement', 'quality'],
    autonomy_stages: DEFAULTS.autonomyStages,
    safety: {
      default_stage: 'recommend',
      autopilot_only_low_risk: true,
      low_risk_action_types: DEFAULTS.lowRiskActionTypes,
    },
  };
}

/**
 * A3: компактная репрезентация pages — top-N проблемных URL + агрегаты,
 * вместо полного массива. Полный массив больше нигде не запрашивается
 * (см. SELECT в getSeoBrainSnapshot), а в JSONB он раздувает диск и replication lag.
 */
function _compactPagesForPersist(pages, diagnostics, cfg) {
  const limit = cfg.maxPagesInMemory || DEFAULTS.maxPagesInMemory;
  const issuesByUrl = new Map();
  for (const issue of (diagnostics && diagnostics.issues) || []) {
    const url = issue.target_url;
    if (!url) continue;
    if (!issuesByUrl.has(url)) issuesByUrl.set(url, []);
    issuesByUrl.get(url).push({ type: issue.type, severity: issue.severity });
  }
  const ranked = (pages || []).map((p) => {
    const issues = issuesByUrl.get(p.path) || [];
    const maxSeverity = issues.reduce((m, i) => Math.max(m, i.severity || 0), 0);
    return { page: p, issues, maxSeverity };
  });
  ranked.sort((a, b) => {
    if (b.maxSeverity !== a.maxSeverity) return b.maxSeverity - a.maxSeverity;
    return (_num(b.page.impressions, 0) || 0) - (_num(a.page.impressions, 0) || 0);
  });
  const top = ranked.slice(0, limit).map(({ page, issues, maxSeverity }) => ({
    path: page.path,
    url: page.url,
    title: page.title,
    cluster: page.cluster,
    intent: page.intent,
    position: page.position,
    ctr: page.ctr,
    clicks: page.clicks,
    impressions: page.impressions,
    spq_overall: page.spq_overall,
    word_count: page.word_count,
    age_days: page.age_days,
    max_issue_severity: maxSeverity || null,
    issues,
  }));
  return {
    total: pages.length,
    truncated: pages.length > top.length,
    top_problem_urls: top,
  };
}

function _truncateToBudget(jsonString, byteBudget) {
  if (Buffer.byteLength(jsonString, 'utf8') <= byteBudget) return jsonString;
  // мягко режем массивы пока не уложимся
  try {
    const obj = JSON.parse(jsonString);
    if (obj && Array.isArray(obj.top_problem_urls)) {
      while (obj.top_problem_urls.length > 5
        && Buffer.byteLength(JSON.stringify(obj), 'utf8') > byteBudget) {
        obj.top_problem_urls.pop();
      }
      obj.truncated = true;
      return JSON.stringify(obj);
    }
  } catch (_) { /* noop */ }
  return jsonString;
}

async function persistSnapshot(db, snapshot, opts = {}) {
  if (!db || !snapshot || !snapshot.site_key) return { ok: false, reason: 'invalid_payload' };
  const cfg = { ...DEFAULTS, ...opts };

  // A3: компактные pages вместо полного массива.
  const compactPages = _compactPagesForPersist(
    snapshot.memory && snapshot.memory.pages,
    snapshot.diagnostics,
    cfg,
  );
  let pagesJson = JSON.stringify(compactPages);
  pagesJson = _truncateToBudget(pagesJson, cfg.maxSnapshotBytes);

  // B4: транзакция — memory UPSERT + N×action UPSERT атомарно.
  const client = typeof db.connect === 'function' ? await db.connect() : null;
  const exec = client ? (q, p) => client.query(q, p) : (q, p) => db.query(q, p);
  try {
    if (client) await exec('BEGIN', []);
    await exec(
      `INSERT INTO aegis_seo_memory
         (site_key, site_url, pages, clusters, signals, reward, diagnostics, action_plan, autonomy_stage, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, NOW())
       ON CONFLICT (site_key)
       DO UPDATE SET
         site_url = EXCLUDED.site_url,
         pages = EXCLUDED.pages,
         clusters = EXCLUDED.clusters,
         signals = EXCLUDED.signals,
         reward = EXCLUDED.reward,
         diagnostics = EXCLUDED.diagnostics,
         action_plan = EXCLUDED.action_plan,
         autonomy_stage = EXCLUDED.autonomy_stage,
         updated_at = NOW()`,
      [
        snapshot.site_key,
        snapshot.site_url || null,
        pagesJson,
        JSON.stringify(snapshot.memory.clusters || {}),
        JSON.stringify(snapshot.signals || {}),
        JSON.stringify(snapshot.reward || {}),
        JSON.stringify(snapshot.diagnostics || {}),
        JSON.stringify(snapshot.action_plan || {}),
        snapshot.action_plan.autonomy_stage || 'recommend',
      ],
    );

    for (const action of snapshot.action_plan.actions || []) {
      await exec(
        `INSERT INTO aegis_seo_actions
           (site_key, action_key, action_type, target_url, cluster, intent, priority, status, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'recommended', $8::jsonb)
         ON CONFLICT (site_key, action_key)
         DO UPDATE SET
           action_type = EXCLUDED.action_type,
           target_url = EXCLUDED.target_url,
           cluster = EXCLUDED.cluster,
           intent = EXCLUDED.intent,
           priority = EXCLUDED.priority,
           payload = EXCLUDED.payload,
           updated_at = NOW()`,
        [
          snapshot.site_key,
          action.action_key,
          action.action_type,
          action.target_url || null,
          action.cluster || null,
          action.intent || null,
          action.priority,
          JSON.stringify(action),
        ],
      );
    }
    if (client) await exec('COMMIT', []);
    return { ok: true, actions: (snapshot.action_plan.actions || []).length };
  } catch (e) {
    if (client) {
      try { await exec('ROLLBACK', []); } catch (_) { /* noop */ }
    }
    throw e;
  } finally {
    if (client && typeof client.release === 'function') client.release();
  }
}

function _avg(values) {
  const nums = (values || []).map((v) => _num(v)).filter((v) => v != null);
  if (!nums.length) return null;
  return Math.round((nums.reduce((s, x) => s + x, 0) / nums.length) * 100) / 100;
}

function _growthScore(delta) {
  if (delta == null) return 50;
  return _clamp(50 + (delta * 100));
}

function _issue(type, page, message, severity, evidence = {}) {
  return {
    type,
    severity,
    target_url: page.path,
    cluster: page.cluster,
    intent: page.intent,
    message,
    evidence,
  };
}

function _summarizeIssues(issues) {
  const byType = {};
  for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1;
  return {
    total: issues.length,
    by_type: byType,
    critical: issues.filter((i) => i.severity >= 85).length,
    review: issues.filter((i) => i.severity >= 65 && i.severity < 85).length,
    low: issues.filter((i) => i.severity < 65).length,
  };
}

function _actionForIssue(issue, stage, cfg) {
  const map = {
    position_drop: 'update_article',
    ctr_drop: 'refresh_title_meta',
    low_ctr: 'refresh_title_meta',
    thin_content: 'expand_article',
    stale_content: 'update_article',
    weak_spq: 'improve_eeat',
    intent_mismatch: 'rewrite_for_intent',
    weak_internal_links: 'add_internal_links',
    cannibalization: 'merge_or_canonicalize',
  };
  const actionType = map[issue.type];
  if (!actionType) return null;
  const safeStage = stage === 'autopilot' && !cfg.lowRiskActionTypes.includes(actionType)
    ? 'human_review'
    : stage;
  const actionKey = _hashKey([actionType, issue.target_url, issue.cluster, issue.intent, issue.type].join('|'));
  return {
    action_key: actionKey,
    action_type: actionType,
    target_url: issue.target_url,
    affected_urls: issue.affected_urls || [],
    cluster: issue.cluster || null,
    intent: issue.intent || null,
    priority: issue.severity,
    autonomy_stage: safeStage,
    requires_human_review: safeStage !== 'recommend' && safeStage !== 'task' && safeStage !== 'autopilot',
    low_risk: cfg.lowRiskActionTypes.includes(actionType),
    reason: issue.message,
    source_issue: issue.type,
    evidence: issue.evidence || {},
  };
}

function _hashKey(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `seo_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

module.exports = {
  DEFAULTS,
  normalizePage,
  buildSiteMemory,
  computeSeoReward,
  diagnoseSiteMemory,
  planSeoActions,
  buildSeoBrainSnapshot,
  buildCapabilities,
  persistSnapshot,
  _canonicalPath,
};
