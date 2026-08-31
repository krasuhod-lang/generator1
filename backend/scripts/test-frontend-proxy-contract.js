#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const config = fs.readFileSync(path.join(root, 'frontend/docker-nginx.conf'), 'utf8');

assert(config.includes('resolver 127.0.0.11 valid=10s ipv6=off;'), 'nginx must resolve Docker DNS dynamically');
assert(config.includes('set $backend_upstream http://seo_backend:3000;'), 'nginx must use the backend service name');
assert((config.match(/proxy_pass \$backend_upstream;/g) || []).length >= 3, 'all backend proxy locations must use the dynamic upstream');
assert(!/proxy_pass\s+http:\/\/172\.\d+\.\d+\.\d+:3000/.test(config), 'nginx must not pin the backend container IP');

console.log('frontend proxy contract: OK');
