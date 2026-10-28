# Uptime Monitor

Self-hosted website monitor. Checks your sites on a schedule and sends **email + WhatsApp**
alerts when one goes down (and when it recovers). No third-party monitoring service, no database
server - just Node.js and a few JSON files in `data/`.

## Features
- HTTP/HTTPS checks (redirects, expected status, "page must contain text") and TCP port checks
- **WordPress & PHP Crash Detection**: automatically flags White Screen of Death (0-byte / whitespace / empty skeleton blank pages), WordPress critical errors ("There has been a critical error on this website"), database connection failures, PHP fatal/parse errors, and stuck maintenance mode - even if the server returns HTTP 200
- **False-alarm protection**: a site is only "down" after `FAILURE_THRESHOLD` failed checks; a failed
  check is re-tried after 30 s instead of waiting a full interval
- **Favorites / Starred Section**: pin priority websites to a dedicated top section with quick toggle
- DOWN, RECOVERED (with downtime length), still-down reminders, and SSL-expiring alerts
- Email via SMTP (local Postfix or any provider) and WhatsApp via a built-in linked-device client
- Dashboard: add / bulk-add / edit / pause sites, uptime %, response times, incidents, alert log, test buttons
- Daily / weekly / monthly uptime report emails (cron times in `.env`)

## Run it
```bash
npm install
# edit .env (ADMIN_PASSWORD, EMAIL_TO, WHATSAPP_TO, SMTP_*)
npm start            # http://localhost:3010  (login: ADMIN_USER / ADMIN_PASSWORD)
npm test             # self-contained end-to-end tests (uses fake SMTP/WhatsApp, touches no real data)
```

## Link WhatsApp (one time)
1. Start the app, open the dashboard -> **Notifications**.
2. On the phone: WhatsApp -> Settings -> **Linked devices** -> Link a device -> scan the QR.
3. Click **Send test**. The session is stored in `data/whatsapp-auth/` (treat it like a password).

Notes:
- This uses WhatsApp's unofficial linked-device protocol (the same thing WhatsApp Web uses). It's free and
  self-contained, but WhatsApp doesn't officially sanction it. Use a **dedicated number**, keep volume low
  (alerts only), and send to your own numbers/groups. `WHATSAPP_TO` accepts numbers (`+8801...`) and group IDs (`...@g.us`).
- If WhatsApp is unreachable when a site goes down, the message is queued for up to 1 hour and sent on reconnect.
  Email is sent independently, so one channel failing never blocks the other.

## Email
- Local Postfix: `SMTP_HOST=127.0.0.1`, `SMTP_PORT=25`. Make sure the sending domain has SPF/DKIM or the
  alert may land in spam - send the dashboard's **Send test** and check.
- Or any SMTP provider (Gmail app password, Zoho...): set `SMTP_HOST/PORT/SECURE/USER/PASS`.

## Deploy on your server
```bash
sudo useradd -r -s /usr/sbin/nologin uptime
sudo mkdir -p /opt/uptime-monitor && sudo cp -r . /opt/uptime-monitor && cd /opt/uptime-monitor
sudo npm install --omit=dev && sudo chown -R uptime: /opt/uptime-monitor
sudo cp deploy/uptime-monitor.service /etc/systemd/system/
sudo systemctl enable --now uptime-monitor
```
Put it behind HTTPS (nginx/Caddy reverse proxy) and set `HOST=127.0.0.1` - the dashboard uses a password
over HTTP Basic auth, which is only safe over HTTPS.

### Important: who watches the watcher?
If the monitor runs on the same server it monitors and that server (or its network) dies, **no alert can be sent**.
Ideally run this on a separate small VPS / different provider than your main sites. `GET /health` is a public
endpoint you can point a second instance at for mutual monitoring.

## Files
`src/monitor.js` scheduler & state machine · `src/checker.js` HTTP/TCP checks · `src/alerts.js` message templates ·
`src/notify/` email + WhatsApp · `src/server.js` API · `public/index.html` dashboard · `data/` runtime data (git-ignored)
