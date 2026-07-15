'use strict';

/**
 * metaTags/gistMetaFilter — GIST Meta Filter Pipeline (Задача D).
 *
 * Заменяет прежний одновызовный generateDrMaxMeta трёхфазной selection-задачей
 * из 11 шагов (Steps 8.1–8.11):
 *
 *   Фаза 1. Candidate generation  — MetaCandidateGenerator (Steps 8.1–8.4):
 *           задача поля, 3–5 кандидатов-фактов (page angle + missing nodes +
 *           5 эвристик), карта шаблонов конкурентов.
 *   Фаза 2. Filter + scoring      — GISTMetaFilterRanker (Steps 8.5/8.5b/8.6):
 *           4 бинарных теста, forced-choice fallback sequence, tie-break
 *           scoring 0–2 (surprise / verification_cost / intent_specificity).
 *   Фаза 3. Pair generation + conflict check — MetaPairAssembler (8.7–8.8) +
 *           MetaConflictAndReplaceabilityChecker (8.9–8.10) с ретраями:
 *           конфликт → пересборка description вокруг другого кандидата,
 *           replaceability failed → повтор 8.6–8.8 со следующим кандидатом.
 *
 * LLM-роутинг (конвенция репозитория): аналитические вызовы (кандидаты,
 * фильтр/ранкер, валидатор) — DeepSeek (fallback на Gemini при отсутствии
 * ключа/ошибке), копирайтинг (сборка пары) — Gemini.
 *
 * Кириллические safe ranges (§4): Title 40–50, Description desktop 130–145,
 * Description mobile 90–105; GIST-фактор — в первых 35 симв. title и первых
 * 90 симв. description.
 */

const { callGemini } = require('../llm/gemini.adapter');
const { trimToLastWord, trimToLastSentence } = require('./lengthHelpers');
const {
  CANDIDATE_GENERATOR_SYSTEM,
  FILTER_RANKER_SYSTEM,
  PAIR_ASSEMBLER_SYSTEM,
  CONFLICT_CHECKER_SYSTEM,
} = require('./gistMetaPrompts');

// Кириллические safe ranges (§4 ТЗ). Английские лимиты не применимы.
const TITLE_MIN = 40;
const TITLE_MAX = 50;
const DESC_MIN = 130;
const DESC_MAX = 145;
const DESC_MOBILE_MIN = 90;
const DESC_MOBILE_MAX = 105;
const H1_MAX = 70;
const TITLE_FACT_WINDOW = 35;
const DESC_FACT_WINDOW = 90;

// §7: абстрактные слова, запрещённые как differentiator в title.
const ABSTRACT_WORDS_RE = /(?:^|[\s,—|-])(качественн\w*|лучш\w*|надежн\w*|надёжн\w*|выгодн\w*|идеальн\w*|профессиональн\w*|широкий\s+ассортимент|индивидуальный\s+подход|доступн\w+\s+цен\w*|высокое\s+качество)(?=[\s,.!?—|-]|$)/i;

// §6: temporal stability rule — временные факторы (цена/скидка/дедлайн/сток).
const TEMPORAL_RE = /(скидк\w*|акци\w*|распродаж\w*|до\s+конца\s+\w+|только\s+до|осталось\s+\d|в\s+наличии|успей\w*|дедлайн\w*|\d[\d\s]*\s*(?:₽|руб))/i;

// Пауза review для временного GIST-фактора в title (§6): +30 дней.
const TEMPORAL_REVIEW_DAYS = 30;

const MAX_PAIR_ATTEMPTS = 3;
const MAX_PARSE_ATTEMPTS = 2;

const VALID_SOURCES = new Set([
  'page_angle', 'missing_node', 'failure_mode', 'hidden_info', 'limitation',
  'disqualifier', 'quantifiable', 'fallback_supercategory', 'fallback_structural',
]);

function _parseJson(text) {
  // Ленивый require — metaGenerator требует этот модуль (избегаем циклической
  // инициализации CJS).
  const { parseMetaJson } = require('./metaGenerator');
  return parseMetaJson(text);
}

/**
 * Аналитический LLM-вызов со строгим JSON-контрактом: DeepSeek primary,
 * Gemini fallback (нет ключа / ошибка вызова). Ретрай на ошибке парсинга.
 */
