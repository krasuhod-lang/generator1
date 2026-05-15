'use strict';

/**
 * acfStructuralValidators — C3.1 + C3.2 плана «Усиление "Комбайна"».
 *
 * Дополняет существующие frontend-валидаторы AcfJsonPage
 * (findMissingPhrases / findMissingHeadings) двумя структурными:
 *
 *   1. findDuplicatedBlocks(acfArray) — детект одинаковых параграфов
 *      в разных layout-блоках (canon-equality + minLen).
 *   2. validateHeadingOrder(html, acfArray) — внутри каждой H2-секции
 *      порядок H3 должен совпадать с исходным HTML.
 *
 * Реализованы как pure CommonJS-модуль без зависимости от Vue, чтобы
 * работали и в backend (для серверной валидации), и в frontend (через
 * импорт). Интеграция в AcfJsonPage.vue UI-карточки — отдельная задача.
 *
 * acfArray — массив объектов вида { acf_fc_layout: 'blocks'|'steps'|...,
 * blocks?, items?, faq?, title?, question?, ... } — фактическая схема
 * берётся из acfDeterministicBuilder.
 */

// ── helpers ────────────────────────────────────────────────────────

function stripTags(s) {
  if (!s) return '';
  // Многократный strip + удаление одиночных «<»/«>» — закрываем
  // js/incomplete-multi-character-sanitization (например, `<<script>>`).
  let out = String(s);
  let prev;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, '');
  } while (out !== prev);
  out = out.replace(/[<>]/g, '');
  return out.replace(/\s+/g, ' ').trim();
}

