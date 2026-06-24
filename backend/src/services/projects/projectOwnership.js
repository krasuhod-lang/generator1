'use strict';

const db = require('../../config/db');

// projects.id — UUID (см. CREATE TABLE projects в backend/server.js).
// Принимаем canonical UUID v1-v5 (hex с дефисами). Строгая валидация на
// фронте + здесь защищает от инъекции «id» вида "1; DROP …" и от случая,
// когда фронт прислал сырое число (старый код-привычка) — такой id
// просто отбрасывается, и задача создаётся без привязки к проекту.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Валидация явной привязки задачи к SEO-проекту (ТЗ §5).
 *
 * Любая форма создания задачи (info-article, link-article, meta-tags,
 * article-topics, relevance, forecaster, serp-b2b) принимает опциональное
 * поле `project_id`. Перед записью в БД его нужно проверить:
 *   - тип: строка-UUID (projects.id — UUID, см. server.js)
 *   - проект принадлежит текущему пользователю (защита от подмены id)
 *
 * Возвращает валидный UUID-string либо null (если поле не передано / не
 * пройдена валидация). Контроллер уже сам решает, обязательно ли поле —
 * если нет, пишет null. Это сознательное решение per user: «обязательное
 * или опциональное?» оставлено на следующую итерацию, по умолчанию opt-in.
 */
async function resolveOwnedProjectId(rawId, userId) {
  if (rawId == null || rawId === '') return null;
  const id = String(rawId).trim();
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query(
    `SELECT 1 FROM projects WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows.length ? id : null;
}

module.exports = { resolveOwnedProjectId };