async function _callAnalyticJson(systemPrompt, userPrompt, usage, opts = {}) {
  const { callDeepSeek } = require('../llm/deepseek.adapter');
  const callOptions = {
    temperature: opts.temperature ?? 0.3,
    maxTokens: opts.maxTokens ?? 6000,
    timeoutMs: opts.timeoutMs ?? 120000,
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt += 1) {
    let res;
    if (process.env.DEEPSEEK_API_KEY) {
      try {
        res = await callDeepSeek(systemPrompt, userPrompt, callOptions);
        res.provider = 'deepseek';
      } catch (dsErr) {
        res = await callGemini(systemPrompt, userPrompt, callOptions);
        res.provider = 'gemini';
      }
    } else {
      res = await callGemini(systemPrompt, userPrompt, callOptions);
      res.provider = 'gemini';
    }
    usage.tokensIn += res.tokensIn || 0;
    usage.tokensOut += res.tokensOut || 0;
    usage.thoughtsTokens += res.thoughtsTokens || 0;
    usage.cachedTokens += res.cachedTokens || 0;
    usage.calls += 1;
    if (!usage.model) usage.model = res.model || '';
    usage.providers.add(res.provider);
    try {
      return _parseJson(res.text);
    } catch (parseErr) {
      lastErr = parseErr;
    }
  }
  throw lastErr;
}

/** Копирайтерский вызов (сборка пары) — Gemini, модель прокидывается сверху. */
async function _callCopywriterJson(userPrompt, usage, opts = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt += 1) {
    const res = await callGemini(PAIR_ASSEMBLER_SYSTEM, userPrompt, {
      temperature: opts.temperature ?? 0.4,
      maxTokens: opts.maxTokens ?? 4096,
      timeoutMs: opts.timeoutMs ?? 90000,
      ...(opts.model ? { model: opts.model } : {}),
    });
    usage.tokensIn += res.tokensIn || 0;
    usage.tokensOut += res.tokensOut || 0;
    usage.thoughtsTokens += res.thoughtsTokens || 0;
    usage.cachedTokens += res.cachedTokens || 0;
    usage.calls += 1;
    if (res.model) usage.model = res.model;
    usage.providers.add('gemini');
    try {
      return _parseJson(res.text);
    } catch (parseErr) {
      lastErr = parseErr;
    }
  }
  throw lastErr;
}

// ─── Фаза 1: Candidate generation (Steps 8.1–8.4) ──────────────────

function _buildCandidateUserPrompt({ keyword, semantics = {}, serpData = [], inputs = {} }) {
  const contextParts = [];
  if (inputs.niche) contextParts.push(`Тема страницы: ${inputs.niche}`);
  if (inputs.toponym) contextParts.push(`Регион: ${inputs.toponym}`);
  if (inputs.brand) contextParts.push(`Бренд: ${inputs.brand}`);
  if (inputs.summary) contextParts.push(`УТП / факты: ${inputs.summary}`);
  if (inputs.page_context && inputs.page_context !== inputs.summary) {
    contextParts.push(`Данные страницы: ${inputs.page_context}`);
  }
  const priceData = inputs.price_data ?? inputs.priceData ?? null;

  // Page angle / missing nodes (Steps 1–7 GIST страницы, если проходились) —
  // первые кандидаты по ТЗ Step 8.2.
  const pageAngle = String(inputs.pageAngle || inputs.page_angle || '').trim();
  const missingNodes = Array.isArray(inputs.missingNodes || inputs.missing_nodes)
    ? (inputs.missingNodes || inputs.missing_nodes).filter(Boolean).slice(0, 8)
    : [];

  const competitors = (serpData || [])
    .map((c, i) => {
      const desc = c.snippet || c.description || '';
      return `[${i + 1}] Title: ${c.title || ''}${desc ? `\n    Description: ${desc}` : ''}`;
    })
    .join('\n');

  const ctr = inputs.ctrAnalysis;
  const ctrBlock = ctr && ctr.patterns
    ? `\n[ДЕТЕРМИНИРОВАННЫЕ ПАТТЕРНЫ ТОПа]
- Штампованные начала: ${(ctr.patterns.common_prefixes || []).join(', ') || '—'}
- Штампованные хвосты: ${(ctr.patterns.common_suffixes || []).join(', ') || '—'}
- SERP_INTENT: ${(ctr.serp_intent && ctr.serp_intent.value) || 'Mixed/Unclear'}`
    : '';

  const lsiBlock = [
    (semantics.title_mandatory_words || []).length
      ? `- Важные слова ТОПа: ${semantics.title_mandatory_words.slice(0, 6).join(', ')}`
      : '',
    (semantics.differentiator_lsi || []).length
      ? `- Уникальные LSI (нет ни у одного конкурента — сырьё для кандидатов): ${semantics.differentiator_lsi.join(', ')}`
      : '',
  ].filter(Boolean).join('\n');

  return `[ВХОДНЫЕ ДАННЫЕ]
- Главный поисковый запрос: ${keyword}
- Контекст страницы: ${contextParts.join(' | ') || 'Нет данных'}
- Проверенная цена (price_data): ${priceData || 'null'}${pageAngle ? `
- Page angle страницы (первый кандидат): ${pageAngle}` : ''}${missingNodes.length ? `
- Missing semantic nodes страницы (первые кандидаты): ${missingNodes.join('; ')}` : ''}${lsiBlock ? `
${lsiBlock}` : ''}

[TITLE/DESCRIPTION КОНКУРЕНТОВ ТОП-ВЫДАЧИ]
${competitors || 'Нет данных о конкурентах — оцени общий шаблон категории по своим знаниям выдачи.'}${ctrBlock}

Выполни Steps 8.1–8.4 и верни JSON по контракту.`;
}

