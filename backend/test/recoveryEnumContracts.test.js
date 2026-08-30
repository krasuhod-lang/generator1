const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const queuedRecovery = fs.readFileSync(
  path.join(root, 'src/services/tasks/queuedTaskRecovery.js'),
  'utf8',
);
const reliability = fs.readFileSync(
  path.join(root, 'src/services/tasks/reliability.js'),
  'utf8',
);

const metaTagsSpec = queuedRecovery.match(
  /kind: 'meta_tags',[\s\S]*?handler: \(\) => require\('\.\.\/metaTags\/pipeline'\)/,
)?.[0] || '';
assert.match(metaTagsSpec, /statuses: \['pending'\]/);
assert.match(metaTagsSpec, /queueStatus: 'pending'/);
assert.doesNotMatch(metaTagsSpec, /statuses: \[[^\]]*'queued'/);
assert.match(
  reliability,
  /SET status=\(CASE WHEN COALESCE\(recovery_attempts,0\) >= \$1 THEN 'error' ELSE 'queued' END\)::project_analysis_status/,
);

console.log('recoveryEnumContracts.test.js: all assertions passed');
