'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const store = require('./store');
const monitor = require('./monitor');
const wa = require('./notify/whatsapp');
const reports = require('./reports');
const { notify } = require('./alerts');

const COOKIE_NAME = 'uptime_session';
const SESSION_SECRET = (config.admin.password || 'default_sec') + '_session_hash_key_2026';

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function signSession(user) {
  const ts = Date.now();
  const payload = Buffer.from(`${ts}:${user}`).toString('base64');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, hmac] = parts;
  try {
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (hmac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
    const [ts, user] = Buffer.from(payload, 'base64').toString('utf8').split(':');
    if (Date.now() - Number(ts) > 30 * 86400_000) return null;
    return user;
  } catch (_) { return null; }
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

function auth(req, res, next) {
  // 1. Check Session Cookie
  const cookies = parseCookies(req);
  const user = verifySession(cookies[COOKIE_NAME]);
  if (user && safeEq(user, config.admin.user)) {
    req.user = user;
    return next();
  }

  // 2. Check Basic Auth (for curl, automated monitors, tests)
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (safeEq(u, config.admin.user) && safeEq(p.join(':'), config.admin.password)) {
      req.user = u;
      return next();
    }
  }

  // API calls return 401 JSON
  if ((req.originalUrl || req.path || '').startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  res.set('WWW-Authenticate', 'Basic realm="Uptime Monitor"').status(401).send('Authentication required');
}

function cleanSite(body) {
  const type = body.type === 'tcp' ? 'tcp' : 'http';
  let url = String(body.url || '').trim();
  if (!url) throw new Error('URL is required');
  if (type === 'http') {
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { new URL(url); } catch (_) { throw new Error('Invalid URL'); }
  } else if (!/^(tcp:\/\/)?[^\s:]+:\d{1,5}$/.test(url)) {
    throw new Error('TCP target must look like host:port');
  }
  let name = String(body.name || '').trim();
  if (!name) name = type === 'http' ? new URL(url).hostname : url;
  const int = body.intervalMinutes === '' || body.intervalMinutes == null ? null : Number(body.intervalMinutes);
  if (int != null && (!(int >= 1) || int > 1440)) throw new Error('Interval must be between 1 and 1440 minutes');
  const to = body.timeoutMs === '' || body.timeoutMs == null ? null : Number(body.timeoutMs);
  if (to != null && (!(to >= 1000) || to > 120000)) throw new Error('Timeout must be between 1000 and 120000 ms');
  const expectedStatus = String(body.expectedStatus || '').trim();
  if (expectedStatus && !/^\d{3}(-\d{3})?(,\s*\d{3}(-\d{3})?)*$/.test(expectedStatus)) throw new Error('Expected status like 200 or 200-299');
  return {
    name: name.slice(0, 80), url, type,
    expectedStatus, keyword: String(body.keyword || '').trim().slice(0, 200),
    intervalMinutes: int, timeoutMs: to,
    ignoreTls: !!body.ignoreTls,
    enabled: body.enabled !== false,
    favorite: !!body.favorite,
  };
}

function view(site) {
  const h = (ms) => store.uptimePercent(site.id, ms);
  const recent = (store.checks[site.id] || []).slice(-40).map((c) => c[1]);
  return {
    ...site,
    uptime24h: h(86400_000), uptime7d: h(7 * 86400_000), uptime30d: h(30 * 86400_000),
    recent,
  };
}

function createServer() {
  const app = express();
  app.disable('x-powered-by');

  // Prevent proxy caching (OLS / Cloudflare)
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(e.status || 400).json({ error: e.message }));
  const find = (req) => {
    const s = store.db.sites.find((x) => x.id === req.params.id);
    if (!s) { const e = new Error('Site not found'); e.status = 404; throw e; }
    return s;
  };

  // Public Health
  app.get('/health', (_req, res) => res.json({ ok: true, sites: store.db.sites.length }));

  // Public Login
  app.post('/api/login', wrap(async (req, res) => {
    const { user, password } = req.body || {};
    if (!safeEq(user, config.admin.user) || !safeEq(password, config.admin.password)) {
      const e = new Error('Invalid username or password');
      e.status = 401;
      throw e;
    }
    const token = signSession(user);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
    res.json({ ok: true, user });
  }));

  // Public Session Status
  app.get('/api/auth/me', (req, res) => {
    const cookies = parseCookies(req);
    const user = verifySession(cookies[COOKIE_NAME]);
    if (user && safeEq(user, config.admin.user)) return res.json({ authenticated: true, user });
    res.json({ authenticated: false });
  });

  // Logout
  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  // Serve static UI dashboard assets
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // All /api/* routes below require authentication (Cookie or Basic Auth)
  app.use('/api', auth);

  app.get('/api/sites', (_req, res) => res.json(store.db.sites.map(view)));

  app.post('/api/sites', wrap((req, res) => {
    const site = { id: store.newId(), ...cleanSite(req.body), createdAt: Date.now(), state: store.newState() };
    store.db.sites.push(site);
    store.markDb();
    monitor.checkSite(site);
    res.status(201).json(view(site));
  }));

  // Bulk add: one per line, either "https://url" or "Name | https://url"
  app.post('/api/sites/bulk', wrap((req, res) => {
    const lines = String(req.body.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const added = []; const errors = [];
    for (const line of lines) {
      try {
        const [a, b] = line.includes('|') ? line.split('|').map((x) => x.trim()) : ['', line];
        const clean = cleanSite({ name: a, url: b });
        if (store.db.sites.some((s) => s.url === clean.url)) { errors.push(`${line}: already exists`); continue; }
        const site = { id: store.newId(), ...clean, createdAt: Date.now(), state: store.newState() };
        store.db.sites.push(site);
        added.push(site);
      } catch (e) { errors.push(`${line}: ${e.message}`); }
    }
    store.markDb();
    added.forEach((s) => monitor.checkSite(s));
    res.json({ added: added.length, errors });
  }));

  app.put('/api/sites/:id', wrap((req, res) => {
    const site = find(req);
    const wasEnabled = site.enabled;
    const favorite = req.body.favorite !== undefined ? !!req.body.favorite : site.favorite;
    Object.assign(site, cleanSite({ ...site, ...req.body }), { favorite });
    if (!wasEnabled && site.enabled) site.state.nextCheckAt = 0;
    store.markDb();
    if (site.state.nextCheckAt === 0) monitor.checkSite(site);
    res.json(view(site));
  }));

  app.delete('/api/sites/:id', wrap((req, res) => {
    const site = find(req);
    store.db.sites = store.db.sites.filter((s) => s !== site);
    delete store.checks[site.id];
    store.markDb(); store.markChecks();
    res.json({ ok: true });
  }));

  app.post('/api/sites/:id/check', wrap(async (req, res) => {
    const site = find(req);
    await monitor.checkSite(site);
    res.json(view(site));
  }));

  app.post('/api/sites/:id/favorite', wrap((req, res) => {
    const site = find(req);
    site.favorite = !site.favorite;
    store.markDb();
    res.json(view(site));
  }));

  app.get('/api/sites/:id/history', wrap((req, res) => {
    const site = find(req);
    const hours = Math.min(Number(req.query.hours) || 24, 24 * 30);
    const since = Date.now() - hours * 3600_000;
    res.json((store.checks[site.id] || []).filter((c) => c[0] >= since));
  }));

  app.get('/api/incidents', (_req, res) => res.json([...store.db.incidents].reverse().slice(0, 100)));
  app.get('/api/alerts', (_req, res) => res.json([...store.db.alerts].reverse().slice(0, 100)));

  app.get('/api/settings', (_req, res) => res.json({
    whatsapp: wa.getStatus(),
    email: { to: config.email.to, from: config.email.from, host: config.email.host, port: config.email.port },
    checkIntervalMinutes: config.checkIntervalMinutes,
    failureThreshold: config.failureThreshold,
    timezone: config.timezone,
  }));

  app.post('/api/test/:channel', wrap(async (req, res) => {
    const fake = { id: 'test', name: 'Test Site', url: 'https://example.com' };
    const ch = req.params.channel;
    if (!['email', 'whatsapp'].includes(ch)) throw new Error('Unknown channel');
    const entry = await notify('test', fake, {}, [ch]);
    res.json({ result: entry[ch] });
  }));

  app.post('/api/reports/:period', wrap(async (req, res) => {
    if (!['daily', 'weekly', 'monthly'].includes(req.params.period)) throw new Error('Unknown period');
    await reports.send(req.params.period);
    res.json({ ok: true });
  }));

  app.post('/api/whatsapp/logout', wrap(async (_req, res) => { await wa.logout(); res.json({ ok: true }); }));

  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

module.exports = { createServer };
