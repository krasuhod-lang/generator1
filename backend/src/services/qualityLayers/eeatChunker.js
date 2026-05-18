'use strict';

/**
 * eeatChunker — B1.1 плана «Усиление "Комбайна"».
 *
 * Цель: убрать обрезку статьи в runEeatAudit (`articleHtml.slice(0, 14000)`).
 * На длинных статьях (до ~30k символов) хвост никогда не аудился.
 *
 * Здесь — pure-функции:
 *   • splitByH2(html) — режет статью на смысловые куски по H2;
 *     возвращает [{ index, h2, html, plainChars }].
 *   • chunkBySize(html, targetChars) — если H2 нет или один кусок слишком
 *     велик, нарезаем дополнительно по абзацам, не превышая targetChars
 *     (с лёгким перехлёстом по целым абзацам).
 *   • aggregateEeatVerdicts(chunkVerdicts) — взвешенное среднее
 *     по длине chunk-а: pq_score, evidence_quality, freshness_signals,
 *     style_consistency. Поля unknown пропускаются. Возвращает
 *     { aggregated, perChunk, totalChars }.
 *
 * Вызов LLM — задача pipeline; здесь только структурирование и аггрегация.
 */

// ── Splitter ────────────────────────────────────────────────────────

const H2_OPEN_RE = /<h2\b[^>]*>/gi;

/**
 * splitByH2 — режет HTML по тегу <h2>. Текст ДО первого H2 (intro/h1)
 * становится chunk index=0 без h2-метки.
 */
function splitByH2(html) {
  if (!html) return [];
  const positions = [];
  let m;
  H2_OPEN_RE.lastIndex = 0;
  while ((m = H2_OPEN_RE.exec(html)) !== null) {
    positions.push(m.index);
  }
  if (positions.length === 0) {
    return [{ index: 0, h2: '', html, plainChars: countPlainChars(html) }];
  }
  const chunks = [];
  // Pre-H2
  if (positions[0] > 0) {
    const fragment = html.slice(0, positions[0]);
    if (countPlainChars(fragment) > 0) {
      chunks.push({ index: 0, h2: '', html: fragment, plainChars: countPlainChars(fragment) });
    }
  }
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : html.length;
    const fragment = html.slice(start, end);
    const h2Match = fragment.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    const h2Text = h2Match ? stripTags(h2Match[1]).trim() : '';
    chunks.push({
      index: chunks.length,
      h2: h2Text,
      html: fragment,
      plainChars: countPlainChars(fragment),
    });
  }
  return chunks;
}

/**
 * chunkBySize — если кусок слишком большой (> targetChars), режет его
 * дополнительно по границам абзацев <p>. Никогда не разрезает абзац
 * посередине. Если один абзац больше targetChars — он остаётся как есть
 * (LLM сама справится; обрезка хуже).
 */
function chunkBySize(html, targetChars = 8000) {
  if (!html) return [];
  if (countPlainChars(html) <= targetChars) {
    return [{ html, plainChars: countPlainChars(html) }];
  }
  // Режем по </p>, </li>, </h3>, </h4>, </blockquote>, </figure>, </tr>, </table>.
  // Таблицы: </tr> и </table> — безопасные границы (целые строки/таблицы);
  // </td> не используем намеренно, чтобы не разрывать ячейки.
  const tokens = html.split(/(?<=<\/(?:p|li|h[3-6]|blockquote|figure|tr|table)>)/i);
  const out = [];
  let buf = '';
  let bufChars = 0;
  for (const tok of tokens) {
    const tokChars = countPlainChars(tok);
    if (bufChars + tokChars > targetChars && buf.length > 0) {
      out.push({ html: buf, plainChars: bufChars });
      buf = tok;
      bufChars = tokChars;
    } else {
      buf += tok;
      bufChars += tokChars;
    }
  }
  if (buf) out.push({ html: buf, plainChars: bufChars });
  return out;
}

