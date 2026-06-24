'use strict';

const db = require('../../config/db');

/**
 * Валидация явной привязки задачи к SEO-проекту (ТЗ §5).
 *
 * Любая форма создания задачи (info-article, link-article, meta-tags,
 * article-topics, relevance, forecaster, serp-b2b) принимает опциональное
 * поле `project_id`. Перед записью в БД его нужно проверить:
 *   - тип number
 *   - проект принадлежит текущему пользователю (защита от подмены id)
 *
 * Возвращает валидный BIGINT либо null (если поле не передано / не пройдена
 * валидация). Контроллер уже сам решает, обязательно ли поле — если нет,
 * пишет null. Это сознательное решение per user: «обязательное или
 * опциональное?» оставлено на следующую итерацию, по умолчанию opt-in.
 */
async function resolveOwnedProjectId(rawId, userId) {
  if (rawId == null || rawId === '') return null;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await db.query(
    `SELECT 1 FROM projects WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows.length ? id : null;
}

module.exports = { resolveOwnedProjectId };
