'use strict';
// Tiny JSON-file store. No native modules, nothing to install on the server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const DB_FILE = path.join(config.dataDir, 'db.json');
const CHECKS_FILE = path.join(config.dataDir, 'checks.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[store] could not read ${file}: ${e.message} - starting empty`);
    return fallback;
  }
}
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const db = Object.assign({ sites: [], incidents: [], alerts: [] }, readJson(DB_FILE, {}));
// checks[siteId] = [[timestampMs, ok(1|0), responseMs], ...]
const checks = readJson(CHECKS_FILE, {});

let dbDirty = false;
let checksDirty = false;
const markDb = () => { dbDirty = true; };
const markChecks = () => { checksDirty = true; };

function flush() {
  if (dbDirty) { writeAtomic(DB_FILE, db); dbDirty = false; }
  if (checksDirty) { writeAtomic(CHECKS_FILE, checks); checksDirty = false; }
}
setInterval(flush, 10_000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
process.on('exit', flush);

const newId = () => crypto.randomBytes(5).toString('hex');

function newState() {
  return {
    status: 'unknown', // unknown | up | down | error
    failures: 0,
    lastCheck: null,
    nextCheckAt: 0,
    lastChange: null,
    lastError: null,
    lastErrorType: null,
    lastMs: null,
    lastStatusCode: null,
    sslDaysLeft: null,
    lastAlertAt: null,
    sslAlertedAt: null,
    incidentId: null,
  };
}

function addCheck(siteId, ts, ok, ms, errorType) {
  const arr = (checks[siteId] = checks[siteId] || []);
  const val = ok ? 1 : (errorType === 'error' ? 2 : 0);
  arr.push([ts, val, ms == null ? null : Math.round(ms)]);
  markChecks();
}

function prune() {
  const cutoff = Date.now() - config.historyDays * 86400_000;
  for (const id of Object.keys(checks)) {
    if (!db.sites.some((s) => s.id === id)) { delete checks[id]; continue; }
    const arr = checks[id];
    let i = 0;
    while (i < arr.length && arr[i][0] < cutoff) i++;
    if (i) arr.splice(0, i);
  }
  db.incidents = db.incidents.filter((i) => (i.endedAt || Date.now()) >= cutoff).slice(-1000);
  db.alerts = db.alerts.slice(-500);
  markChecks(); markDb();
}
setInterval(prune, 3600_000).unref();
prune();

function uptimePercent(siteId, windowMs) {
  const arr = checks[siteId] || [];
  const since = Date.now() - windowMs;
  let total = 0, okc = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i][0] < since) break;
    total++;
    if (arr[i][1] === 1) okc++;
  }
  return total ? (okc / total) * 100 : null;
}

module.exports = { db, checks, markDb, markChecks, flush, newId, newState, addCheck, uptimePercent };
