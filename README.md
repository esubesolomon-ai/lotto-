# 🇪🇹 Ethio Lottery

An Ethiopian Telegram lottery bot inspired by Italy's SuperEnalotto (6/90), with Telebirr and CBE Birr payment integration and an Ethiopian-flag-themed admin dashboard.

## Features

- **Telegram bot**: pick 6 numbers from 1–90 (or Quick Pick), pay via Telebirr / CBE Birr, view tickets & balance.
- **REST backend**: Express + PostgreSQL, signed payment webhooks, idempotent settlement.
- **Admin dashboard** (`/admin.html`): stats, recent tickets, users table with manual credit, broadcast, one-click draw run.
- **Draw engine**: twice-weekly draws (Wed & Sat), prizes for 3/4/5/6 matches, jackpot rollover on no 6-match.
- **Theme**: Ethiopian flag colors — Green `#078930`, Yellow `#FCDD09`, Red `#DA121A`, with a subtle pentagram star accent.

## Prerequisites

- Node.js 20+
- PostgreSQL 13+ (or the provisioned Supabase database)

## Setup

```bash
# 1. Create the database (local PostgreSQL)
createdb ethiolottery

# 2. Apply the schema
psql postgresql://postgres:postgres@localhost:5432/ethiolottery -f schema.sql

# 3. Install dependencies
npm install

# 4. Configure environment
cp .env.example .env
#   then edit .env and fill in BOT_TOKEN, ADMIN_KEY, DATABASE_URL, and payment keys

# 5. Run
npm run dev
```

## Running

```bash
npm run dev      # nodemon (auto-reload)
npm start        # production
```

On boot the server validates `BOT_TOKEN`, `ADMIN_KEY`, and `DATABASE_URL` and exits with a clear message if any is missing. The Telegram bot launches in **long-polling** mode by default. Set `USE_WEBHOOK=true` and `PUBLIC_URL=https://yourdomain.com` in `.env` to switch to webhook mode.

## Testing the bot

1. Open Telegram and message your bot.
2. Send `/start` — you'll see the main menu.
3. Tap **🎰 Buy Ticket**, pick 6 numbers (or tap 🎲 Quick Pick), then **✔️ Confirm**.
4. Tap **📱 Telebirr** or **🏦 CBE Birr**. In sandbox mode you'll get a **💳 Pay Now** button pointing at the provider's sandbox pay URL.
5. After the webhook fires (or you manually post to the notify endpoint), your ticket flips to `paid` and the bot messages you a confirmation.

## Admin dashboard

Open <http://localhost:3000/admin.html>, paste your `ADMIN_KEY`, and click **Save**. The dashboard loads:

- **Stat cards** — users, tickets sold, total sales (ETB), current jackpot (ETB).
- **Draw Control** — **🎲 Run Draw Now** (confirms first) renders the winning numbers, jolly ball, and winner count.
- **Recent Tickets** — last 200 tickets with color-coded status badges.
- **Users** — last 200 users with a per-row **Credit** input and button.
- **Broadcast** — send a message to every registered user.

All API calls send the `x-admin-key` header; results are echoed in the in-page log panel.

## Configuring Telebirr

1. Register at the **Ethio Telecom merchant portal** and request merchant access for the Telebirr API.
2. You'll receive an `APP_ID`, `APP_KEY`, and an RSA keypair (`TELEBIRR_PUBLIC_KEY`, `TELEBIRR_PRIVATE_KEY`), plus a `TELEBIRR_SHORT_CODE`.
3. In `.env`, set:
   ```
   TELEBIRR_BASE_URL=https://api.telebirr.com   # sandbox URL may differ
   TELEBIRR_APP_ID=...
   TELEBIRR_APP_KEY=...
   TELEBIRR_PUBLIC_KEY=...
   TELEBIRR_PRIVATE_KEY=...
   TELEBIRR_SHORT_CODE=...
   TELEBIRR_NOTIFY_URL=https://yourdomain.com/api/payments/telebirr/notify
   TELEBIRR_RETURN_URL=https://t.me/YourBot
   ```
4. Point the notify URL at a public HTTPS endpoint (use Nginx + Let's Encrypt in production — see Deployment).
5. Test end-to-end in the sandbox before going live.

## Configuring CBE Birr

1. Register with **Commercial Bank of Ethiopia merchant services**.
2. You'll receive a `CBE_MERCHANT_ID` and a `CBE_API_KEY` (used for HMAC-SHA256 signing).
3. In `.env`, set:
   ```
   CBE_BASE_URL=https://api.cbe.com.et/cbebirrmerchant
   CBE_MERCHANT_ID=...
   CBE_API_KEY=...
   CBE_NOTIFY_URL=https://yourdomain.com/api/payments/cbe/notify
   ```
4. Register your notify URL with CBE during onboarding.
5. Test in the sandbox before going live.

## Deployment (Ubuntu VPS + PM2 + Nginx + SSL)

```bash
# Install Node 20 + PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2

# Clone & build
git clone <your-repo> ethio-lottery && cd ethio-lottery
npm ci
cp .env.example .env && nano .env   # fill in real values
pm2 start src/index.js --name ethio-lottery
pm2 save && pm2 startup

# Nginx reverse proxy
sudo tee /etc/nginx/sites-available/ethio-lottery >/dev/null <<'EOF'
server {
  server_name yourdomain.com;
  location / { proxy_pass http://127.0.0.1:3000; }
}
EOF
sudo ln -s /etc/nginx/sites-available/ethio-lottery /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com

# Switch to webhook mode
# Edit .env: USE_WEBHOOK=true, PUBLIC_URL=https://yourdomain.com
pm2 restart ethio-lottery

# Or set the webhook manually:
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://yourdomain.com/webhook"
```

## Legal notice

Real-money lotteries require an **Ethiopian operating license**. This software is provided as a technical reference implementation only. Operating an unlicensed lottery is illegal in Ethiopia. Obtain the appropriate gambling/lottery license from the relevant Ethiopian authority before accepting real payments.
