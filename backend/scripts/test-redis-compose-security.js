'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
const redisStart = compose.indexOf('\n  redis:\n');
assert(redisStart >= 0, 'redis service must exist');
const afterRedis = compose.slice(redisStart + '\n  redis:\n'.length);
const nextServiceOffset = afterRedis.search(/\n  [A-Za-z0-9_-]+:\n/);
const nextService = nextServiceOffset >= 0
  ? redisStart + '\n  redis:\n'.length + nextServiceOffset
  : compose.length;
const redisBlock = compose.slice(redisStart, nextService);

assert(!/^\s+ports:\s*$/m.test(redisBlock), 'Redis must not publish a host port');
assert(!redisBlock.includes('6379:6379'), 'Redis host port publishing must stay disabled');
assert(redisBlock.includes('- redis_data:/data'), 'Redis persistent volume must remain mounted');
assert(redisBlock.includes('redis-server'), 'Redis service command must remain present');
const internalRedisUrls = (compose.match(/REDIS_URL:\s*redis:\/\/redis:6379/g) || []).length;
assert(internalRedisUrls >= 2, 'backend and worker must keep internal Redis URLs');

console.log(`REDIS_COMPOSE_SECURITY_OK internal_urls=${internalRedisUrls} host_port=disabled volume=preserved`);
