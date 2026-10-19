'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
  timezone: env.TIMEZONE || 'Asia/Dhaka',

  checkIntervalMinutes: num(env.CHECK_INTERVAL_MINUTES, 5),
  requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 10000),
  failureThreshold: Math.max(1, num(env.FAILURE_THRESHOLD, 2)),
  // Re-send a reminder while a site stays down (0 = never)
  downReminderMinutes: num(env.DOWN_REMINDER_MINUTES, 60),
  sslWarnDays: num(env.SSL_WARN_DAYS, 14),
  historyDays: num(env.HISTORY_DAYS, 30),

  admin: { user: env.ADMIN_USER || 'admin', password: env.ADMIN_PASSWORD || '' },

  whatsapp: {
    provider: (env.WHATSAPP_PROVIDER || 'self').toLowerCase(),
    to: list(env.WHATSAPP_TO),
  },

  email: {
    host: env.SMTP_HOST || '127.0.0.1',
    port: num(env.SMTP_PORT, 25),
    secure: String(env.SMTP_SECURE).toLowerCase() === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.EMAIL_FROM || 'Uptime Monitor <alerts@localhost>',
    to: list(env.EMAIL_TO),
  },

  reports: {
    daily: env.DAILY_REPORT_CRON || '',
    weekly: env.WEEKLY_REPORT_CRON || '',
    monthly: env.MONTHLY_REPORT_CRON || '',
  },
};
