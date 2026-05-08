'use strict';

/**
 * eeatChunker — Phase 2 / Б1. Делит длинный article HTML на смысловые
 * чанки по H2-границам, чтобы EEAT-аудитор больше не работал на
 * `articleHtml.slice(0, 14000)` (т.е. на хвосте статьи аудит вообще не
 * проводился). Также — детерминированно выбирает топ-N LSI-терминов
 * по `weight`/частоте, не по позиции в массиве.
 *
 * Контракт: чистая функция, без сети и LLM. Вход — string HTML, выход —
 * массив { index, h2_text, html, char_count }.
 *
 * Поведение по edge-cases:
 *   • статья без <h2> → один чанк { index:0, h2_text:'', html:full };
 *   • статья короче `targetChars` → один чанк (нет смысла дробить);
 *   • очень длинные секции → разбиваются на под-чанки по targetChars,
 *     с привязкой к ближайшему </p>.
 */

// ── Параметры (env-overridable) ────────────────────────────────────

const EEAT_CHUNK_TARGET_CHARS = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_EEAT_CHUNK_TARGET_CHARS, 10);
  return Number.isFinite(v) && v >= 2000 && v <= 30000 ? v : 8000;
})();

const EEAT_CHUNKED_ENABLED = (() => {
  // Дефолт ON — для статей длиннее target'а имеет смысл считать сразу
  // чанково, иначе хвост (по сути всё после ~14kb сырого HTML) уходил
  // в /dev/null. Отключить: INFO_ARTICLE_EEAT_CHUNKED=false.
  const v = String(process.env.INFO_ARTICLE_EEAT_CHUNKED || '').toLowerCase();
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
})();

const { stripHtmlTagsToText } = require('../../utils/stripHtmlTags');

// ── Helpers ──────────────────────────────────────────────────────

const H2_OPEN_RE = /<h2\b[^>]*>/i;
const H2_OPEN_RE_G = /<h2\b[^>]*>/gi;

function stripTagsForLabel(s) {
  // Используем итеративный stripper из utils/stripHtmlTags — он устойчив
  // к нестед/малформ HTML и обходит CodeQL js/incomplete-multi-character-sanitization.
  return stripHtmlTagsToText(String(s || '')).replace(/\s+/g, ' ').trim();
}

/**
 * Делит HTML на «секции» по тегу <h2>. Возвращает массив объектов
 * { h2_text, html, start, end }. Если <h2> нет — возвращает один
 * элемент со всем HTML и пустым h2_text.
 *
 * При наличии преамбулы (текст до первого <h2>) она становится
 * отдельной первой секцией с h2_text='[Введение]'.
 */
function splitByH2(html) {
  if (typeof html !== 'string' || !html.length) return [];
  if (!H2_OPEN_RE.test(html)) {
    return [{ h2_text: '', html, start: 0, end: html.length }];
  }

  const sections = [];
  H2_OPEN_RE_G.lastIndex = 0;
  const positions = [];
  let m = H2_OPEN_RE_G.exec(html);
  while (m) {
    positions.push(m.index);
    m = H2_OPEN_RE_G.exec(html);
  }

  // Преамбула: текст до первого <h2>
  if (positions[0] > 0) {
    const pre = html.slice(0, positions[0]).trim();
    // Не возвращаем пустые/совсем мелкие преамбулы (часто — одна <p> с lead).
    // Если преамбула содержит <h1> или хотя бы один <p> — кладём отдельной
    // секцией с меткой «[Введение]».
    if (pre.length > 50 && /<(h1|p|ul|ol)\b/i.test(pre)) {
      sections.push({
        h2_text: '[Введение]',
        html:    pre,
        start:   0,
        end:     positions[0],
      });
    }
  }

  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i];
    const end   = (i + 1 < positions.length) ? positions[i + 1] : html.length;
    const section = html.slice(start, end);
    // Извлечём h2_text из первого <h2>...</h2>
    const h2m = section.match(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/i);
    sections.push({
      h2_text: h2m ? stripTagsForLabel(h2m[1]) : '',
      html:    section,
      start,
      end,
    });
  }

  return sections;
}

