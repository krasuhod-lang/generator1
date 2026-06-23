'use strict';

/**
 * reports/modules/offPage.js — модуль «Off-Page Monitor» (ТЗ §3.1 backlinks /
 * backlink_status). Чистая агрегация состояния ссылочного профиля:
 * индексация (Яндекс/Google), HTTP-статус, доноры.
 */

function _host(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`).hostname.replace(/^www\./i, '');
  } catch {
    return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  }
}

/**
 * @param {Array} rows бэклинки со статусом
 *   {url, anchor, donor_domain, yandex_indexed, google_indexed, http_status, added_at}
 * @param {object} opts {limit}
 */
function summarizeBacklinks(rows, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 100;
  const list = Array.isArray(rows) ? rows : [];
  const donors = new Set();

  const items = list.map((r) => {
    const donor = r.donor_domain ? String(r.donor_domain) : _host(r.url);
    if (donor) donors.add(donor.toLowerCase());
    const httpStatus = r.http_status != null ? Number(r.http_status) : null;
    const isLive = httpStatus == null ? null : httpStatus >= 200 && httpStatus < 400;
    return {
      url: r.url || null,
      anchor: r.anchor || null,
      donor_domain: donor || null,
      yandex_indexed: r.yandex_indexed == null ? null : !!r.yandex_indexed,
      google_indexed: r.google_indexed == null ? null : !!r.google_indexed,
      http_status: httpStatus,
      is_live: isLive,
      added_at: r.added_at || null,
    };
  });

  const summary = {
    total: items.length,
    unique_donors: donors.size,
    indexed_yandex: 0,
    indexed_google: 0,
    broken: 0,
    live: 0,
  };
  for (const it of items) {
    if (it.yandex_indexed) summary.indexed_yandex += 1;
    if (it.google_indexed) summary.indexed_google += 1;
    if (it.is_live === true) summary.live += 1;
    if (it.http_status != null && it.http_status >= 400) summary.broken += 1;
  }

  // Сначала проблемные (битые / не проиндексированные).
  items.sort((a, b) => {
    const score = (x) => (x.http_status >= 400 ? 0 : 1) + (x.yandex_indexed ? 1 : 0) + (x.google_indexed ? 1 : 0);
    return score(a) - score(b);
  });
  const limited = limit > 0 ? items.slice(0, limit) : items;

  return { items: limited, summary };
}

module.exports = { summarizeBacklinks, _host };
