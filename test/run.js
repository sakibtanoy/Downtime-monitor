'use strict';
// End-to-end test with a fake SMTP server, a fake WhatsApp sender and a toggleable web server.
// Uses a temp data dir and never touches your real .env / data / WhatsApp session.
const net = require('net');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-test-'));
const mails = [];

function fakeSmtp() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let inData = false, buf = '';
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (d) => {
        buf += d.toString();
        if (inData) {
          if (buf.endsWith('\r\n.\r\n')) { mails.push(buf); buf = ''; inData = false; sock.write('250 queued\r\n'); }
          return;
        }
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^EHLO|^HELO/i.test(line)) sock.write('250 fake\r\n');
          else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); break; }
          else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const smtp = await fakeSmtp();
  Object.assign(process.env, {
    DATA_DIR: tmp, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false',
    EMAIL_TO: 'me@example.com', EMAIL_FROM: 'Uptime Monitor <alerts@example.com>', WHATSAPP_TO: '+8801700000000',
    FAILURE_THRESHOLD: '2', ADMIN_USER: 'admin', ADMIN_PASSWORD: 's3cret', REQUEST_TIMEOUT_MS: '2000', DOWN_REMINDER_MINUTES: '0',
  });
  process.env.WHATSAPP_PROVIDER = 'self';

  const store = require('../src/store');
  const wa = require('../src/notify/whatsapp');
  const waSent = [];
  wa.sendWhatsApp = async (text) => { waSent.push(text); return 'sent'; };
  const monitor = require('../src/monitor');
  const { createServer } = require('../src/server');

  // target site we can switch on/off
  let mode = 'up';
  const target = http.createServer((req, res) => {
    if (mode === 'down') { req.socket.destroy(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/' }); return res.end(); }
    if (req.url === '/500') { res.writeHead(500); return res.end('boom'); }
    if (req.url === '/blank') { res.writeHead(200); return res.end(''); }
    if (req.url === '/whitespace') { res.writeHead(200); return res.end('   \n\t  \n'); }
    if (req.url === '/empty-skeleton') { res.writeHead(200); return res.end('<!DOCTYPE html><html><head><title></title></head><body></body></html>'); }
    if (req.url === '/wp-critical') {
      res.writeHead(200);
      return res.end('<body id="error-page"><div class="wp-die-message"><p>There has been a critical error on this website.</p></div></body>');
    }
    if (req.url === '/wp-db-error') { res.writeHead(200); return res.end('<h1>Error establishing a database connection</h1>'); }
    if (req.url === '/php-fatal') { res.writeHead(200); return res.end('<b>Fatal error</b>: Uncaught Error: Call to undefined function wp() in /var/www/index.php:12'); }
    if (req.url === '/wp-maintenance') { res.writeHead(200); return res.end('Briefly unavailable for scheduled maintenance. Check back in a minute.'); }
    if (req.url === '/spa') { res.writeHead(200); return res.end('<!doctype html><html><head><title>Admin</title><script src="/assets/app.js"></script></head><body><div id="root"></div></body></html>'); }
    res.writeHead(200); res.end('<html>Welcome to my shop</html>');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${target.address().port}`;

  const app = createServer();
  const api = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const apiBase = `http://127.0.0.1:${api.address().port}`;
  const authH = { Authorization: 'Basic ' + Buffer.from('admin:s3cret').toString('base64'), 'Content-Type': 'application/json' };
  const call = async (m, p, body) => { const r = await fetch(apiBase + p, { method: m, headers: authH, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  let n = 0; const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);

  // --- API & auth
  assert.strictEqual((await fetch(apiBase + '/api/sites')).status, 401); ok('API rejects requests without login');
  assert.strictEqual((await fetch(apiBase + '/health')).status, 200); ok('/health is public');
  const bad = await call('POST', '/api/sites', { url: 'not a url ::' });
  assert.strictEqual(bad.status, 400); ok('invalid site rejected');

  // --- site goes up -> down -> up
  const created = await call('POST', '/api/sites', { name: 'Shop', url: base + '/' });
  assert.strictEqual(created.status, 201);
  const site = store.db.sites.find((s) => s.id === created.body.id);
  await new Promise((r) => setTimeout(r, 500)); // initial auto-check
  assert.strictEqual(site.state.status, 'up'); ok('new site checked and marked UP');
  assert.strictEqual(mails.length, 0); ok('no alert while healthy');

  mode = 'down';
  await monitor.checkSite(site);
  assert.strictEqual(site.state.status, 'up'); assert.strictEqual(site.state.failures, 1);
  assert.strictEqual(mails.length, 0); ok('single failure does NOT alert (false-alarm protection)');
  assert.ok(site.state.nextCheckAt - Date.now() < 35000); ok('failed check schedules quick re-check (~30s)');

  await monitor.checkSite(site);
  assert.strictEqual(site.state.status, 'down'); ok('second consecutive failure marks DOWN');
  assert.strictEqual(mails.length, 1); assert.ok(/DOWN: Shop/.test(mails[0])); ok('DOWN email sent');
  assert.strictEqual(waSent.length, 1); assert.ok(/DOWN: Shop/.test(waSent[0])); ok('DOWN WhatsApp sent');

  await monitor.checkSite(site);
  assert.strictEqual(mails.length, 1); assert.strictEqual(waSent.length, 1); ok('no repeat alert while still down');
  assert.strictEqual(store.db.incidents.length, 1); assert.strictEqual(store.db.incidents[0].endedAt, null); ok('incident opened');

  mode = 'up';
  await new Promise((r) => setTimeout(r, 1100));
  await monitor.checkSite(site);
  assert.strictEqual(site.state.status, 'up'); assert.strictEqual(mails.length, 2); assert.strictEqual(waSent.length, 2);
  assert.ok(/RECOVERED: Shop/.test(mails[1])); assert.ok(/Back online after/.test(waSent[1])); ok('recovery email + WhatsApp sent');
  assert.ok(store.db.incidents[0].endedAt); ok('incident closed');

  // --- check types
  const { runCheck } = require('../src/checker');
  const d = { requestTimeoutMs: 2000 };
  assert.ok((await runCheck({ type: 'http', url: base + '/redirect' }, d)).ok); ok('follows redirects');
  assert.ok(!(await runCheck({ type: 'http', url: base + '/500' }, d)).ok); ok('HTTP 500 = down');
  assert.ok((await runCheck({ type: 'http', url: base + '/500', expectedStatus: '500' }, d)).ok); ok('expected status override');
  assert.ok((await runCheck({ type: 'http', url: base + '/', keyword: 'my shop' }, d)).ok); ok('keyword found = up');
  const kw = await runCheck({ type: 'http', url: base + '/', keyword: 'hacked' }, d);
  assert.ok(!kw.ok && /not found/.test(kw.error)); ok('keyword missing = down');
  const refused = await runCheck({ type: 'http', url: 'http://127.0.0.1:1/' }, d);
  assert.ok(!refused.ok && /refused/i.test(refused.error)); ok('connection refused = readable error');
  assert.ok((await runCheck({ type: 'tcp', url: `127.0.0.1:${target.address().port}` }, d)).ok); ok('TCP port check up');
  assert.ok(!(await runCheck({ type: 'tcp', url: '127.0.0.1:1' }, d)).ok); ok('TCP port check down');

  // --- blank page & critical error checks
  const blankCheck = await runCheck({ type: 'http', url: base + '/blank' }, d);
  assert.ok(!blankCheck.ok && /Blank page/i.test(blankCheck.error)); ok('blank page (0 bytes) detected');
  const blankIgnored = await runCheck({ type: 'http', url: base + '/blank', checkBlank: false }, d);
  assert.ok(blankIgnored.ok); ok('blank page check can be disabled');
  const wsCheck = await runCheck({ type: 'http', url: base + '/whitespace' }, d);
  assert.ok(!wsCheck.ok && /whitespace only/i.test(wsCheck.error)); ok('whitespace-only page detected');
  const skelCheck = await runCheck({ type: 'http', url: base + '/empty-skeleton' }, d);
  assert.ok(!skelCheck.ok && /Blank page/i.test(skelCheck.error)); ok('empty HTML skeleton (WSOD) detected');

  const wpCrit = await runCheck({ type: 'http', url: base + '/wp-critical' }, d);
  assert.ok(!wpCrit.ok && /WordPress critical error/i.test(wpCrit.error)); ok('WordPress critical error detected');
  const wpCritIgnored = await runCheck({ type: 'http', url: base + '/wp-critical', checkErrors: false }, d);
  assert.ok(wpCritIgnored.ok); ok('critical error check can be disabled');

  const dbErr = await runCheck({ type: 'http', url: base + '/wp-db-error' }, d);
  assert.ok(!dbErr.ok && /Database connection error/i.test(dbErr.error)); ok('WordPress database connection error detected');
  const phpErr = await runCheck({ type: 'http', url: base + '/php-fatal' }, d);
  assert.ok(!phpErr.ok && /PHP Fatal error/i.test(phpErr.error)); ok('PHP Fatal error detected');
  const maintErr = await runCheck({ type: 'http', url: base + '/wp-maintenance' }, d);
  assert.ok(!maintErr.ok && /WordPress maintenance mode/i.test(maintErr.error)); ok('WordPress maintenance mode detected');

  const spaCheck = await runCheck({ type: 'http', url: base + '/spa' }, d);
  assert.ok(spaCheck.ok); ok('SPA with scripts and empty body is healthy (not blank)');

  assert.strictEqual(wpCrit.errorType, 'error'); ok('WordPress critical error sets errorType: error');
  assert.strictEqual(refused.errorType, 'down'); ok('connection refused sets errorType: down');

  // --- bulk, test endpoints, reports
  const bulk = await call('POST', '/api/sites/bulk', { text: `A | ${base}/a\n${base}/\nbad line ::` });
  assert.ok(bulk.body.added === 1 && bulk.body.errors.length === 2); ok('bulk add (dedupe + validation)');
  const before = mails.length;
  assert.strictEqual((await call('POST', '/api/test/email')).body.result, 'sent'); assert.strictEqual(mails.length, before + 1); ok('test-email button works');
  assert.strictEqual((await call('POST', '/api/test/whatsapp')).body.result, 'sent'); ok('test-WhatsApp button works');
  await call('POST', '/api/reports/daily'); assert.ok(mails.some((m) => /% uptime, \d+ incident/.test(m))); ok('uptime report email works');
  const list = await call('GET', '/api/sites');
  assert.ok(list.body[0].uptime24h < 100 && list.body[0].uptime24h > 0); ok('uptime % computed');
  assert.strictEqual((await call('DELETE', `/api/sites/${site.id}`)).status, 200); ok('delete site');

  console.log(`\nAll ${n} checks passed.`);
  store.flush(); process.exit(0);
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