// ─── Фаза 2: Filter + scoring (Steps 8.5 / 8.5b / 8.6) ─────────────

function _buildRankerUserPrompt({ keyword, phase1 }) {
  return `[ВХОДНЫЕ ДАННЫЕ]
- Главный поисковый запрос: ${keyword}
- Задача поля (Step 8.1): ${JSON.stringify(phase1.field_job || {}, null, 2)}
- Карта конкурентов (Step 8.4): ${JSON.stringify(phase1.competitor_pattern || {}, null, 2)}

[КАНДИДАТЫ-ФАКТЫ]
${JSON.stringify(phase1.candidates || [], null, 2)}

Кандидаты с disqualified_by_template: true уже провалили первый pass
Replaceability — исключи их (survived: false), кроме случая, когда без них
пул пуст и они спасаемы через fallback sequence.

Выполни Steps 8.5, 8.5b и 8.6 и верни JSON по контракту.`;
}

function _sortRanked(ranked) {
  return ranked.slice().sort((a, b) => (b.total - a.total)
    || (b.intent_specificity - a.intent_specificity)
    || (b.surprise_value - a.surprise_value));
}

function _normalizeRankedItem(item) {
  const bin = (v) => (Number(v) >= 1 ? 1 : 0);
  const axis = (v) => Math.max(0, Math.min(2, Number(v) || 0));
  const out = {
    fact: String(item.fact || '').trim(),
    source: VALID_SOURCES.has(item.source) ? item.source : 'missing_node',
    concreteness: bin(item.concreteness),
    decision_relevance: bin(item.decision_relevance),
    replaceability: bin(item.replaceability),
    verifiability: bin(item.verifiability),
    survived: item.survived !== false,
    surprise_value: axis(item.surprise_value),
    verification_cost: axis(item.verification_cost),
    intent_specificity: axis(item.intent_specificity),
    temporal: item.temporal === true,
    requires_proof_in_description: item.requires_proof_in_description === true,
  };
  out.total = out.surprise_value + out.verification_cost + out.intent_specificity;
  // Факт, проваливший более одного теста, исключается (Step 8.5) —
  // страхуем детерминированно, не доверяя survived-полю модели.
  const failed = 4 - (out.concreteness + out.decision_relevance
    + out.replaceability + out.verifiability);
  if (failed > 1) out.survived = false;
  return out;
}

// ─── Фаза 3: Pair generation (Steps 8.7–8.8) ───────────────────────

