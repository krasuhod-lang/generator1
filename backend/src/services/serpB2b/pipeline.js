'use strict';

/**
 * SERP B2B Crawler & Contact Extractor — Pipeline.
 *
 * Пайплайн на одну задачу:
 *   Step 1: SERP — забираем органические URL по `query` через xmlstock
 *           (шарим клиент с metaTags/relevance — там же поллинг капчи).
 *   Step 1b: Фильтруем blacklist (маркетплейсы / соцсети / справочники)
 *           и дедуплицируем по registrable domain.
 *   Step 2: По каждому хосту — грузим главную, ищем ссылки на /contacts/
 *           или /about/ (см. contactPageFinder). Если нашли — переходим;
 *           иначе парсим прямо главную (контакты часто в футере).
 *   Step 3: Извлекаем ИНН/ОГРН/КПП/Телефон/Email/Юрлицо из текста + tel:/mailto:.
 *   Step 4: Стримим инкрементальный прогресс в БД (results JSONB +
 *           processed_sites), чтобы фронт мог поллить в реальном времени.
 *
 * Fault tolerance: одна упавшая страница не валит весь пайплайн —
 * её результат сохраняется со status:'error' и нулевыми полями (см.
 * Acceptance Criteria #6).
 */

const db = require('../../config/db');
const { fetchYandexSerp, fetchGoogleSerp } = require('../metaTags/xmlstockClient');
const { fetchPage } = require('./siteFetcher');
const { findContactLinks } = require('./contactPageFinder');
const { extractContactsFromPage, htmlToCleanText } = require('./extractors');
const { isBlacklistedUrl, isBlacklistedHost, getRegistrableDomain } = require('./domainBlacklist');

// ── Параметры ────────────────────────────────────────────────────────
const SITE_CONCURRENCY = 4;          // параллельных сайтов
const SITE_TIMEOUT_MS  = 20000;      // timeout одного fetchPage
const MAX_CONTACT_PAGES = 2;         // сколько contact-страниц пробуем после главной
const MAX_PAGES_DEPTH = 10;          // защита от слишком глубокого SERP
const MIN_PAGES_DEPTH = 1;

// ── Утилиты ──────────────────────────────────────────────────────────

function _siteRootFromUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/`;
  } catch (_) {
    return null;
  }
}

function _initResultRow(siteRoot) {
  return {
    url: siteRoot,
    company_name: null,
    inn: null,
    ogrn: null,
    kpp: null,
    phones: [],
    emails: [],
    contact_url: null,
    status: 'pending',
    error: null,
  };
}

function _mergeContacts(target, contacts, contactUrl) {
  if (contacts.company_name && !target.company_name) target.company_name = contacts.company_name;
  if (contacts.inn && !target.inn) target.inn = contacts.inn;
  if (contacts.ogrn && !target.ogrn) target.ogrn = contacts.ogrn;
  if (contacts.kpp && !target.kpp) target.kpp = contacts.kpp;
  if (Array.isArray(contacts.phones)) {
    const set = new Set(target.phones);
    for (const p of contacts.phones) if (!set.has(p)) { set.add(p); target.phones.push(p); }
  }
  if (Array.isArray(contacts.emails)) {
    const set = new Set(target.emails);
    for (const e of contacts.emails) if (!set.has(e)) { set.add(e); target.emails.push(e); }
  }
  if (contactUrl && !target.contact_url) target.contact_url = contactUrl;
}

function _hasAnyContact(row) {
  return Boolean(row.email_count || row.phone_count) // legacy
    || (Array.isArray(row.phones) && row.phones.length)
    || (Array.isArray(row.emails) && row.emails.length)
    || row.inn || row.ogrn || row.company_name;
}

// ── SERP ─────────────────────────────────────────────────────────────

/**
 * Достаёт органические URL через xmlstock и фильтрует blacklist.
 * Возвращает уникальные «корневые» URL сайтов (по eTLD+1).
 */
async function _gatherSerpUrls({ query, searchEngine, depthPages }) {
  const fn = searchEngine === 'google' ? fetchGoogleSerp : fetchYandexSerp;
  const docs = await fn(query, { pages: depthPages, startPage: 0 });

  const seenDomains = new Set();
  const out = [];
  for (const d of docs) {
    const url = d?.url || '';
    if (!url) continue;
    if (isBlacklistedUrl(url)) continue;
    let host;
    try { host = new URL(url).hostname; } catch (_) { continue; }
    if (isBlacklistedHost(host)) continue;
    const reg = getRegistrableDomain(host);
    if (!reg || seenDomains.has(reg)) continue;
    seenDomains.add(reg);
    const root = _siteRootFromUrl(url);
    if (root) out.push(root);
  }
  return out;
}

// ── Один сайт ────────────────────────────────────────────────────────

async function _processSite(siteRoot) {
  const row = _initResultRow(siteRoot);
  let homepage = null;
  // Step 2a: главная.
  try {
    homepage = await fetchPage(siteRoot, { timeout: SITE_TIMEOUT_MS });
  } catch (err) {
    row.status = 'error';
    row.error = `homepage: ${err.message}`.slice(0, 200);
    return row;
  }

  // Сразу пытаемся вытащить контакты с главной (там тоже могут быть
  // — обычно в футере).
  try {
    const homeText = htmlToCleanText(homepage.html);
    const homeContacts = extractContactsFromPage(homepage.html, homeText);
    _mergeContacts(row, homeContacts, null);
  } catch (_) { /* мягко */ }

  // Step 2b: ищем ссылку на страницу контактов.
  let contactLinks = [];
  try {
    contactLinks = findContactLinks(homepage.html, homepage.url || siteRoot);
  } catch (_) { contactLinks = []; }

  // Step 2c/3: парсим до MAX_CONTACT_PAGES contact-страниц.
  for (const link of contactLinks.slice(0, MAX_CONTACT_PAGES)) {
    try {
      const page = await fetchPage(link, { timeout: SITE_TIMEOUT_MS });
      const contacts = extractContactsFromPage(page.html);
      _mergeContacts(row, contacts, page.url || link);
      // Если уже есть ИНН + телефон — дальше не идём.
      if (row.inn && (row.phones.length || row.emails.length)) break;
    } catch (err) {
      // Продолжаем — одна несработавшая страница не валит сайт.
      // eslint-disable-next-line no-console
      console.warn(`[serpB2b] contact-page failed (${link}): ${err.message}`);
    }
  }

  row.status = (row.phones.length || row.emails.length || row.inn || row.company_name)
    ? 'ok'
    : 'empty';
  return row;
}

// ── Управление пулом ─────────────────────────────────────────────────

async function _runWithConcurrency(items, concurrency, worker) {
  let idx = 0;
  const results = new Array(items.length);
  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    runners.push((async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const my = idx++;
        if (my >= items.length) return;
        try {
          results[my] = await worker(items[my], my);
        } catch (err) {
          // worker не должен бросать — но если внезапно бросил, не валим
          // весь пайплайн, фиксируем ошибку в строке.
          results[my] = {
            ..._initResultRow(items[my]),
            status: 'error',
            error: `worker crash: ${err.message}`.slice(0, 200),
          };
        }
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

// ── БД-помощники ─────────────────────────────────────────────────────

async function _setStatus(taskId, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i}`);
    values.push(v);
    i += 1;
  }
  fields.push(`updated_at = NOW()`);
  values.push(taskId);
  await db.query(
    `UPDATE serp_b2b_tasks SET ${fields.join(', ')} WHERE id = $${i}`,
    values,
  );
}

