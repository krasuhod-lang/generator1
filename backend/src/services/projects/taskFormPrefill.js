'use strict';

/**
 * taskFormPrefill — единый маппинг «контекст проекта → поля формы задачи».
 *
 * Зачем: форма SEO-текста (CreateTaskPage) имеет описательные поля
 * «Целевая аудитория», «Ограничения проекта», «Приоритетные типы страниц»,
 * «Особенности ниши» и «Факты, цифры, доказательства». Раньше фронт пытался
 * заполнить их из `ctx.market.region` / `ctx.brand.audience` — таких путей в
 * contextResolver никогда не было, поэтому поля оставались пустыми даже при
 * выбранном проекте. Теперь маппинг живёт в одном месте и используется:
 *   • GET /api/projects/:id/context   → ctx.task_prefill (для форм);
 *   • POST /api/tasks (createTask)    → серверный fallback пустых полей.
 *
 * Принципы:
 *   • Никаких выдумок: строки собираются только из данных, которые реально
 *     есть в проекте (карточка проекта + последний анализ GSC/Яндекс).
 *   • Пустое значение = '' (потребитель сам решает, заполнять ли поле).
 *   • Каждое поле — plain text; RichTextInput на фронте сам превратит
 *     переносы строк в параграфы.
 */

const MAX_FIELD_CHARS = 4000;

/**
 * @param {object|null} ctx — результат buildProjectContext (или снапшот)
 * @returns {{
 *   input_region: string, input_brand_name: string,
 *   input_target_audience: string, input_niche_features: string,
 *   input_project_limits: string, input_page_priorities: string,
 *   input_brand_facts: string
 * }}
 */
function buildTaskFormPrefill(ctx) {
  const empty = {
    input_region: '',
    input_brand_name: '',
    input_target_audience: '',
    input_niche_features: '',
    input_project_limits: '',
    input_page_priorities: '',
    input_brand_facts: '',
  };
  if (!ctx || typeof ctx !== 'object' || !ctx.project) return empty;

  const project  = ctx.project  || {};
  const brand    = ctx.brand    || {};
  const market   = ctx.market   || {};
  const signals  = ctx.signals  || {};
  const criteria = _obj(project.content_criteria);

  return {
    input_region:          _clip(_str(project.region)),
    input_brand_name:      _clip(_str(brand.name) || _str(project.name)),
    input_target_audience: _clip(_str(project.audience)),
    input_niche_features:  _clip(_nicheFeatures(project, market, signals)),
    input_project_limits:  _clip(_projectLimits(project, brand, criteria)),
    input_page_priorities: _clip(_pagePriorities(market, signals)),
    input_brand_facts:     _clip(_brandFacts(project, brand)),
  };
}

/** «Особенности ниши»: ниша проекта + структура спроса из GSC/Яндекс. */
function _nicheFeatures(project, market, signals) {
  const lines = [];
  const niche = _str(project.niche);
  if (niche) lines.push(`Ниша проекта: ${niche}.`);

  const gsc = _obj(signals.gsc);
  const ydx = _obj(signals.ydx);
  const intentParts = [];
  if (gsc.top_intent) intentParts.push(`Google — преобладает интент «${gsc.top_intent}»${_sharePart(gsc)}`);
  if (ydx.top_intent) intentParts.push(`Яндекс — преобладает интент «${ydx.top_intent}»${_sharePart(ydx)}`);
  if (intentParts.length) lines.push(`Структура спроса: ${intentParts.join('; ')}.`);

  const brandShare = _num(market.brand_share);
  if (brandShare != null) {
    // brand_share приходит и в процентах (brand_share_pct), и долей 0..1 —
    // нормализуем перед сравнением, иначе 0.42 читается как «42 < 30».
    const brandPct = brandShare > 1 ? brandShare : brandShare * 100;
    lines.push(`Доля брендового трафика — ${_pct(brandShare)}: ${brandPct > 30
      ? 'спрос во многом брендовый, небрендовые запросы нужно отвоёвывать контентом'
      : 'спрос преимущественно небрендовый, решает релевантность контента'}.`);
  }

  const competitors = _list(market.competitors, 6).map((c) => (typeof c === 'string' ? c : _str(c && c.domain)));
  const cleanCompetitors = competitors.filter(Boolean);
  if (cleanCompetitors.length) {
    lines.push(`Конкуренты в выдаче: ${cleanCompetitors.join(', ')}.`);
  }

  return lines.join('\n');
}