function _buildAssemblerUserPrompt({
  keyword, inputs = {}, winner, alternates, phase1, standaloneExposure, feedback,
}) {
  const alternateFacts = alternates.map((a) => `- ${a.fact} (source: ${a.source})`).join('\n');
  return `[ВХОДНЫЕ ДАННЫЕ]
- Главный поисковый запрос: ${keyword}
- Бренд: ${inputs.brand || '—'}
- Регион: ${inputs.toponym || '—'}
- Контекст / УТП страницы: ${inputs.summary || inputs.page_context || 'Нет данных'}
- Задача поля (Step 8.1): ${JSON.stringify(phase1.field_job || {})}
- standalone_exposure: ${standaloneExposure ? 'true (страница рассчитана на standalone-дистрибуцию: соцсети / AI summaries / voice previews — GIST-фактор осознанно ставится в начало description)' : 'false'}

[WINNER FACT — единственный GIST-фактор для TITLE]
${JSON.stringify(winner, null, 2)}

[ЗАПАСНЫЕ КАНДИДАТЫ — lead fact для DESCRIPTION]
${alternateFacts || '— (запасных нет: используй новую смысловую ось того же факта — спецификацию/число/proof, не перефразирование)'}
${feedback ? `
[ФИДБЕК ПРЕДЫДУЩЕЙ ПОПЫТКИ — ОБЯЗАТЕЛЬНО ИСПРАВИТЬ]
${feedback}` : ''}
Собери пару по Steps 8.7–8.8 и верни JSON по контракту.`;
}

function _deterministicPairFix(pair, notes) {
  if (typeof pair.title === 'string' && pair.title.length > TITLE_MAX) {
    pair.title = trimToLastWord(pair.title, TITLE_MAX);
    notes.push(`Title обрезан до ${pair.title.length} симв. (кириллический лимит ${TITLE_MAX}).`);
  }
  if (typeof pair.description === 'string' && pair.description.length > DESC_MAX) {
    pair.description = trimToLastSentence(pair.description, DESC_MAX);
    notes.push(`Description обрезан до ${pair.description.length} симв. (лимит ${DESC_MAX}).`);
  }
  if (typeof pair.description_mobile === 'string' && pair.description_mobile.length > DESC_MOBILE_MAX) {
    pair.description_mobile = trimToLastSentence(pair.description_mobile, DESC_MOBILE_MAX);
  }
  if (typeof pair.h1 === 'string' && pair.h1.length > H1_MAX) {
    pair.h1 = trimToLastWord(pair.h1, H1_MAX);
  }
  return pair;
}

/** Детерминированные нарушения пары (§7-антипаттерны, проверяемые кодом). */
function _deterministicPairIssues(pair) {
  const issues = [];
  const title = String(pair.title || '');
  if (!title.trim()) issues.push('пустой title');
  const abstractHit = title.match(ABSTRACT_WORDS_RE);
  if (abstractHit) {
    issues.push(`абстрактное слово-differentiator в title: «${abstractHit[1]}»`);
  }
  if (title.length < TITLE_MIN) {
    issues.push(`title короче кириллического safe range (${title.length} < ${TITLE_MIN})`);
  }
  const desc = String(pair.description || '');
  if (desc.length < DESC_MIN) {
    issues.push(`description короче safe range (${desc.length} < ${DESC_MIN})`);
  }
  return issues;
}

// ─── Валидатор: Steps 8.9–8.10 ─────────────────────────────────────

function _buildCheckerUserPrompt({ pair, winner, standaloneExposure, phase1 }) {
  return `[ПАРА ДЛЯ ПРОВЕРКИ]
- Title: ${pair.title}
- Description: ${pair.description}
- GIST-фактор title (winner fact): ${winner.fact}
- standalone_exposure: ${standaloneExposure ? 'true' : 'false'}
- Общий шаблон конкурентов: ${JSON.stringify((phase1 && phase1.competitor_pattern) || {})}

Выполни Steps 8.9 и 8.10 и верни JSON по контракту.`;
}

// ─── §6: temporal stability rule ───────────────────────────────────

function _temporalReview(winner, pair) {
  const inTitle = TEMPORAL_RE.test(String(pair.title || ''));
  const temporalWinner = winner.temporal === true || TEMPORAL_RE.test(winner.fact);
  if (!(inTitle && temporalWinner)) return { temporary_gist_factor: false, review_date: null };
  const d = new Date();
  d.setDate(d.getDate() + TEMPORAL_REVIEW_DAYS);
  return {
    temporary_gist_factor: true,
    review_date: d.toISOString().slice(0, 10),
  };
}

// ─── Step 8.11: template-level GIST для каталогов ──────────────────