/**
 * Объединяет соседние секции в чанки до targetChars. Гарантирует, что
 * ни один чанк не пуст; для очень длинных секций — режет по </p>.
 */
function chunkSections(sections, targetChars = EEAT_CHUNK_TARGET_CHARS) {
  const chunks = [];
  let buf = { h2_text: [], html: '', char_count: 0 };

  const flush = () => {
    if (buf.html.length === 0) return;
    chunks.push({
      index:      chunks.length,
      h2_text:    buf.h2_text.join(' | '),
      html:       buf.html,
      char_count: buf.char_count,
    });
    buf = { h2_text: [], html: '', char_count: 0 };
  };

  for (const sec of sections) {
    const len = sec.html.length;
    // Если секция сама по себе больше target — режем её по абзацам.
    if (len > targetChars * 1.5) {
      flush();
      const sub = sliceLongHtml(sec.html, targetChars);
      sub.forEach((part, idx) => {
        chunks.push({
          index:      chunks.length,
          h2_text:    sec.h2_text + (sub.length > 1 ? ` (часть ${idx + 1}/${sub.length})` : ''),
          html:       part,
          char_count: part.length,
        });
      });
      continue;
    }
    // Если добавление выходит за target — сначала flush.
    if (buf.char_count + len > targetChars && buf.char_count > 0) {
      flush();
    }
    buf.html       += sec.html;
    buf.char_count += len;
    if (sec.h2_text) buf.h2_text.push(sec.h2_text);
  }
  flush();

  return chunks;
}

/** Делит длинный HTML по </p> или ближе к границе target. */
function sliceLongHtml(html, targetChars) {
  const out = [];
  let cursor = 0;
  while (cursor < html.length) {
    const remain = html.length - cursor;
    if (remain <= targetChars) {
      out.push(html.slice(cursor));
      break;
    }
    // Ищем ближайший </p> или </li> или </ul> в окне [target-1500, target+500]
    const lo = Math.max(cursor + targetChars - 1500, cursor + 1);
    const hi = Math.min(cursor + targetChars + 500, html.length);
    const window = html.slice(lo, hi);
    const idxs = [];
    for (const re of [/<\/p\s*>/gi, /<\/li\s*>/gi, /<\/ul\s*>/gi, /<\/ol\s*>/gi, /<\/blockquote\s*>/gi]) {
      let m = re.exec(window);
      while (m) { idxs.push(lo + m.index + m[0].length); m = re.exec(window); }
    }
    let cut;
    if (idxs.length) {
      // Выбираем ближайшую к target позицию.
      const target = cursor + targetChars;
      cut = idxs.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), idxs[0]);
    } else {
      // Никаких блочных границ — просто режем по символу.
      cut = cursor + targetChars;
    }
    out.push(html.slice(cursor, cut));
    cursor = cut;
  }
  return out;
}

/**
 * Главный публичный entrypoint. Возвращает массив чанков; каждый чанк
 * самостоятельно валиден как input для EEAT-аудита.
 */
function chunkArticleForEeat(html, opts = {}) {
  const target = (typeof opts.targetChars === 'number' && opts.targetChars > 1000)
    ? opts.targetChars : EEAT_CHUNK_TARGET_CHARS;
  if (typeof html !== 'string' || html.length === 0) return [];
  if (html.length <= target) {
    return [{
      index: 0,
      h2_text: '[Вся статья]',
      html,
      char_count: html.length,
    }];
  }
  const sections = splitByH2(html);
  return chunkSections(sections, target);
}

/**
 * aggregateChunkAudits — взвешенное среднее score'ов по chunk.char_count
 * + объединённый список issues с метаданными о chunk-источнике.
 *
 * @param {Array<{chunk: object, audit: object}>} chunkResults
 * @returns {{ total_score, verdict, issues, per_chunk, lsi_coverage_pct }}
 */
