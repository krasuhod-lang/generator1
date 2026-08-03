'use strict';
/**
 * Контроллер провокационного режима outreach (V2).
 *
 * POST /api/outreach/prospects/:id/preview-provocation
 *   — собирает провокационное письмо для одного лида и ВОЗВРАЩАЕТ его
 *     (subject/html/text/meta) БЕЗ отправки. Для обкатки в UI.
 *
 * Отдельный контроллер — существующий outreach.controller не трогаем.
 */
const db = require('../config/db');
const { buildProvocationEmailV2 } = require('../services/outreach/provocation');

async function previewProvocationV2(req, res, next) {
  try {
    const { id } = req.params;

    // Лид с проверкой владельца.
    const { rows } = await db.query(
      'SELECT * FROM outreach_prospects WHERE id = $1 AND user_id = $2',
      [id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Лид не найден' });
    const prospect = rows[0];

    let campaign = null;
    if (prospect.campaign_id) {
      const c = await db.query('SELECT * FROM outreach_campaigns WHERE id = $1', [prospect.campaign_id]);
      campaign = c.rows[0] || null;
    }

    const appUrl = process.env.APP_URL || '';
    const sender = {
      senderName:    campaign?.sender_name || process.env.OUTREACH_FROM_NAME || 'SEO Team',
      senderCompany: campaign?.sender_name || process.env.OUTREACH_FROM_NAME || 'SEO Team',
      senderSite:    campaign?.sender_site || '',
      senderTelegram: campaign?.sender_telegram || '',
    };

    const letter = await buildProvocationEmailV2({
      prospect,
      campaign,
      sender,
      unsubscribeUrl: appUrl ? `${appUrl.replace(/\/+$/, '')}/unsubscribe` : '#',
    });

    return res.json({ prospect_id: id, ...letter });
  } catch (err) {
    return next(err);
  }
}

module.exports = { previewProvocationV2 };