/**
 * Проверка template-level conflict: если один и тот же фактор (нормализованный
 * токен, не входящий в главный запрос) появляется более чем в 70% title —
 * шаблон нужно усложнить вторым слотом.
 *
 * @param {string[]} titles     — готовые title каталога (slot-fillers)
 * @param {object}   [opts]     — { threshold=0.7, excludeWords: string[] }
 * @returns {{passed:boolean, dominant_factor:string|null, share:number}}
 */
function checkTemplateLevelConflict(titles = [], opts = {}) {
  const threshold = opts.threshold ?? 0.7;
  const list = (titles || []).map((t) => String(t || '').toLowerCase()).filter(Boolean);
  if (list.length < 3) return { passed: true, dominant_factor: null, share: 0 };

  const { normalizeWord, STOP_WORDS } = require('./semantics');
  const exclude = new Set((opts.excludeWords || []).map((w) => normalizeWord(String(w).toLowerCase())));
  const docFreq = new Map();
  for (const title of list) {
    const tokens = new Set(
      (title.match(/[а-яёa-z0-9-]{4,}/gi) || [])
        .map((w) => normalizeWord(w))
        .filter((w) => w && !STOP_WORDS.has(w) && !exclude.has(w)),
    );
    for (const tok of tokens) docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
  }
  let dominant = null;
  let best = 0;
  for (const [tok, df] of docFreq) {
    if (df > best) { best = df; dominant = tok; }
  }
  const share = best / list.length;
  if (dominant && share > threshold) {
    return { passed: false, dominant_factor: dominant, share: Number(share.toFixed(2)) };
  }
  return { passed: true, dominant_factor: null, share: Number(share.toFixed(2)) };
}

// ─── Главный оркестратор ───────────────────────────────────────────

/**
 * GIST Meta Filter Pipeline (11 шагов, три фазы).
 *
 * @param {object} args
 * @param {string} args.keyword    — главный поисковый запрос страницы
 * @param {object} [args.semantics] — результат extractSemantics()
 * @param {Array}  [args.serpData]  — конкуренты ТОП-выдачи
 * @param {object} [args.inputs]    — brand/niche/toponym/summary/page_context/
 *   price_data/pageAngle/missingNodes/ctrAnalysis/standalone_exposure
 * @param {object} [args.options]   — { copywriterModel }
 * @returns {Promise<object>} JSON-контракт §8 + h1/description_mobile/_meta
 */