function canon(text) {
  return stripTags(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * Поля, в которых лежит «контентный» HTML/text в типовых acf layouts.
 * Совпадает со списком CONTENT_TEXT_FIELDS в AcfJsonPage.vue, но как
 * массив для прямой итерации.
 */
const CONTENT_TEXT_FIELDS = ['text', 'content', 'price', 'answer', 'description'];

// ── C3.1. findDuplicatedBlocks ─────────────────────────────────────

/**
 * extractTextFragments — собирает все «контентные» текстовые фрагменты
 * из acfArray. Возвращает [{ blockIdx, layout, field, path, text, canon }].
 */
function extractTextFragments(acfArray) {
  const out = [];
  if (!Array.isArray(acfArray)) return out;

  function pushFragment(blockIdx, layout, field, pathArr, text) {
    const c = canon(text);
    if (!c) return;
    out.push({
      blockIdx,
      layout,
      field,
      path: pathArr.join('.'),
      text: stripTags(text),
      canon: c,
    });
  }

  acfArray.forEach((block, blockIdx) => {
    if (!block || typeof block !== 'object') return;
    const layout = block.acf_fc_layout || 'unknown';

    for (const f of CONTENT_TEXT_FIELDS) {
      if (typeof block[f] === 'string') {
        pushFragment(blockIdx, layout, f, [f], block[f]);
      }
    }

    // Вложенные коллекции: blocks[], items[], faq[]
    for (const coll of ['blocks', 'items', 'faq']) {
      if (Array.isArray(block[coll])) {
        block[coll].forEach((entry, j) => {
          if (!entry || typeof entry !== 'object') return;
          for (const f of CONTENT_TEXT_FIELDS) {
            if (typeof entry[f] === 'string') {
              pushFragment(blockIdx, layout, `${coll}[].${f}`, [coll, j, f], entry[f]);
            }
          }
        });
      }
    }
  });

  return out;
}

/**
 * findDuplicatedBlocks — детект одинаковых параграфов между разными layout-блоками.
 *
 * @param {Array} acfArray
 * @param {object} [opts]
 * @param {number} [opts.minLen=80]   минимальная длина canon, ниже — не считаем дубликатом
 *                                    (короткие подписи и общие фразы не интересны)
 * @param {boolean} [opts.crossBlockOnly=true]  если true, дубликаты внутри
 *                                              одного block не репортятся (это часто намеренно)
 * @returns {{ duplicates: Array<{
 *   canonHash: string,
 *   occurrences: Array<{ blockIdx, layout, field, path, snippet }>,
 *   length: number,
 * }> }}
 */
function findDuplicatedBlocks(acfArray, opts = {}) {
  const minLen = opts.minLen || 80;
  const crossBlockOnly = opts.crossBlockOnly !== false;

  const fragments = extractTextFragments(acfArray).filter((f) => f.canon.length >= minLen);
  const byCanon = new Map();
  for (const f of fragments) {
    const arr = byCanon.get(f.canon) || [];
    arr.push(f);
    byCanon.set(f.canon, arr);
  }

  const duplicates = [];
  for (const [canonStr, occList] of byCanon) {
    if (occList.length < 2) continue;
    if (crossBlockOnly) {
      const distinctBlocks = new Set(occList.map((o) => o.blockIdx));
      if (distinctBlocks.size < 2) continue;
    }
    duplicates.push({
      canonHash: canonStr.slice(0, 80),
      length: canonStr.length,
      occurrences: occList.map((o) => ({
        blockIdx: o.blockIdx,
        layout: o.layout,
        field: o.field,
        path: o.path,
        snippet: o.text.slice(0, 120),
      })),
    });
  }

  // Сортируем по убыванию длины — самые серьёзные дубликаты сверху.
  duplicates.sort((a, b) => b.length - a.length);

  return { duplicates };
}

// ── C3.2. validateHeadingOrder ─────────────────────────────────────

/**
 * extractH2H3FromHtml — возвращает упорядоченный список { tag, text, canon }
 * для всех H2/H3 в исходном HTML.
 */
function extractH2H3FromHtml(html) {
  if (!html) return [];
  const out = [];
  const re = /<(h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    out.push({ tag, text, canon: canon(text) });
  }
  return out;
}

/**
 * groupH3sByH2 — группирует H3 под предшествующим H2.
 * Возвращает Map<h2canon, [{ text, canon }, ...]>.
 */
function groupH3sByH2(headings) {
  const map = new Map();
  let currentH2 = null;
  for (const h of headings) {
    if (h.tag === 'h2') {
      currentH2 = h.canon;
      if (!map.has(currentH2)) map.set(currentH2, []);
    } else if (h.tag === 'h3' && currentH2) {
      map.get(currentH2).push({ text: h.text, canon: h.canon });
    }
  }
  return map;
}

/**
 * extractH3sFromAcfBlock — возвращает список H3-canon, найденных внутри
 * одного acf-блока. Ищем:
 *   - block.title (h3 для widget-layouts: steps/bens/faq/etc.) — пропускаем,
 *     это название секции;
 *   - <h3>...</h3> внутри полей CONTENT_TEXT_FIELDS;
 *   - block.items[].title или block.items[].question (для steps/faq) —
 *     это и есть «логические H3» в типизированных layouts.
 */
function extractH3sFromAcfBlock(block) {
  const out = [];
  if (!block || typeof block !== 'object') return out;

  // 1. h3 в текстовых полях
  for (const f of CONTENT_TEXT_FIELDS) {
    const v = block[f];
    if (typeof v === 'string') {
      const re = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
      let m;
      while ((m = re.exec(v)) !== null) {
        out.push(canon(m[1]));
      }
    }
  }

  // 2. nested
  for (const coll of ['blocks']) {
    if (Array.isArray(block[coll])) {
      for (const entry of block[coll]) {
        if (!entry || typeof entry !== 'object') continue;
        for (const f of CONTENT_TEXT_FIELDS) {
          const v = entry[f];
          if (typeof v === 'string') {
            const re = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
            let m;
            while ((m = re.exec(v)) !== null) {
              out.push(canon(m[1]));
            }
          }
        }
      }
    }
  }

  // 3. typed widget items: items[].title (steps/bens), items[].question (faq)
  if (Array.isArray(block.items)) {
    for (const it of block.items) {
      if (!it || typeof it !== 'object') continue;
      if (typeof it.title === 'string') out.push(canon(it.title));
      else if (typeof it.question === 'string') out.push(canon(it.question));
    }
  }
  if (Array.isArray(block.faq)) {
    for (const it of block.faq) {
      if (it && typeof it.question === 'string') out.push(canon(it.question));
    }
  }

  return out.filter((c) => c.length > 0);
}

/**
 * validateHeadingOrder — внутри каждой H2 порядок H3 в acfArray должен
 * совпадать с порядком H3 в исходном HTML.
 *
 * @param {string} html
 * @param {Array} acfArray
 * @returns {{
 *   ok: boolean,
 *   issues: Array<{
 *     h2: string,
 *     expectedOrder: string[],
 *     actualOrder: string[],
 *     kind: 'reorder' | 'missing' | 'extra',
 *     details: string,
 *   }>
 * }}
 */
function validateHeadingOrder(html, acfArray) {
  const headings = extractH2H3FromHtml(html);
  const expectedByH2 = groupH3sByH2(headings);

  // actualByH2: соберём H3 из acf, сгруппировав по последнему встреченному H2.
  // H2 в acf — это либо block.title для widget-layouts, либо <h2> в blocks[].text.
  const actualByH2 = new Map();
  let currentH2 = null;

  function pushActual(c) {
    if (!c) return;
    if (!currentH2) {
      // H3 без H2 — игнорируем (часто intro)
      return;
    }
    const arr = actualByH2.get(currentH2) || [];
    arr.push(c);
    actualByH2.set(currentH2, arr);
  }

  if (Array.isArray(acfArray)) {
    for (const block of acfArray) {
      if (!block || typeof block !== 'object') continue;

      // Найти все H2 в текстовых полях этого блока (включая вложенные blocks[].text)
      const h2sInBlock = [];
      function scanH2(s) {
        if (typeof s !== 'string') return;
        const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
        let m;
        while ((m = re.exec(s)) !== null) {
          h2sInBlock.push(canon(m[1]));
        }
      }
      for (const f of CONTENT_TEXT_FIELDS) scanH2(block[f]);
      if (Array.isArray(block.blocks)) {
        for (const entry of block.blocks) {
          if (!entry || typeof entry !== 'object') continue;
          for (const f of CONTENT_TEXT_FIELDS) scanH2(entry[f]);
        }
      }
      // Если widget-layout (steps/bens/faq/portfolio/...) — title тоже H2.
      const widgetLayouts = ['steps', 'bens', 'faq', 'price', 'attention', 'expert', 'portfolio', 'tags'];
      if (widgetLayouts.includes(block.acf_fc_layout) && typeof block.title === 'string') {
        h2sInBlock.push(canon(block.title));
      }

      if (h2sInBlock.length > 0) {
        // Только последний имеет смысл — H3 после него идут с него
        currentH2 = h2sInBlock[h2sInBlock.length - 1];
        if (!actualByH2.has(currentH2)) actualByH2.set(currentH2, []);
      }

      const h3s = extractH3sFromAcfBlock(block);
      for (const c of h3s) pushActual(c);
    }
  }

  const issues = [];
  for (const [h2c, expectedList] of expectedByH2) {
    const actualList = actualByH2.get(h2c) || [];
    if (expectedList.length === 0) continue;

    const expectedCanons = expectedList.map((e) => e.canon);
    const expectedSet = new Set(expectedCanons);
    const actualSet = new Set(actualList);

    const missing = expectedCanons.filter((c) => !actualSet.has(c));
    const extra = actualList.filter((c) => !expectedSet.has(c));

    if (missing.length) {
      issues.push({
        h2: h2c,
        expectedOrder: expectedCanons,
        actualOrder: actualList,
        kind: 'missing',
        details: `H3 потеряны: ${missing.slice(0, 3).join(' | ')}${missing.length > 3 ? ` (+${missing.length - 3})` : ''}`,
      });
    }
    if (extra.length) {
      issues.push({
        h2: h2c,
        expectedOrder: expectedCanons,
        actualOrder: actualList,
        kind: 'extra',
        details: `Лишние H3: ${extra.slice(0, 3).join(' | ')}${extra.length > 3 ? ` (+${extra.length - 3})` : ''}`,
      });
    }

    // Reorder: подсчёт inversions у общего множества
    const common = expectedCanons.filter((c) => actualSet.has(c));
    const actualCommon = actualList.filter((c) => expectedSet.has(c));
    if (common.length === actualCommon.length && common.length >= 2) {
      const sameOrder = common.every((c, i) => c === actualCommon[i]);
      if (!sameOrder) {
        issues.push({
          h2: h2c,
          expectedOrder: common,
          actualOrder: actualCommon,
          kind: 'reorder',
          details: 'Порядок H3 нарушен',
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

module.exports = {
  findDuplicatedBlocks,
  validateHeadingOrder,
  _internal: {
    canon,
    extractTextFragments,
    extractH2H3FromHtml,
    groupH3sByH2,
    extractH3sFromAcfBlock,
  },
};
