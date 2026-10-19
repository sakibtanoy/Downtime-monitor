'use strict';
const config = require('./config');
const store = require('./store');
const wa = require('./notify/whatsapp');
const monitor = require('./monitor');
const reports = require('./reports');
const { createServer } = require('./server');

if (!config.admin.password) {
  console.error('ADMIN_PASSWORD is not set in .env - refusing to start an unprotected dashboard.');
  process.exit(1);
}

// Sites start from a clean slate for scheduling after a restart
for (const s of store.db.sites) {
  if (s.enabled === undefined) s.enabled = true;
  if (s.favorite === undefined) s.favorite = false;
  s.state = Object.assign(store.newState(), s.state, { nextCheckAt: 0 });
}

createServer().listen(config.port, config.host, () => {
  console.log(`[server] dashboard on http://${config.host}:${config.port}  (${store.db.sites.length} site(s))`);
});
wa.start().catch((e) => console.error('[whatsapp] start failed:', e.message));
monitor.start();
reports.start();

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
