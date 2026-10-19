'use strict';
const config = require('./config');
const store = require('./store');
const { sendEmail } = require('./notify/email');
const wa = require('./notify/whatsapp');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(ts) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: config.timezone }).format(new Date(ts));
}
function fmtDuration(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, (s || (!d && !h && !m)) && `${s}s`].filter(Boolean).join(' ');
}

const THEME = {
  down: { icon: '🔴', label: 'DOWN', color: '#d92d20' },
  up: { icon: '🟢', label: 'RECOVERED', color: '#12b76a' },
  reminder: { icon: '🔴', label: 'STILL DOWN', color: '#d92d20' },
  ssl: { icon: '🟠', label: 'SSL EXPIRING', color: '#f79009' },
  test: { icon: '🧪', label: 'TEST', color: '#2e90fa' },
};

function build(kind, site, info) {
  const t = THEME[kind];
  const lines = [`${t.icon} *${t.label}: ${site.name}*`, site.url];
  const rows = [['Site', site.name], ['Target', site.url]];
  let subject = `${t.icon} ${t.label}: ${site.name}`;
  if (kind === 'down' || kind === 'reminder') {
    lines.push(`Reason: ${info.error || 'No response'}`);
    rows.push(['Reason', info.error || 'No response']);
    if (kind === 'reminder') { lines.push(`Down for: ${fmtDuration(info.downFor)}`); rows.push(['Down for', fmtDuration(info.downFor)]); }
    else { lines.push(`Since: ${fmtTime(info.since)}`); rows.push(['Since', fmtTime(info.since)]); }
  } else if (kind === 'up') {
    lines.push(`Back online after ${fmtDuration(info.downFor)}`);
    rows.push(['Downtime', fmtDuration(info.downFor)], ['Recovered at', fmtTime(Date.now())]);
    subject = `${t.icon} UP: ${site.name} is back (down ${fmtDuration(info.downFor)})`;
  } else if (kind === 'ssl') {
    lines.push(`SSL certificate expires in ${info.days} day(s)`);
    rows.push(['Certificate expires in', `${info.days} day(s)`]);
  } else if (kind === 'test') {
    lines.push('Test alert - your notifications are working.');
    rows.push(['Message', 'Test alert - your notifications are working.']);
  }
  lines.push(fmtTime(Date.now()));
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto">
    <div style="background:${t.color};color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:18px;font-weight:600">${t.icon} ${esc(t.label)}: ${esc(site.name)}</div>
    <table style="width:100%;border:1px solid #e4e7ec;border-top:0;border-radius:0 0 10px 10px;border-collapse:collapse">
      ${rows.map(([k, v]) => `<tr><td style="padding:10px 18px;color:#667085;width:38%;border-top:1px solid #f2f4f7">${esc(k)}</td><td style="padding:10px 18px;border-top:1px solid #f2f4f7">${esc(v)}</td></tr>`).join('')}
    </table>
    <p style="color:#98a2b3;font-size:12px;text-align:center">Uptime Monitor &middot; ${esc(fmtTime(Date.now()))} (${esc(config.timezone)})</p></div>`;
  return { subject, whatsapp: lines.join('\n'), text: lines.join('\n').replace(/\*/g, ''), html };
}

// Sends to all channels independently: a failure in one never blocks the other.
async function notify(kind, site, info = {}, channels = ['email', 'whatsapp']) {
  const msg = build(kind, site, info);
  const skipped = Promise.resolve('skipped');
  const [email, whatsapp] = await Promise.allSettled([
    channels.includes('email') ? sendEmail({ subject: msg.subject, text: msg.text, html: msg.html }) : skipped,
    channels.includes('whatsapp') ? wa.sendWhatsApp(msg.whatsapp) : skipped,
  ]);
  const fmt = (r) => (r.status === 'fulfilled' ? (r.value === 'skipped' ? 'skipped' : 'sent') : `failed: ${r.reason.message}`);
  const entry = { ts: Date.now(), kind, siteId: site.id, siteName: site.name, email: fmt(email), whatsapp: fmt(whatsapp) };
  store.db.alerts.push(entry);
  store.markDb();
  console.log(`[alert] ${kind.toUpperCase()} ${site.name} -> email: ${entry.email} | whatsapp: ${entry.whatsapp}`);
  return entry;
}

module.exports = { notify, fmtDuration, fmtTime, esc };
