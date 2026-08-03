'use strict';
/**
 * Контроллер авто-заполнения прогнозатора по сайту (V2).
 *
 * POST /api/forecaster/prefill-from-domain
 *   body: { domain, region?, max_keywords? }
 *   → { ok, source:{keywords}, keywords_detailed, options, meta }
 *
 * Отдельный контроллер — существующий forecaster.controller не трогаем.
 */
const { prefillForecasterFromDomainV2 } = require('../services/forecaster/prefillFromDomain');

async function prefillFromDomainV2(req, res, next) {
  try {
    const body = req.body || {};
    const domain = String(body.domain || '').trim();
    if (!domain) return res.status(400).json({ error: 'Укажите домен (domain)' });

    const region = String(body.region || '').slice(0, 100);
    const maxKeywords = Math.max(1, Math.min(5000, Number(body.max_keywords ?? body.maxKeywords) || 300));

    const result = await prefillForecasterFromDomainV2(domain, { region, maxKeywords });

    if (!result.ok) {
      const map = {
        no_domain:  'Укажите домен',
        no_api_key: 'keys.so API-ключ не настроен',
        no_data:    'По этому домену keys.so не вернул данных — проверьте написание или регион',
      };
      const status = result.reason === 'no_api_key' ? 503 : 422;
      return res.status(status).json({ error: map[result.reason] || 'Не удалось получить данные', reason: result.reason });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { prefillFromDomainV2 };
