
require('dotenv').config();

const express = require('express');
const path = require('path');

const { createBot } = require('./bot');
const payments = require('./payments');
const admin = require('./admin');
const draw = require('./draw');
const { pool } = require('./db');

const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DATABASE_URL =
  process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

const PORT = Number(process.env.PORT || 3000);
const USE_WEBHOOK =
  String(process.env.USE_WEBHOOK || 'false').toLowerCase() === 'true';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

function checkRequired(name, value) {
  if (!value) {
    console.error(`[boot] Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

checkRequired('BOT_TOKEN', BOT_TOKEN);
checkRequired('ADMIN_KEY', ADMIN_KEY);
checkRequired('DATABASE_URL', DATABASE_URL);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Ethiopia Lucky Star</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #101827;
            color: white;
            text-align: center;
            padding: 50px 20px;
          }
          h1 { color: #e9b949; }
          a { color: #e9b949; }
          .card {
            max-width: 500px;
            margin: 30px auto;
            padding: 25px;
            background: #1b2940;
            border-radius: 12px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>⭐ Ethiopia Lucky Star</h1>
          <h2>Lottery Demo</h2>
          <p>Server status: Online</p>
          <p>Mode: DEMO</p>
          <p>Real-money payments are disabled.</p>
          <p><a href="/health">Check server health</a></p>
          <p><a href="/admin.html">Open admin dashboard</a></p>
        </div>
      </body>
    </html>
  `);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.use('/api/payments', payments.router);
app.use('/api/admin', admin.router);

async function start() {
  const bot = createBot(BOT_TOKEN);

  payments.setBot(bot);
  admin.setBot(bot);
  draw.setBot(bot);

  if (USE_WEBHOOK) {
    if (!PUBLIC_URL) {
      throw new Error('PUBLIC_URL is required when USE_WEBHOOK=true');
    }

    const webhookPath = '/telegram/webhook';
    const secret = BOT_TOKEN.slice(-16);

    app.post(webhookPath, (req, res, next) => {
      const suppliedSecret =
        req.get('X-Telegram-Bot-Api-Secret-Token');

      if (suppliedSecret !== secret) {
        return res.sendStatus(403);
      }

      return bot.handleUpdate(req.body, res).catch(next);
    });

    await bot.telegram.setWebhook(`${PUBLIC_URL}${webhookPath}`, {
      secret_token: secret,
      drop_pending_updates: false
    });

    console.log(`[boot] Webhook configured: ${PUBLIC_URL}${webhookPath}`);
  }

  const server = app.listen(PORT, () => {
    console.log(`[boot] HTTP server listening on port ${PORT}`);
    console.log('[boot] Lottery mode: DEMO');
    console.log(`[boot] Admin dashboard: /admin.html`);
  });

  if (!USE_WEBHOOK) {
    try {
      await bot.launch();
      console.log('[boot] Telegram bot started using long polling.');
    } catch (err) {
      console.error('[boot] Telegram bot launch failed:', err.message);
      server.close();
      process.exit(1);
    }
  }

  const shutdown = async (signal) => {
    console.log(`[boot] ${signal}: shutting down`);

    try {
      if (!USE_WEBHOOK) bot.stop(signal);
    } catch (_) {}

    server.close();

    try {
      await pool.end();
    } catch (_) {}

    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('[boot] Startup failed:', err.message);
  process.exit(1);
});
