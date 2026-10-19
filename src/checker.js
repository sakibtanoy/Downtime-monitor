'use strict';
const http = require('http');
const https = require('https');
const net = require('net');

const MAX_REDIRECTS = 5;
const MAX_BODY = 512 * 1024;

function friendlyError(e) {
  const c = e && e.code;
  const map = {
    ENOTFOUND: 'DNS lookup failed (domain not found)',
    EAI_AGAIN: 'DNS lookup failed (temporary)',
    ECONNREFUSED: 'Connection refused (server/port not listening)',
    ECONNRESET: 'Connection reset by server',
    ETIMEDOUT: 'Connection timed out',
    EHOSTUNREACH: 'Host unreachable',
    ENETUNREACH: 'Network unreachable',
    CERT_HAS_EXPIRED: 'SSL certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'SSL certificate is self-signed',
    SELF_SIGNED_CERT_IN_CHAIN: 'SSL certificate chain is self-signed',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL certificate chain is incomplete',
    ERR_TLS_CERT_ALTNAME_INVALID: 'SSL certificate does not match the domain',
  };
  return map[c] || (e && e.message) || String(e);
}

// "200", "200-299", "200,301" -> predicate; default is any 2xx/3xx
function statusMatcher(spec) {
  if (!spec) return (s) => s >= 200 && s < 400;
  const parts = String(spec).split(',').map((p) => p.trim()).filter(Boolean);
  const ranges = parts.map((p) => {
    const [a, b] = p.split('-').map(Number);
    return [a, b || a];
  });
  return (s) => ranges.some(([a, b]) => s >= a && s <= b);
}

function certDaysLeft(socket) {
  try {
    const cert = socket.getPeerCertificate && socket.getPeerCertificate();
    if (cert && cert.valid_to) return Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400_000);
  } catch (_) { /* ignore */ }
  return null;
}

function requestOnce(urlStr, site, timeoutMs, redirects) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error('Invalid URL')); }
    const lib = url.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = lib.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'UptimeMonitor/1.0 (+self-hosted)', Accept: '*/*' },
        rejectUnauthorized: !site.ignoreTls,
        agent: false,
      },
      (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects < MAX_REDIRECTS && !site.expectedStatus) {
          res.resume();
          let next;
          try { next = new URL(loc, url).toString(); } catch (_) { return reject(new Error('Bad redirect location')); }
          const sslLeft = certDaysLeft(res.socket);
          return requestOnce(next, site, Math.max(1000, timeoutMs - (Date.now() - started)), redirects + 1)
            .then((r) => resolve({ ...r, ms: r.ms + (Date.now() - started), sslDaysLeft: r.sslDaysLeft ?? sslLeft }), reject);
        }
        const sslDaysLeft = certDaysLeft(res.socket);
        const wantBody = !!site.keyword;
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          if (!wantBody) return res.destroy();
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
        });
        const done = () => resolve({ status: res.statusCode, ms: Date.now() - started, body: wantBody ? Buffer.concat(chunks).toString('utf8') : '', sslDaysLeft });
        res.on('end', done);
        res.on('close', done);
        res.on('error', () => done());
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error(`Timed out after ${timeoutMs / 1000}s`), { code: 'ETIMEDOUT_APP' })));
    req.on('error', reject);
    req.end();
  });
}

async function checkHttp(site, defaults) {
  const timeoutMs = site.timeoutMs || defaults.requestTimeoutMs;
  const t0 = Date.now();
  try {
    const r = await requestOnce(site.url, site, timeoutMs, 0);
    const okStatus = statusMatcher(site.expectedStatus)(r.status);
    let ok = okStatus;
    let error = null;
    if (!okStatus) error = `HTTP ${r.status}${r.status >= 500 ? ' (server error)' : ''}`;
    else if (site.keyword && !r.body.includes(site.keyword)) { ok = false; error = `Keyword "${site.keyword}" not found on page`; }
    return { ok, ms: r.ms, statusCode: r.status, error, sslDaysLeft: r.sslDaysLeft };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, statusCode: null, error: e.code === 'ETIMEDOUT_APP' ? e.message : friendlyError(e), sslDaysLeft: null };
  }
}

function checkTcp(site, defaults) {
  const timeoutMs = site.timeoutMs || defaults.requestTimeoutMs;
  const m = String(site.url).replace(/^tcp:\/\//, '').match(/^(.+):(\d{1,5})$/);
  if (!m) return Promise.resolve({ ok: false, ms: 0, error: 'Invalid TCP target (use host:port)' });
  const [, host, port] = m;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port: Number(port) });
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; sock.destroy(); resolve({ statusCode: null, sslDaysLeft: null, ...r, ms: Date.now() - t0 }); };
    sock.setTimeout(timeoutMs, () => finish({ ok: false, error: `Timed out after ${timeoutMs / 1000}s` }));
    sock.on('connect', () => finish({ ok: true, error: null }));
    sock.on('error', (e) => finish({ ok: false, error: friendlyError(e) }));
  });
}

function runCheck(site, defaults) {
  return site.type === 'tcp' ? checkTcp(site, defaults) : checkHttp(site, defaults);
}

module.exports = { runCheck, friendlyError };