/**
 * splitForEeat — публичный комбинированный API:
 * сначала по H2, затем большие куски дополнительно режутся chunkBySize.
 */
function splitForEeat(html, { targetChars = 8000 } = {}) {
  const h2Chunks = splitByH2(html);
  const out = [];
  for (const ch of h2Chunks) {
    if (ch.plainChars <= targetChars) {
      out.push(ch);
      continue;
    }
    const sub = chunkBySize(ch.html, targetChars);
    sub.forEach((s, i) => {
      out.push({
        index: out.length,
        h2: ch.h2 ? `${ch.h2} (часть ${i + 1}/${sub.length})` : '',
        html: s.html,
        plainChars: s.plainChars,
      });
    });
  }
  // переиндексировать
  out.forEach((c, i) => { c.index = i; });
  return out;
}

// ── Aggregator ──────────────────────────────────────────────────────

/**
 * aggregateEeatVerdicts — взвешенное среднее по plainChars.
 *
 * @param {Array<{
 *   chunk: { index, h2, plainChars },
 *   verdict: {
 *     pq_score?: number,             // 0..10
 *     evidence_quality?: number,     // 0..10
 *     freshness_signals?: number,    // 0..10
 *     style_consistency?: number,    // 0..10
 *     issues?: Array<any>,
 *   }
 * }>} entries
 *
 * @returns {{
 *   aggregated: { pq_score, evidence_quality, freshness_signals, style_consistency, issues },
 *   perChunk: Array<{ index, h2, plainChars, verdict }>,
 *   totalChars: number,
 * }}
 */
function aggregateEeatVerdicts(entries) {
  const fields = ['pq_score', 'evidence_quality', 'freshness_signals', 'style_consistency'];
  const sums = Object.fromEntries(fields.map((f) => [f, 0]));
  const weights = Object.fromEntries(fields.map((f) => [f, 0]));
  const allIssues = [];
  let totalChars = 0;

  for (const e of entries) {
    const chars = Math.max(0, e.chunk.plainChars || 0);
    totalChars += chars;
    // Чанки без текста не должны тянуть среднее: им присваивается вес 0.
    // (Старое поведение Math.max(1, chars) делало пустой chunk «полноценным
    // голосом» наравне с тысячесимвольным куском.)
    if (chars === 0) {
      // Только issues аккумулируем, без вклада в среднее.
      if (e.verdict && Array.isArray(e.verdict.issues)) {
        for (const iss of e.verdict.issues) {
          allIssues.push({ chunkIndex: e.chunk.index, h2: e.chunk.h2, issue: iss });
        }
      }
      continue;
    }
    const w = chars;
    for (const f of fields) {
      const v = e.verdict ? e.verdict[f] : null;
      if (typeof v === 'number' && Number.isFinite(v)) {
        sums[f] += v * w;
        weights[f] += w;
      }
    }
    if (e.verdict && Array.isArray(e.verdict.issues)) {
      for (const iss of e.verdict.issues) {
        allIssues.push({
          chunkIndex: e.chunk.index,
          h2: e.chunk.h2,
          issue: iss,
        });
      }
    }
  }

  const aggregated = {};
  for (const f of fields) {
    aggregated[f] = weights[f] > 0
      ? Math.round((sums[f] / weights[f]) * 100) / 100
      : null;
  }
  aggregated.issues = allIssues;

  return {
    aggregated,
    perChunk: entries.map((e) => ({
      index: e.chunk.index,
      h2: e.chunk.h2,
      plainChars: e.chunk.plainChars,
      verdict: e.verdict,
    })),
    totalChars,
  };
}

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

function countPlainChars(html) {
  return stripTags(html).length;
}

module.exports = {
  splitByH2,
  chunkBySize,
  splitForEeat,
  aggregateEeatVerdicts,
  _internal: { stripTags, countPlainChars },
};
