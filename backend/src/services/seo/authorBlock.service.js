'use strict';

/**
 * authorBlock.service — генератор ВИДИМОГО HTML-блока «Об авторе» с привязкой
 * к сущности компании (E-E-A-T, Итерация 2, Задача 2).
 *
 * До этой задачи автор существовал только как:
 *   • byline-строка «Автор: …» (в теле статьи), и
 *   • author: Person в Article JSON-LD (seo/geoSchema.js).
 * Видимого блока «Об авторе» в теле статьи не было. Этот сервис его строит и
 * одновременно отдаёт `sameAs` (соцпрофили/сущности) для обогащения JSON-LD.
 *
 * Вход:
 *   persona — { name|display_name, role, short_bio|bio_short }
 *   company — { company_name, company_url, social_links[] }  (project-config)
 * Выход:
 *   { html, sameAs, author }  — где
 *     html   — безопасный HTML-блок <section class="author-bio">…</section>
 *     sameAs — массив URL для JSON-LD author.sameAs (соцпрофили + company_url)
 *     author — { name, jobTitle, url } для buildArticleJsonLd(author)
 *
 * Безопасность: весь текст экранируется (XSS-safe), URL валидируются
 * (только http/https, иначе отбрасываются). При отсутствии имени автора
 * возвращает { html: '', sameAs: [], author: null } — пайплайн просто не
 * добавляет блок (fail-open, обратная совместимость сохранена).
 */

const { sanitizeUrl } = require('./geoSchema');

function _str(v) {
  return String(v == null ? '' : v).trim();
}

/** HTML-escape для текстовых узлов и значений атрибутов. */
function _esc(s) {
  return _str(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Человекочитаемое имя сети из URL хоста (для подписи ссылки sameAs). */
function _linkLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const known = {
      't.me': 'Telegram',
      'telegram.me': 'Telegram',
      'vk.com': 'VK',
      'youtube.com': 'YouTube',
      'youtu.be': 'YouTube',
      'linkedin.com': 'LinkedIn',
      'facebook.com': 'Facebook',
      'instagram.com': 'Instagram',
      'x.com': 'X',
      'twitter.com': 'X',
      'dzen.ru': 'Дзен',
      'zen.yandex.ru': 'Дзен',
    };
    return known[host] || host;
  } catch (_e) {
    return 'Профиль';
  }
}

/**
 * Нормализовать вход персоны из разных форматов (Node persona-meta / M5).
 */
function _normalizePersona(persona) {
  const p = persona && typeof persona === 'object' ? persona : {};
  return {
    name: _str(p.name || p.display_name || p.full_name),
    role: _str(p.role || p.job_title || p.jobTitle),
    bio: _str(p.short_bio || p.bio_short || p.bio || p.description),
  };
}

/**
 * Нормализовать конфиг компании (project-config).
 */
function _normalizeCompany(company) {
  const c = company && typeof company === 'object' ? company : {};
  const companyName = _str(c.company_name || c.name || c.brand_name || c.brand);
  const companyUrl = sanitizeUrl(c.company_url || c.url || c.site_url || c.target_site_url);
  const socialRaw = Array.isArray(c.social_links)
    ? c.social_links
    : (Array.isArray(c.sameAs) ? c.sameAs : []);
  const social = [];
  const seen = new Set();
  for (const item of socialRaw) {
    const u = sanitizeUrl(item);
    if (u && !seen.has(u)) {
      seen.add(u);
      social.push(u);
    }
  }
  return { companyName, companyUrl, social };
}

/**
 * buildAuthorBlock — собрать видимый HTML «Об авторе» + sameAs + author.
 *
 * @param {object} params
 * @param {object} params.persona — { name|display_name, role, short_bio|bio_short }
 * @param {object} [params.company] — { company_name, company_url, social_links[] }
 * @param {string} [params.dateModified] — YYYY-MM-DD (для строки «Обновлено»)
 * @param {string} [params.heading] — заголовок блока (default: «Об авторе»)
 * @returns {{ html: string, sameAs: string[], author: object|null }}
 */
function buildAuthorBlock(params = {}) {
  const persona = _normalizePersona(params.persona);
  const company = _normalizeCompany(params.company);

  if (!persona.name) {
    return { html: '', sameAs: [], author: null };
  }

  const heading = _str(params.heading) || 'Об авторе';
  const dateModified = _str(params.dateModified);

  // sameAs: соцпрофили автора/компании + сайт компании (сущность бренда).
  const sameAs = [];
  const seen = new Set();
  const pushSame = (u) => {
    if (u && !seen.has(u)) { seen.add(u); sameAs.push(u); }
  };
  company.social.forEach(pushSame);
  pushSame(company.companyUrl);

  // ── Сборка видимого HTML ────────────────────────────────────────────
  const parts = [];
  parts.push(`<section class="author-bio" itemscope itemtype="https://schema.org/Person">`);
  parts.push(`<h2>${_esc(heading)}</h2>`);

  const nameLine = persona.role
    ? `<strong itemprop="name">${_esc(persona.name)}</strong> — <span itemprop="jobTitle">${_esc(persona.role)}</span>`
    : `<strong itemprop="name">${_esc(persona.name)}</strong>`;
  parts.push(`<p class="author-bio__name">${nameLine}</p>`);

  if (persona.bio) {
    parts.push(`<p class="author-bio__text" itemprop="description">${_esc(persona.bio)}</p>`);
  }

  // Привязка к сущности компании (E-E-A-T): автор пишет для <Компания>.
  if (company.companyName) {
    const orgInner = company.companyUrl
      ? `<a href="${_esc(company.companyUrl)}" itemprop="url" rel="author"><span itemprop="name">${_esc(company.companyName)}</span></a>`
      : `<span itemprop="name">${_esc(company.companyName)}</span>`;
    parts.push(
      `<p class="author-bio__company" itemprop="worksFor" itemscope itemtype="https://schema.org/Organization">`
      + `Материал подготовлен для ${orgInner}.`
      + `</p>`,
    );
  }

  // sameAs-ссылки (соцпрофили) как видимые ссылки + microdata.
  if (company.social.length) {
    const links = company.social
      .map((u) => `<a href="${_esc(u)}" itemprop="sameAs" rel="nofollow noopener" target="_blank">${_esc(_linkLabel(u))}</a>`)
      .join(' · ');
    parts.push(`<p class="author-bio__social">${links}</p>`);
  }

  if (dateModified) {
    parts.push(`<p class="author-bio__updated">Обновлено: ${_esc(dateModified)}</p>`);
  }

  parts.push(`</section>`);

  const author = {
    name: persona.name,
    jobTitle: persona.role || '',
    url: company.companyUrl || '',
  };

  return { html: parts.join('\n'), sameAs, author };
}

module.exports = {
  buildAuthorBlock,
  _internal: { _normalizePersona, _normalizeCompany, _esc, _linkLabel },
};
