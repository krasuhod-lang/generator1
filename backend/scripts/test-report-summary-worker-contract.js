'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workerSource = fs.readFileSync(path.join(root, 'src/queue/worker.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const reportWorkerSource = fs.readFileSync(path.join(root, 'src/queue/projectReportWorker.js'), 'utf8');
const routesSource = fs.readFileSync(path.join(root, 'src/routes/reports.routes.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'src/controllers/reports.controller.js'), 'utf8');

assert.match(serverSource, /startProjectReportWorkers\s*\(\)/, 'backend server must start project/report consumers');
assert.doesNotMatch(workerSource, /startProjectReportWorkers\s*\(\)/, 'main generation worker must not start a duplicate report consumer');
assert.match(reportWorkerSource, /new Worker\(\s*['"]report-summary['"]/, 'report-summary consumer must exist');
assert.match(controllerSource, /queueName:\s*['"]report-summary['"]/, 'endpoint must publish report-summary outbox event');
assert.match(controllerSource, /const jobId = crypto\.randomUUID\(\)/, 'report job id must be PostgreSQL UUID-compatible');
assert.doesNotMatch(controllerSource, /makeBullJobId\(['"]report-summary['"]/, 'report endpoint must not store prefixed BullMQ id in UUID column');
assert.match(controllerSource, /hasActiveSummary/, 'repeat request must reuse active summary job');
assert.match(routesSource, /generate-summary/, 'generate-summary route must remain exposed');

console.log('report-summary worker contract: 8/8 passed');
