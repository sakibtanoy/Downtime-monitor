'use strict';
const cron = require('node-cron');
const config = require('./config');
const store = require('./store');
const { sendEmail } = require('./notify/email');
const { esc, fmtDuration, fmtTime } = require('./alerts');

const PERIODS = {
  daily: { label: 'Daily', ms: 86400_000 },
  weekly: { label: 'Weekly', ms: 7 * 86400_000 },
  monthly: { label: 'Monthly', ms: 30 * 86400_000 },
};

function build(period) {
  const p = PERIODS[period];
  const since = Date.now() - p.ms;
  const rows = store.db.sites.map((s) => {
    const up = store.uptimePercent(s.id, p.ms);
    const arr = (store.checks[s.id] || []).filter((c) => c[0] >= since && c[2] != null);
    const avg = arr.length ? Math.round(arr.reduce((a, c) => a + c[2], 0) / arr.length) : null;
    const incs = store.db.incidents.filter((i) => i.siteId === s.id && (i.endedAt || Date.now()) >= since);
    const downtime = incs.reduce((a, i) => a + ((i.endedAt || Date.now()) - Math.max(i.startedAt, since)), 0);
    return { name: s.name, url: s.url, up, avg, incidents: incs.length, downtime };
  });
  const text = rows.map((r) => `${r.name}: ${r.up == null ? 'n/a' : r.up.toFixed(2) + '%'} uptime, ${r.incidents} incident(s), downtime ${fmtDuration(r.downtime)}, avg ${r.avg ?? '-'} ms`).join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:720px">
    <h2 style="margin:0 0 4px">${p.label} uptime report</h2>
    <div style="color:#667085;margin-bottom:14px">${esc(fmtTime(since))} &rarr; ${esc(fmtTime(Date.now()))}</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr style="text-align:left;background:#f9fafb"><th style="padding:8px">Site</th><th>Uptime</th><th>Incidents</th><th>Downtime</th><th>Avg response</th></tr>
      ${rows.map((r) => `<tr style="border-top:1px solid #eaecf0"><td style="padding:8px"><b>${esc(r.name)}</b><br><span style="color:#98a2b3;font-size:12px">${esc(r.url)}</span></td>
        <td style="color:${r.up != null && r.up < 99 ? '#d92d20' : '#12b76a'};font-weight:600">${r.up == null ? 'n/a' : r.up.toFixed(2) + '%'}</td><td>${r.incidents}</td><td>${esc(fmtDuration(r.downtime))}</td><td>${r.avg == null ? '-' : r.avg + ' ms'}</td></tr>`).join('')}
    </table></div>`;
  return { subject: `📊 ${p.label} uptime report - ${rows.length} site(s)`, text, html };
}

async function send(period) {
  if (!store.db.sites.length) return;
  const m = build(period);
  try { await sendEmail(m); console.log(`[report] ${period} report sent`); }
  catch (e) { console.error(`[report] ${period} failed: ${e.message}`); }
}

function start() {
  for (const k of Object.keys(PERIODS)) {
    const expr = config.reports[k];
    if (!expr) continue;
    if (!cron.validate(expr)) { console.error(`[report] invalid cron for ${k}: "${expr}"`); continue; }
    cron.schedule(expr, () => send(k), { timezone: config.timezone });
  }
}

module.exports = { start, send, build };
