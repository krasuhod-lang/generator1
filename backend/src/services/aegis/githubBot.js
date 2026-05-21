'use strict';

/**
 * aegis/githubBot — минимальный клиент GitHub REST API для создания
 * issues и PR'ов от имени бота. Без octokit-deps: только нативный https
 * + axios (который уже есть в зависимостях).
 *
 * Сценарии:
 *   - Бэклог: forecaster opportunity hunter создаёт issue "написать статью по LSI X"
 *   - Self-mutation: DeepSeek-mutator открывает PR с патчем парсера.
 *
 * Графейс-деградирует: если AEGIS_GITHUB_PAT не задан — методы возвращают
 * { ok:false, reason:'not_configured' }.
 */

const axios = require('axios');
const { getAegisFlags } = require('./featureFlags');

function _cfg() {
  return getAegisFlags().backlog;
}

function _auth() {
  const { repo, pat } = _cfg();
  if (!repo || !pat) return null;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;
  return { owner, repo: name, pat };
}

async function createIssue({ title, body, labels = [] }) {
  const a = _auth();
  if (!a) return { ok: false, reason: 'not_configured' };
  try {
    const r = await axios.post(
      `https://api.github.com/repos/${a.owner}/${a.repo}/issues`,
      { title, body, labels },
      {
        headers: {
          Authorization: `token ${a.pat}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'aegis-bot',
        },
        timeout: 15000,
      },
    );
    return { ok: true, number: r.data.number, url: r.data.html_url };
  } catch (err) {
    return { ok: false, reason: 'http_error', error: err.message };
  }
}

async function listIssues({ label = null, state = 'open', per_page = 30 } = {}) {
  const a = _auth();
  if (!a) return { ok: false, reason: 'not_configured', items: [] };
  try {
    const r = await axios.get(
      `https://api.github.com/repos/${a.owner}/${a.repo}/issues`,
      {
        headers: {
          Authorization: `token ${a.pat}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'aegis-bot',
        },
        params: { state, per_page, ...(label ? { labels: label } : {}) },
        timeout: 15000,
      },
    );
    return { ok: true, items: r.data };
  } catch (err) {
    return { ok: false, reason: 'http_error', error: err.message, items: [] };
  }
}

async function addLabel({ issueNumber, label }) {
  const a = _auth();
  if (!a) return { ok: false, reason: 'not_configured' };
  try {
    await axios.post(
      `https://api.github.com/repos/${a.owner}/${a.repo}/issues/${issueNumber}/labels`,
      { labels: [label] },
      {
        headers: {
          Authorization: `token ${a.pat}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'aegis-bot',
        },
        timeout: 15000,
      },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'http_error', error: err.message };
  }
}

async function commentIssue({ issueNumber, body }) {
  const a = _auth();
  if (!a) return { ok: false, reason: 'not_configured' };
  try {
    const r = await axios.post(
      `https://api.github.com/repos/${a.owner}/${a.repo}/issues/${issueNumber}/comments`,
      { body },
      {
        headers: {
          Authorization: `token ${a.pat}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'aegis-bot',
        },
        timeout: 15000,
      },
    );
    return { ok: true, url: r.data.html_url };
  } catch (err) {
    return { ok: false, reason: 'http_error', error: err.message };
  }
}

module.exports = { createIssue, listIssues, addLabel, commentIssue };