async function _appendResult(taskId, row, processedCount) {
  await db.query(
    `UPDATE serp_b2b_tasks
        SET results = COALESCE(results, '[]'::jsonb) || $1::jsonb,
            processed_sites = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [JSON.stringify([row]), processedCount, taskId],
  );
}

// ── Точка входа: обработка одной задачи ──────────────────────────────

async function processSerpB2bTask(taskId) {
  const { rows: taskRows } = await db.query(
    `SELECT id, query, search_engine, depth_pages, inputs
       FROM serp_b2b_tasks WHERE id = $1`,
    [taskId],
  );
  if (!taskRows.length) {
    // eslint-disable-next-line no-console
    console.warn(`[serpB2b] task ${taskId} not found`);
    return;
  }
  const task = taskRows[0];
  await _setStatus(taskId, { status: 'running', started_at: new Date(), error_message: null });

  const diagnostics = { steps: [] };
  let serpUrls = [];
  try {
    serpUrls = await _gatherSerpUrls({
      query: task.query,
      searchEngine: task.search_engine,
      depthPages: Math.min(MAX_PAGES_DEPTH, Math.max(MIN_PAGES_DEPTH, Number(task.depth_pages) || 1)),
    });
    diagnostics.steps.push({ step: 'serp', got_urls: serpUrls.length });
  } catch (err) {
    diagnostics.steps.push({ step: 'serp', error: err.message });
    await _setStatus(taskId, {
      status: 'error',
      error_message: `SERP: ${err.message}`.slice(0, 500),
      completed_at: new Date(),
      diagnostics: JSON.stringify(diagnostics),
    });
    return;
  }

  if (!serpUrls.length) {
    await _setStatus(taskId, {
      status: 'done',
      completed_at: new Date(),
      total_sites: 0,
      processed_sites: 0,
      diagnostics: JSON.stringify(diagnostics),
    });
    return;
  }

  // Обнуляем results и фиксируем общий размер.
  await db.query(
    `UPDATE serp_b2b_tasks
        SET results = '[]'::jsonb,
            total_sites = $1,
            processed_sites = 0,
            updated_at = NOW()
      WHERE id = $2`,
    [serpUrls.length, taskId],
  );

  let processed = 0;
  // Сохраняем результаты ИНКРЕМЕНТАЛЬНО — фронт поллит результат и
  // получает данные по мере появления.
  await _runWithConcurrency(serpUrls, SITE_CONCURRENCY, async (siteRoot) => {
    let row;
    try {
      row = await _processSite(siteRoot);
    } catch (err) {
      row = {
        ..._initResultRow(siteRoot),
        status: 'error',
        error: `processSite: ${err.message}`.slice(0, 200),
      };
    }
    processed += 1;
    try {
      await _appendResult(taskId, row, processed);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[serpB2b] append result failed: ${e.message}`);
    }
    return row;
  });

  diagnostics.steps.push({ step: 'sites', processed });
  await _setStatus(taskId, {
    status: 'done',
    completed_at: new Date(),
    diagnostics: JSON.stringify(diagnostics),
  });
}

// ── Recovery ─────────────────────────────────────────────────────────

/**
 * После рестарта переводим зависшие задачи (running) в error, чтобы
 * пользователь не висел в ожидании. По шаблону metaTags/categoryLead.
 */
async function recoverStuckSerpB2bTasks() {
  try {
    const { rowCount } = await db.query(
      `UPDATE serp_b2b_tasks
          SET status = 'error',
              error_message = 'Сервер был перезапущен во время выполнения задачи',
              completed_at = NOW(),
              updated_at = NOW()
        WHERE status IN ('queued', 'running')`,
    );
    if (rowCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`[serpB2b] recovered ${rowCount} stuck task(s)`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[serpB2b] recovery failed: ${err.message}`);
  }
}

module.exports = {
  processSerpB2bTask,
  recoverStuckSerpB2bTasks,
  // exposed for tests
  _gatherSerpUrls,
  _processSite,
};
