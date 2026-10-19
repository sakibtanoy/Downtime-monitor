'use strict';
const nodemailer = require('nodemailer');
const config = require('../config');

let transporter;
function getTransporter() {
  if (transporter) return transporter;
  const e = config.email;
  const local = ['127.0.0.1', 'localhost', '::1'].includes(e.host);
  transporter = nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.secure,
    auth: e.user ? { user: e.user, pass: e.pass } : undefined,
    tls: local ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  return transporter;
}

async function sendEmail({ subject, text, html }) {
  if (!config.email.to.length) throw new Error('EMAIL_TO is not configured');
  const info = await getTransporter().sendMail({
    from: config.email.from,
    to: config.email.to.join(', '),
    subject,
    text,
    html,
  });
  return info.messageId;
}

module.exports = { sendEmail, isConfigured: () => config.email.to.length > 0 };
