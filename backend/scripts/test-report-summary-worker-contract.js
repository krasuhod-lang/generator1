'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workerSource = fs.readFileSync(path.join(root, 'src/queue/worker.js'), 'utf8');
const reportWorkerSource = fs.readFileSync(path.join(root, 'src/queue/projectReportWorker.js'), 'utf8');
const routesSource = fs.readFileSync(path.join(root, 'src/routes/reports.routes.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'src/controllers/reports.controller.js'), 'utf8');

assert.match(workerSource, /startProjectReportWorkers\s*\(\)/, 'main worker must start project/report consumers');
assert.match(workerSource, /stopProjectReportWorkers\s*\(\)/, 'main worker must stop project/report consumers');
assert.match(reportWorkerSource, /new Worker\(\s*['"]report-summary['"]/, 'report-summary consumer must exist');
assert.match(controllerSource, /queueName:\s*['"]report-summary['"]/, 'endpoint must publish report-summary outbox event');
assert.match(routesSource, /generate-summary/, 'generate-summary route must remain exposed');

console.log('report-summary worker contract: 5/5 passed');
