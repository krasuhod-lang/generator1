'use strict';

/**
 * Source-level regression for task persistence/date reliability.
 * No network, database, Redis, or production credentials are used.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const tasksController = read('backend/src/controllers/tasks.controller.js');
const admission = read('backend/src/services/tasks/generationAdmission.js');
const articleClaim = read('backend/src/services/tasks/articleExecutionClaim.js');
const durableSchema = read('backend/src/services/tasks/durableSchema.js');
const stage7 = read('backend/src/services/pipeline/stage7.js');
const admin = read('backend/src/controllers/admin.controller.js');
const infoController = read('backend/src/controllers/infoArticle.controller.js');
const linkController = read('backend/src/controllers/linkArticle.controller.js');
const dashboard = read('frontend/src/views/DashboardPage.vue');
const taskHistory = read('frontend/src/utils/taskHistory.js');
const tasksStore = read('frontend/src/stores/tasks.js');
const migration149 = read('migrations/149_task_last_started_at.sql');
const migration150 = read('migrations/150_content_task_soft_archive.sql');

assert.match(migration149, /ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ/);
assert.match(migration149, /ADD COLUMN IF NOT EXISTS content_stale BOOLEAN NOT NULL DEFAULT FALSE/);
assert.match(migration149, /ALTER TABLE info_article_tasks[\s\S]*ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ/);
assert.match(migration149, /ALTER TABLE link_article_tasks[\s\S]*ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ/);
assert.match(migration149, /created_at remains immutable/i);
assert.match(migration150, /ALTER TABLE info_article_tasks[\s\S]*ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
assert.match(migration150, /ALTER TABLE link_article_tasks[\s\S]*ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);

assert.match(durableSchema, /ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ/);
assert.match(durableSchema, /ALTER TABLE tasks ADD COLUMN IF NOT EXISTS content_stale BOOLEAN NOT NULL DEFAULT FALSE/);
assert.match(durableSchema, /ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
assert.match(durableSchema, /ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
assert.match(durableSchema, /ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ/);
assert.match(durableSchema, /ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ/);

assert.match(admission, /last_started_at=NOW\(\)/);
assert.match(articleClaim, /last_started_at = NOW\(\)/);
assert.match(infoController, /last_started_at/);
assert.match(linkController, /last_started_at/);
assert.match(tasksController, /last_started_at=NOW\(\)/);
assert.match(tasksController, /t\.content_stale/);
assert.match(tasksController, /task_start_race/);
assert.match(tasksController, /task_resume_race/);
assert.match(tasksController, /completed_task_reopen_required/);
assert.match(tasksController, /req\.body\?\.reopen === true/);
assert.match(tasksController, /WHERE id=\$2 AND archived_at IS NULL[\s\S]*status IN \('paused','failed'\)/);
assert(!/DELETE FROM tasks/i.test(tasksController), 'SEO task controller must not physically delete tasks');

assert.match(stage7, /content_stale\s*=\s*FALSE/);
assert.match(stage7, /persistence refused empty final HTML/);
assert.match(stage7, /contentUpdate\.rowCount/);

assert.match(admin, /activityAtSql:/);
assert.match(admin, /activity_at DESC NULLS LAST/);
assert.match(admin, /archived_at/);
assert.match(infoController, /UPDATE info_article_tasks[\s\S]*archived_at/);
assert.match(linkController, /UPDATE link_article_tasks[\s\S]*archived_at/);
assert(!/DELETE FROM info_article_tasks/i.test(infoController), 'blog task delete must be soft archive');
assert(!/DELETE FROM link_article_tasks/i.test(linkController), 'link task delete must be soft archive');

assert.match(dashboard, /last_started_at/);
assert.match(dashboard, /content_stale/);
assert(!/timeZone:\s*'UTC'/.test(dashboard), 'Dashboard must not group local tasks by forced UTC');
assert.match(dashboard, /getFullYear\(\)/);
assert.match(taskHistory, /activity_at/);
assert.match(taskHistory, /last_started_at/);
assert.match(tasksStore, /activity_at \|\| b\.last_started_at/);
assert.match(tasksStore, /last_started_at: activityAt/);
assert.match(tasksStore, /status: 'queued'/);
assert.match(infoController, /archived_at/);
assert.match(linkController, /archived_at/);
assert.match(read('frontend/src/stores/infoArticle.js'), /archived_at/);
assert.match(read('frontend/src/stores/linkArticle.js'), /archived_at/);

console.log('task persistence/date reliability contract: OK');