async function runGistMetaPipeline({
  keyword, semantics = {}, serpData = [], inputs = {}, options = {},
}) {
  const usage = {
    tokensIn: 0, tokensOut: 0, thoughtsTokens: 0, cachedTokens: 0,
    calls: 0, model: '', providers: new Set(),
  };
  const notes = [];
  const standaloneExposure = inputs.standalone_exposure === true
    || inputs.standaloneExposure === true;

  // ── Фаза 1: Candidate generation (Steps 8.1–8.4) ──
  const phase1 = await _callAnalyticJson(
    CANDIDATE_GENERATOR_SYSTEM,
    _buildCandidateUserPrompt({ keyword, semantics, serpData, inputs }),
    usage,
  );
  const candidates = Array.isArray(phase1.candidates)
    ? phase1.candidates.filter((c) => c && String(c.fact || '').trim())
    : [];
  if (!candidates.length) {
    throw new Error('GIST Meta Filter: не удалось собрать ни одного кандидата-факта (Step 8.2)');
  }

  // ── Фаза 2: Filter + scoring (Steps 8.5 / 8.5b / 8.6) ──
  const phase2 = await _callAnalyticJson(
    FILTER_RANKER_SYSTEM,
    _buildRankerUserPrompt({ keyword, phase1 }),
    usage,
  );
  const rankedAll = Array.isArray(phase2.ranked)
    ? phase2.ranked.map(_normalizeRankedItem).filter((r) => r.fact)
    : [];
  let survivors = _sortRanked(rankedAll.filter((r) => r.survived));
  let manualReviewRequired = phase2.manual_review_required === true;
  let manualReviewReason = phase2.manual_review_reason || null;

  if (!survivors.length) {
    // Step 8.5b п.4: escalate to human editor — но пару собираем best-effort
    // из лучшего доступного кандидата, чтобы редактору было что править.
    manualReviewRequired = true;
    manualReviewReason = manualReviewReason
      || 'Ни один кандидат не прошёл GIST Meta Filter и forced-choice sequence';
    survivors = _sortRanked(rankedAll);
  }
  if (!survivors.length) {
    throw new Error(
      `GIST Meta Filter: manual_review_required — ${manualReviewReason || 'пустой пул кандидатов после фильтра'}`,
    );
  }
  if (manualReviewRequired) {
    notes.push(`⚠️ manual_review_required: ${manualReviewReason || 'см. fallback sequence (Step 8.5b)'}`);
  }
  if (phase2.fallback_used) {
    notes.push(`Fallback sequence (Step 8.5b): использован «${phase2.fallback_used}».`);
  }

  // ── Фаза 3: Pair generation + conflict/replaceability (8.7–8.10) ──
  let winnerIdx = 0;
  let pair = null;
  let conflictCheck = { passed: true, detail: null };
  let replaceabilityCheck = { passed: true, detail: null };
  let feedback = '';

  for (let attempt = 1; attempt <= MAX_PAIR_ATTEMPTS; attempt += 1) {
    const winner = survivors[winnerIdx];
    const alternates = survivors.filter((_, i) => i !== winnerIdx).slice(0, 3);

    pair = await _callCopywriterJson(
      _buildAssemblerUserPrompt({
        keyword, inputs, winner, alternates, phase1, standaloneExposure, feedback,
      }),
      usage,
      { model: options.copywriterModel },
    );
    _deterministicPairFix(pair, notes);

    const hardIssues = _deterministicPairIssues(pair);
    if (hardIssues.length && attempt < MAX_PAIR_ATTEMPTS) {
      feedback = `Детерминированные нарушения: ${hardIssues.join('; ')}. Перепиши пару, устранив их.`;
      notes.push(`Попытка ${attempt}: ${hardIssues.join('; ')} — пересборка.`);
      continue;
    }
    if (hardIssues.length) {
      notes.push(`⚠️ Остались нарушения после ${attempt} попыток: ${hardIssues.join('; ')}.`);
    }

    // Steps 8.9–8.10 — semantic conflict + pair replaceability.
    const check = await _callAnalyticJson(
      CONFLICT_CHECKER_SYSTEM,
      _buildCheckerUserPrompt({ pair, winner, standaloneExposure, phase1 }),
      usage,
      { maxTokens: 2000 },
    );
    conflictCheck = {
      passed: !!(check.conflict_check && check.conflict_check.passed),
      detail: (check.conflict_check && check.conflict_check.detail) || null,
    };
    replaceabilityCheck = {
      passed: !!(check.replaceability_check && check.replaceability_check.passed),
      detail: (check.replaceability_check && check.replaceability_check.detail) || null,
    };
    if (conflictCheck.passed && replaceabilityCheck.passed) break;
    if (attempt === MAX_PAIR_ATTEMPTS) {
      notes.push('⚠️ Пара не прошла все проверки за отведённые попытки — требуется ручная правка.');
      manualReviewRequired = true;
      break;
    }

    if (!replaceabilityCheck.passed) {
      // Step 8.10: selection failed — повтор 8.6–8.8 со следующим кандидатом.
      if (winnerIdx + 1 < survivors.length) {
        winnerIdx += 1;
        feedback = `Предыдущая пара провалила pair-level Replaceability: ${replaceabilityCheck.detail || 'конкурент может переиспользовать пару'}. Собери пару вокруг НОВОГО winner fact.`;
        notes.push(`Попытка ${attempt}: replaceability failed — переход к следующему кандидату (Step 8.10).`);
      } else {
        feedback = `Пара провалила pair-level Replaceability: ${replaceabilityCheck.detail || ''}. Других кандидатов нет — усили специфичность формулировок вокруг того же факта.`;
        notes.push(`Попытка ${attempt}: replaceability failed, кандидаты исчерпаны — пересборка формулировок.`);
      }
    } else if (!conflictCheck.passed) {
      // Step 8.9: конфликт — description перестраивается вокруг другого
      // кандидата; если запасных нет — GIST-фактор переносится в description,
      // title перестраивается вокруг следующего кандидата.
      if (survivors.length > 1) {
        feedback = `Semantic conflict title↔description: ${conflictCheck.detail || 'description перефразирует GIST-фактор title'}. Перестрой description вокруг ДРУГОГО запасного кандидата; title не меняй по смыслу.`;
        notes.push(`Попытка ${attempt}: semantic conflict — пересборка description вокруг другого кандидата (Step 8.9).`);
      } else {
        feedback = `Semantic conflict: ${conflictCheck.detail || ''}. Запасных кандидатов нет — перенеси GIST-фактор в начало description и перестрой title вокруг новой смысловой оси (спецификация/процесс), сохранив главный запрос.`;
        notes.push(`Попытка ${attempt}: semantic conflict без запасных кандидатов — перенос GIST-фактора в description (Step 8.9).`);
      }
    }
  }

  const winner = survivors[winnerIdx];
  const temporal = _temporalReview(winner, pair);
  if (temporal.temporary_gist_factor) {
    notes.push(`⚠️ temporary_gist_factor: временный фактор в title — review до ${temporal.review_date} (§6).`);
  }

  return {
    title: String(pair.title || ''),
    description: String(pair.description || ''),
    description_mobile: String(pair.description_mobile || ''),
    h1: String(pair.h1 || ''),
    winner_fact: winner.fact,
    winner_source: winner.source,
    scores: {
      concreteness: winner.concreteness,
      decision_relevance: winner.decision_relevance,
      replaceability: winner.replaceability,
      verifiability: winner.verifiability,
      surprise_value: winner.surprise_value,
      verification_cost: winner.verification_cost,
      intent_specificity: winner.intent_specificity,
      total: winner.total,
    },
    conflict_check: conflictCheck,
    replaceability_check: replaceabilityCheck,
    temporary_gist_factor: temporal.temporary_gist_factor,
    review_date: temporal.review_date,
    manual_review_required: manualReviewRequired,
    field_job: phase1.field_job || null,
    competitor_pattern: phase1.competitor_pattern || null,
    candidates: rankedAll,
    fallback_used: phase2.fallback_used || null,
    standalone_exposure: standaloneExposure,
    post_validation_notes: notes,
    _meta: {
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      thoughtsTokens: usage.thoughtsTokens,
      cachedTokens: usage.cachedTokens,
      attempts: usage.calls,
      provider: usage.providers.size === 1 ? [...usage.providers][0] : 'mixed',
    },
  };
}

