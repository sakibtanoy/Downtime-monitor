'use strict';
const config = require('./config');
const store = require('./store');
const { runCheck } = require('./checker');
const { notify } = require('./alerts');

const TICK_MS = 10_000;
const CONCURRENCY = 10;
const CONFIRM_RETRY_MS = 30_000; // re-check quickly after a failure to confirm it
const running = new Set();

function intervalMs(site) {
  return (site.intervalMinutes || config.checkIntervalMinutes) * 60_000;
}

async function checkSite(site) {
  if (running.has(site.id)) return;
  running.add(site.id);
  try {
    const r = await runCheck(site, config);
    await applyResult(site, r);
  } catch (e) {
    console.error(`[monitor] ${site.name}: ${e.stack || e.message}`);
  } finally {
    running.delete(site.id);
  }
}

async function applyResult(site, r) {
  const now = Date.now();
  const st = site.state;
  store.addCheck(site.id, now, r.ok, r.ms);
  st.lastCheck = now;
  st.lastMs = r.ms;
  st.lastStatusCode = r.statusCode ?? null;
  st.lastError = r.ok ? null : r.error;
  if (r.sslDaysLeft != null) st.sslDaysLeft = r.sslDaysLeft;

  if (r.ok) {
    st.failures = 0;
    st.nextCheckAt = now + intervalMs(site);
    if (st.status === 'down') {
      const inc = store.db.incidents.find((i) => i.id === st.incidentId);
      const downFor = now - (inc ? inc.startedAt : st.lastChange);
      if (inc) inc.endedAt = now;
      st.status = 'up'; st.lastChange = now; st.incidentId = null; st.lastAlertAt = null;
      store.markDb();
      await notify('up', site, { downFor });
    } else {
      if (st.status !== 'up') { st.status = 'up'; st.lastChange = now; }
      store.markDb();
    }
    // SSL expiry warning (at most once a day)
    if (st.sslDaysLeft != null && st.sslDaysLeft <= config.sslWarnDays && (!st.sslAlertedAt || now - st.sslAlertedAt > 86400_000)) {
      st.sslAlertedAt = now;
      store.markDb();
      await notify('ssl', site, { days: st.sslDaysLeft });
    }
    return;
  }

  // Failure
  st.failures += 1;
  if (st.status === 'down') {
    st.nextCheckAt = now + intervalMs(site);
    const rem = config.downReminderMinutes * 60_000;
    if (rem && now - (st.lastAlertAt || 0) >= rem) {
      st.lastAlertAt = now;
      const inc = store.db.incidents.find((i) => i.id === st.incidentId);
      store.markDb();
      await notify('reminder', site, { error: r.error, downFor: now - (inc ? inc.startedAt : now) });
    }
  } else if (st.failures >= config.failureThreshold) {
    const startedAt = now;
    const inc = { id: store.newId(), siteId: site.id, siteName: site.name, startedAt, endedAt: null, error: r.error };
    store.db.incidents.push(inc);
    st.status = 'down'; st.lastChange = now; st.incidentId = inc.id; st.lastAlertAt = now;
    st.nextCheckAt = now + intervalMs(site);
    store.markDb();
    await notify('down', site, { error: r.error, since: startedAt });
  } else {
    // Not confirmed yet - retry soon instead of waiting a whole interval
    st.nextCheckAt = now + CONFIRM_RETRY_MS;
    store.markDb();
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const due = store.db.sites.filter((s) => s.enabled && !running.has(s.id) && (s.state.nextCheckAt || 0) <= now);
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      await Promise.all(due.slice(i, i + CONCURRENCY).map(checkSite));
    }
  } finally {
    ticking = false;
  }
}

function start() {
  setInterval(() => tick().catch((e) => console.error('[monitor] tick', e)), TICK_MS).unref?.();
  tick().catch(() => {});
}

module.exports = { start, checkSite, tick };
