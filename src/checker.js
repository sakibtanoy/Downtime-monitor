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

// Detects WordPress, PHP, and database critical crashes
function detectCriticalError(body) {
  if (!body || typeof body !== 'string') return null;

  // 1. WordPress standard critical error
  if (
    /<p[^>]*>There has been a critical error on (this|your) website\.?<\/p>/i.test(body) ||
    (/There has been a critical error on (this|your) website/i.test(body) && (body.length < 5000 || /wp-die-message|id="error-page"/i.test(body)))
  ) {
    return 'WordPress critical error: "There has been a critical error on this website"';
  }

  // 2. WordPress Database connection error
  if (/Error establishing a database connection/i.test(body) && (body.length < 5000 || /<title>Database Error<\/title>/i.test(body))) {
    return 'Database connection error: "Error establishing a database connection"';
  }

  // 3. WordPress stuck in maintenance mode
  if (/Briefly unavailable for scheduled maintenance\. Check back in a minute/i.test(body)) {
    return 'WordPress maintenance mode: "Briefly unavailable for scheduled maintenance"';
  }

  // 4. PHP Fatal Error (with or without HTML formatting)
  const fatalMatch = body.match(/(?:<b>)?Fatal error(?:<\/b>)?\s*:\s*([^\r\n<]+)/i);
  if (fatalMatch) {
    const detail = fatalMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 90);
    return `PHP Fatal error: ${detail}`;
  }

  // 5. PHP Parse / Syntax Error
  const parseMatch = body.match(/(?:<b>)?Parse error(?:<\/b>)?\s*:\s*([^\r\n<]+)/i);
  if (parseMatch) {
    const detail = parseMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 90);
    return `PHP Parse error: ${detail}`;
  }

  // 6. PHP Memory Exhaustion
  if (/Allowed memory size of \d+ bytes exhausted/i.test(body)) {
    return 'PHP Fatal error: Allowed memory size exhausted';
  }

  // 7. WordPress wp-die error page
  if (/<body[^>]*id="error-page"/i.test(body) || /class="wp-die-message"/i.test(body)) {
    const m = body.match(/class="wp-die-message"[^>]*>([\s\S]*?)<\/div>/i);
    if (m) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
      if (text) return `WordPress error: "${text}"`;
    }
  }

  return null;
}

// Detects empty responses / White Screen of Death (WSOD)
function detectBlankPage(body, status) {
  // 204 No Content and 304 Not Modified are allowed to be empty by HTTP standard
  if (status === 204 || status === 304) return null;

  if (!body || body.length === 0) {
    return 'Blank page: server returned 0 bytes (White Screen of Death)';
  }

  if (body.trim().length === 0) {
    return 'Blank page: server returned whitespace only (White Screen of Death)';
  }

  // Detect empty HTML skeleton with no visible content, text, or assets
  if (body.length < 1200) {
    // If the body tag exists and is empty
    const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const contentToCheck = bodyMatch ? bodyMatch[1] : body;
    const hasAssets = /<(script|img|svg|iframe|link|video|audio|canvas|object|embed|form|input)\b/i.test(contentToCheck);
    if (!hasAssets) {
      const visibleText = contentToCheck
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&(?:nbsp|#160);/gi, ' ')
        .trim();
      if (visibleText.length === 0) {
        return 'Blank page: body has no content (White Screen of Death)';
      }
    }
  }

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
        const wantBody = !!site.keyword || site.checkBlank !== false || site.checkErrors !== false;
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          if (!wantBody) return res.destroy();
          size += c.length;
          if (size <= MAX_BODY) {
            chunks.push(c);
          } else {
            res.destroy(); // Got enough body preview (512KB)
          }
        });
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          resolve({
            status: res.statusCode,
            ms: Date.now() - started,
            body: Buffer.concat(chunks).toString('utf8'),
            sslDaysLeft
          });
        };
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

    if (!okStatus) {
      error = `HTTP ${r.status}${r.status >= 500 ? ' (server error)' : ''}`;
      if (site.checkErrors !== false && r.body) {
        const crit = detectCriticalError(r.body);
        if (crit) error = `HTTP ${r.status}: ${crit}`;
      }
    } else {
      if (site.keyword && !r.body.includes(site.keyword)) {
        ok = false;
        error = `Keyword "${site.keyword}" not found on page`;
      } else if (site.checkErrors !== false && !site.expectedStatus) {
        const crit = detectCriticalError(r.body);
        if (crit) {
          ok = false;
          error = crit;
        }
      }

      if (ok && site.checkBlank !== false && !site.expectedStatus) {
        const blank = detectBlankPage(r.body, r.status);
        if (blank) {
          ok = false;
          error = blank;
        }
      }
    }

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

module.exports = { runCheck, friendlyError, detectCriticalError, detectBlankPage };
