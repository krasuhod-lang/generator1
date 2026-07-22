'use strict';
/**
 * prospectScorer — скоринг лидов (0-100).
 * Чем выше score, тем приоритетнее лид для outreach.
 */

const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'mail.ru', 'yandex.ru', 'yahoo.com', 'outlook.com',
  'hotmail.com', 'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru',
  'icloud.com', 'protonmail.com', 'tutanota.com',
]);

function isCorporateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain && !FREE_EMAIL_PROVIDERS.has(domain);
}

/**
 * @param {object} prospect — строка из serpB2b results
 * @returns {{ score: number, breakdown: object }}
 */
function scoreProspect(prospect) {
  const breakdown = {};
  let score = 0;

  // 1. Динамика (главный сигнал — есть боль)
  if (prospect.dynamics?.yandex?.trend === 'decline') {
    score += 35; breakdown.yandex_decline = 35;
  } else if (prospect.dynamics?.yandex?.trend === 'stagnation') {
    score += 10; breakdown.yandex_stagnation = 10;
  }
  if (prospect.dynamics?.google?.trend === 'decline') {
    score += 20; breakdown.google_decline = 20;
  } else if (prospect.dynamics?.google?.trend === 'stagnation') {
    score += 5; breakdown.google_stagnation = 5;
  }

  // 2. Качество контакта
  const corporateEmails = (prospect.emails || []).filter(isCorporateEmail);
  if (corporateEmails.length > 0) {
    score += 20; breakdown.has_corporate_email = 20;
  } else if ((prospect.emails || []).length > 0) {
    score += 5; breakdown.has_free_email = 5;
  }

  // 3. Верифицированное юрлицо
  if (prospect.inn) { score += 10; breakdown.has_inn = 10; }
  if (prospect.company_name) { score += 5; breakdown.has_company_name = 5; }

  // 4. Знаем нишу (есть услуги)
  if ((prospect.services || []).length > 0) {
    score += 5; breakdown.has_services = 5;
  }

  // Штрафы
  if (!prospect.emails?.length) { score -= 20; breakdown.no_email = -20; }

  return { score: Math.max(0, Math.min(100, score)), breakdown };
}

module.exports = { scoreProspect, isCorporateEmail, FREE_EMAIL_PROVIDERS };