function aggregateChunkAudits(chunkResults) {
  if (!Array.isArray(chunkResults) || !chunkResults.length) {
    return {
      total_score: 0,
      verdict: 'reject',
      issues: [],
      per_chunk: [],
      lsi_coverage_pct: 0,
    };
  }

  let totalChars = 0;
  let weightedScore = 0;
  let weightedLsiCoverage = 0;
  const issues = [];
  const perChunk = [];

  for (const cr of chunkResults) {
    if (!cr || !cr.audit) continue;
    const c = cr.chunk;
    const a = cr.audit;
    const w = Math.max(1, c?.char_count || 1);
    const score = Number.isFinite(a.total_score) ? a.total_score : 0;
    weightedScore += score * w;
    totalChars    += w;

    const lsiCov = Number.isFinite(a.lsi_coverage_pct) ? a.lsi_coverage_pct : 0;
    weightedLsiCoverage += lsiCov * w;

    if (Array.isArray(a.issues)) {
      for (const issue of a.issues) {
        // Тег issue её источником (h2_text), чтобы пользователь понимал, в
        // какой секции проблема. Если issue — строка, оборачиваем в объект.
        if (typeof issue === 'string') {
          issues.push({ chunk: c?.h2_text || '', text: issue });
        } else if (issue && typeof issue === 'object') {
          issues.push({ chunk: c?.h2_text || '', ...issue });
        }
      }
    }

    perChunk.push({
      chunk_index: c?.index ?? perChunk.length,
      h2_text:     c?.h2_text || '',
      char_count:  c?.char_count || 0,
      total_score: Math.round(score * 10) / 10,
      verdict:     a.verdict || null,
      issues_count: Array.isArray(a.issues) ? a.issues.length : 0,
      lsi_coverage_pct: Math.round(lsiCov * 10) / 10,
    });
  }

  const avgScore = totalChars > 0
    ? Math.round((weightedScore / totalChars) * 10) / 10
    : 0;
  const avgLsi = totalChars > 0
    ? Math.round((weightedLsiCoverage / totalChars) * 10) / 10
    : 0;

  // Verdict: pass, если ни один чанк не reject и средний score ≥ EEAT_TARGET
  // (порог приходит снаружи через aggregateChunkAudits.threshold opts).
  return {
    total_score: avgScore,
    verdict:     null, // оставляем null — orchestrator решает по своему target'у
    issues,
    per_chunk:   perChunk,
    lsi_coverage_pct: avgLsi,
  };
}

/**
 * Приоритизирует LSI-термины по weight (если есть) или по позиции в массиве.
 * Возвращает строку для отправки в EEAT-промт без обрезки по позиции.
 *
 * @param {object|string[]} lsiSet — { important:[{term,weight}|string] } или массив
 * @param {number} maxChars — общий бюджет в символах для итоговой строки
 * @returns {string} — JSON-строка с топ-N терминов по весу.
 */
function buildLsiDigestByWeight(lsiSet, maxChars = 4000) {
  let terms = [];
  if (Array.isArray(lsiSet)) {
    terms = lsiSet;
  } else if (lsiSet && Array.isArray(lsiSet.important)) {
    terms = lsiSet.important;
  }
  // Нормализуем в [{term, weight}].
  const items = [];
  for (const t of terms) {
    if (typeof t === 'string') {
      items.push({ term: t, weight: 1 });
    } else if (t && typeof t === 'object' && typeof t.term === 'string') {
      const w = Number(t.weight);
      items.push({ term: t.term, weight: Number.isFinite(w) && w > 0 ? w : 1 });
    }
  }
  // Стабильная сортировка: по убыванию weight, затем по исходному порядку
  // (через массив-helper с индексом).
  const indexed = items.map((it, i) => ({ ...it, _idx: i }));
  indexed.sort((a, b) => (b.weight - a.weight) || (a._idx - b._idx));

  // Жадно набираем под бюджет maxChars в JSON-форме.
  const out = [];
  let json = '[]';
  for (const it of indexed) {
    out.push(it);
    json = JSON.stringify(out);
    if (json.length > maxChars) {
      out.pop();
      json = JSON.stringify(out);
      break;
    }
  }
  return json;
}

module.exports = {
  splitByH2,
  chunkSections,
  chunkArticleForEeat,
  aggregateChunkAudits,
  buildLsiDigestByWeight,
  EEAT_CHUNKED_ENABLED,
  EEAT_CHUNK_TARGET_CHARS,
  _internal: { sliceLongHtml, stripTagsForLabel },
};