// ─── Мета-теги для ссылочных статей ────────────────────────────────

/**
 * Генерация пары title/description для готовой ссылочной статьи через тот же
 * GIST Meta Filter Pipeline. SERP не запрашивается (статья публикуется на
 * внешнем доноре) — конкурентный шаблон оценивается моделью по категории.
 *
 * @param {object} args
 * @param {string} args.topic        — тема статьи (главный запрос)
 * @param {string} [args.anchorText] — анкор ссылки
 * @param {string} [args.articlePlain] — plain-текст статьи (контекст фактов)
 * @param {string} [args.focusNotes] — фокус-указания задачи
 * @param {string} [args.geminiModel] — копирайтерская модель задачи
 * @returns {Promise<object>} тот же JSON-контракт, что runGistMetaPipeline
 */
async function generateLinkArticleMeta({
  topic, anchorText = '', articlePlain = '', focusNotes = '', geminiModel = '',
} = {}) {
  const excerpt = String(articlePlain || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
  return runGistMetaPipeline({
    keyword: String(topic || '').trim(),
    semantics: {},
    serpData: [],
    inputs: {
      niche: topic,
      summary: focusNotes || '',
      page_context: excerpt
        ? `Текст готовой статьи (источник фактов-кандидатов): ${excerpt}`
        : '',
      brand: '',
      // Ссылочные статьи часто распространяются standalone (шаринг, превью,
      // AI summaries) — осознанный override (§5 ТЗ).
      standalone_exposure: true,
      pageAngle: anchorText ? `Статья подводит к переходу по анкору «${anchorText}»` : '',
    },
    options: { copywriterModel: geminiModel || undefined },
  });
}

module.exports = {
  runGistMetaPipeline,
  generateLinkArticleMeta,
  checkTemplateLevelConflict,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX,
  DESC_MOBILE_MIN, DESC_MOBILE_MAX, H1_MAX,
  TITLE_FACT_WINDOW, DESC_FACT_WINDOW,
};
