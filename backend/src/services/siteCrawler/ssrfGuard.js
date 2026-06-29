'use strict';

/**
 * siteCrawler/ssrfGuard.js — отсекает приватные/локальные адреса до того,
 * как сделать GET. Используется в crawler.js и robotsClient (при желании).
 *
 * Алгоритм:
 *   1. Резолвим hostname в IP (lookup + all).
 *   2. Любой IP в приватных диапазонах → throw.
 *
 * Это not bullet-proof (DNS rebinding не предотвращается без pin-IP request),
 * но закрывает 99% «случайных» SSRF.
 */

const dns = require('dns').promises;
const net = require('net');

const V4_PRIVATE = [
  // [start, mask-bits]
  ['10.0.0.0',     8],
  ['127.0.0.0',    8],
  ['169.254.0.0', 16],
  ['172.16.0.0',  12],
  ['192.168.0.0', 16],
  ['100.64.0.0',  10],  // CGNAT
  ['0.0.0.0',      8],
];

function _ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, x) => (acc << 8) + parseInt(x, 10), 0) >>> 0;
}

function isPrivateIpv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const ipi = _ipv4ToInt(ip);
  for (const [base, bits] of V4_PRIVATE) {
    const baseI = _ipv4ToInt(base);
    const mask  = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((ipi & mask) === (baseI & mask)) return true;
  }
  return false;
}

function isPrivateIpv6(ip) {
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
  if (lower.startsWith('fe80'))                        return true;  // link-local
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped → проверим как v4
    const m = lower.match(/^::ffff:([\d.]+)$/);
    if (m) return isPrivateIpv4(m[1]);
  }
  return false;
}

function isPrivateAddress(ip) {
  return isPrivateIpv4(ip) || isPrivateIpv6(ip);
}

async function assertPublicHost(host) {
  if (!host) throw new Error('SSRF guard: empty host');
  // Если host уже IP — проверяем сразу.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      const err = new Error(`SSRF blocked: private address ${host}`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
    return [host];
  }
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (e) {
    const err = new Error(`SSRF guard: DNS lookup failed for ${host}: ${e.message}`);
    err.code = 'SSRF_DNS';
    throw err;
  }
  if (!addrs.length) {
    const err = new Error(`SSRF guard: no addresses for ${host}`);
    err.code = 'SSRF_DNS';
    throw err;
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      const err = new Error(`SSRF blocked: ${host} resolves to private ${a.address}`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
  }
  return addrs.map((a) => a.address);
}

module.exports = {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateAddress,
  assertPublicHost,
};
