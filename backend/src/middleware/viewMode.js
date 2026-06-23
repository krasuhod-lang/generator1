'use strict';

/**
 * middleware/viewMode.js — определяет режим просмотра (analyst|client)
 * для авторизованного запроса и кладёт его в req.viewMode.
 *
 * Источник: заголовок `X-Client-Mode` (1/true/client → 'client'; 0/false/analyst
 * → 'analyst') или query `?mode=client`. Если ничего не задано — 'analyst'.
 *
 * На публичных роутах (см. routes/projectsPublic.routes.js) этот middleware
 * НЕ используется: там режим однозначно определяется share_mode из БД,
 * см. controllers/projects.controller.js#getSharedProject.
 */

const { resolveViewMode, VIEW_MODES } = require('../services/projects/viewMode');

function viewModeMiddleware(req, _res, next) {
  req.viewMode = resolveViewMode(req, { isPublic: false });
  next();
}

module.exports = { viewModeMiddleware, VIEW_MODES };
