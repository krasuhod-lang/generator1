'use strict';

const ALLOWED_KINDS = new Set(['info-article', 'link-article', 'meta-tags', 'relevance']);

function _clip(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max).trim();
}

function _parseBody(body) {
  const out = {};
  const lines = String(body || '').split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^\s*([a-zA-Z_\-]+)\s*:\s*(.+)\s*$/);
    if (!m) continue;
    out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function parseIssueToTask(issue = {}) {
  const title = _clip(issue.title, 250);
  const fields = _parseBody(issue.body);
  const parseWarnings = [];

  let kind = String(fields.kind || '').toLowerCase().trim();
  if (!ALLOWED_KINDS.has(kind)) {
    if (kind) parseWarnings.push(`unknown_kind:${kind}`);
    kind = 'info-article';
  }

  const query = _clip(fields.query || title, 250);
  const lr = _clip(fields.lr || '213', 16) || '213';
  const niche = _clip(fields.niche, 300);
  const notes = _clip(fields.notes, 2000);

  const payload = {
    query,
    lr,
    niche,
    notes,
    anchor_text: _clip(fields.anchor_text || fields.anchor || query, 300),
    anchor_url: _clip(fields.anchor_url || fields.url, 1000),
    top_n: Math.max(5, Math.min(30, parseInt(fields.top_n, 10) || 20)),
    issueNumber: Number(issue.number) || null,
    issueUrl: String(issue.html_url || ''),
  };

  return { kind, payload, parseWarnings };
}

module.exports = { parseIssueToTask, ALLOWED_KINDS };
