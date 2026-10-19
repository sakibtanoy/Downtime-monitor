'use strict';
// Built-in WhatsApp client (linked-device / QR login, like WhatsApp Web).
// Runs entirely inside this app - no third-party gateway or paid API.
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const config = require('../config');

const AUTH_DIR = path.join(config.dataDir, 'whatsapp-auth');
const log = pino({ level: 'silent' });

const state = { status: 'disconnected', qr: null, qrDataUrl: null, me: null, lastError: null, startedAt: null };
let sock = null;
let reconnectTimer = null;
let stopping = false;
const queue = []; // {jid, text, queuedAt} waiting for a connection
const QUEUE_MAX_AGE = 60 * 60 * 1000;

const toJid = (n) => (/@(g\.us|s\.whatsapp\.net)$/.test(n) ? n : `${String(n).replace(/\D/g, '')}@s.whatsapp.net`);

async function start() {
  if (config.whatsapp.provider !== 'self') return;
  if (sock) return;
  stopping = false;
  const baileys = require('@whiskeysockets/baileys');
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { /* use library default */ }

  state.status = 'connecting';
  state.startedAt = Date.now();
  sock = makeWASocket({
    auth,
    version,
    logger: log,
    browser: Browsers ? Browsers.macOS('Uptime Monitor') : ['Uptime Monitor', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      state.status = 'qr';
      state.qr = qr;
      try { state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 }); } catch (_) {}
      if (process.stdout.isTTY) {
        console.log('[whatsapp] Scan the QR code in the dashboard (Settings -> WhatsApp), or below:');
        try { console.log(await QRCode.toString(qr, { type: 'terminal', small: true })); } catch (_) {}
      } else {
        console.log('[whatsapp] QR code ready to scan in dashboard (Settings -> WhatsApp)');
      }
    }
    if (connection === 'open') {
      state.status = 'connected';
      state.qr = null; state.qrDataUrl = null; state.lastError = null;
      state.me = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      console.log(`[whatsapp] connected as +${state.me}`);
      flushQueue();
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      state.status = 'disconnected';
      state.lastError = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : null;
      sock = null;
      if (stopping) return;
      if (loggedOut) {
        console.log('[whatsapp] logged out from phone - clearing session, new QR will appear');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        console.log(`[whatsapp] connection closed (${code || state.lastError}), reconnecting...`);
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => start().catch((e) => console.error('[whatsapp]', e.message)), loggedOut ? 1000 : 5000);
    }
  });
}

async function flushQueue() {
  while (queue.length && state.status === 'connected') {
    const item = queue.shift();
    if (Date.now() - item.queuedAt > QUEUE_MAX_AGE) continue;
    try { await sock.sendMessage(item.jid, { text: item.text }); await new Promise((r) => setTimeout(r, 1500)); }
    catch (e) { console.error('[whatsapp] queued send failed:', e.message); }
  }
}

// Sends to every recipient in WHATSAPP_TO. If not connected yet, messages wait (up to 1h) and go out on reconnect.
async function sendWhatsApp(text) {
  if (config.whatsapp.provider !== 'self') throw new Error(`Unsupported WHATSAPP_PROVIDER "${config.whatsapp.provider}" (use "self")`);
  if (!config.whatsapp.to.length) throw new Error('WHATSAPP_TO is not configured');
  const results = [];
  for (const raw of config.whatsapp.to) {
    const jid = toJid(raw);
    if (state.status === 'connected' && sock) {
      try {
        await sock.sendMessage(jid, { text });
        results.push(`${raw}: sent`);
      } catch (e) {
        queue.push({ jid, text, queuedAt: Date.now() });
        results.push(`${raw}: failed (${e.message}), queued for retry`);
      }
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      queue.push({ jid, text, queuedAt: Date.now() });
      results.push(`${raw}: WhatsApp not connected (${state.status}) - queued`);
    }
  }
  if (state.status !== 'connected') {
    const err = new Error(results.join('; '));
    err.queued = true;
    throw err;
  }
  return results.join('; ');
}

async function logout() {
  stopping = true;
  clearTimeout(reconnectTimer);
  try { if (sock) await sock.logout(); } catch (_) { /* ignore */ }
  try { if (sock) sock.end(undefined); } catch (_) { /* ignore */ }
  sock = null;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  Object.assign(state, { status: 'disconnected', qr: null, qrDataUrl: null, me: null });
  setTimeout(() => start().catch(() => {}), 500);
}

const getStatus = () => ({
  provider: config.whatsapp.provider,
  status: state.status,
  qrDataUrl: state.qrDataUrl,
  me: state.me,
  recipients: config.whatsapp.to,
  queued: queue.length,
  lastError: state.lastError,
});

module.exports = { start, sendWhatsApp, logout, getStatus, isConfigured: () => config.whatsapp.to.length > 0 };