/** «Ограничения проекта»: редакционные критерии + тон бренда. */
function _projectLimits(project, brand, criteria) {
  const lines = [];

  const stopWords = _list(criteria.stop_words, 30).map(_str).filter(Boolean);
  if (stopWords.length) lines.push(`Стоп-слова (не использовать): ${stopWords.join(', ')}.`);

  const disclaimers = _list(criteria.required_disclaimers, 10).map(_str).filter(Boolean);
  if (disclaimers.length) lines.push(`Обязательные дисклеймеры: ${disclaimers.join(' | ')}.`);

  const yearPolicy = _str(criteria.year_policy).toLowerCase();
  if (yearPolicy === 'omit') {
    lines.push('Год в тексте не упоминать (year_policy=omit).');
  } else if (yearPolicy === 'implicit') {
    lines.push('Год упоминать только при необходимости (year_policy=implicit).');
  }

  const tone = _str(brand.tone);
  if (tone) lines.push(`Тон коммуникации: ${tone}.`);

  const notes = _str(criteria.notes) || _str(criteria.requirements);
  if (notes) lines.push(`Редакционные требования: ${notes}.`);

  return lines.join('\n');
}

/** «Приоритетные типы страниц»: из основного интента + striking distance. */
function _pagePriorities(market, signals) {
  const lines = [];
  const intent = _str(market.top_intent).toLowerCase();
  const INTENT_HINTS = {
    transactional: 'коммерческие страницы услуг/товаров и категории — основной спрос транзакционный',
    commercial:    'страницы услуг, подборки и сравнения — спрос коммерческо-исследовательский',
    informational: 'информационные статьи и гайды — основной спрос информационный',
    navigational:  'бренд-страницы и страницы о компании — основной спрос навигационный',
  };
  if (INTENT_HINTS[intent]) lines.push(`Приоритет: ${INTENT_HINTS[intent]}.`);

  const striking = _list(signals.striking_distance, 50)
    .map((s) => _str(s && s.page))
    .filter(Boolean);
  const uniquePages = [...new Set(striking)].slice(0, 5);
  if (uniquePages.length) {
    lines.push(`Страницы на границе ТОПа (позиции 11–20) — приоритет на доработку: ${uniquePages.join(', ')}.`);
  }

  return lines.join('\n');
}

/** «Факты, цифры, доказательства»: факты бренда + ценовые/год-валюта ориентиры. */
function _brandFacts(project, brand) {
  const lines = [];
  for (const fact of _list(brand.facts, 8)) {
    const f = _str(fact);
    if (f) lines.push(`• ${f}`);
  }

  const pricing = _str(project.pricing_notes);
  if (pricing) lines.push(`• Ценовой ориентир: ${pricing}`);

  const year = _num(project.default_year);
  const currency = _str(project.default_currency);
  if (year != null && currency) lines.push(`• Актуальный год: ${year}; валюта: ${currency}`);
  else if (year != null)        lines.push(`• Актуальный год: ${year}`);
  else if (currency)            lines.push(`• Валюта: ${currency}`);

  const site = _str(project.site_url);
  if (lines.length && site) lines.push(`• Источник фактов: ${site}`);

  return lines.join('\n');
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function _str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}
function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function _list(v, n) { return Array.isArray(v) ? v.slice(0, n) : []; }
function _clip(s) {
  const str = _str(s);
  return str.length > MAX_FIELD_CHARS ? str.slice(0, MAX_FIELD_CHARS) : str;
}
function _pct(v) {
  const n = _num(v);
  if (n == null) return '—';
  return n > 1 ? `${n.toFixed(0)}%` : `${(n * 100).toFixed(0)}%`;
}
function _sharePart(summary) {
  const share = _num(summary.commercial_share);
  return share == null ? '' : ` (коммерческих запросов ${_pct(share)})`;
}

module.exports = { buildTaskFormPrefill };
