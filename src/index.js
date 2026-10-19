/**
 * Express + Telegram bot bootstrap.
 * - Validates required env vars on startup
 * - Serves admin dashboard at /admin.html
 * - Mounts /api/payments/* and /api/admin/* routers
 * - Starts bot in long-polling mode (default) or webhook mode (USE_WEBHOOK=true)
 * - Clean SIGINT/SIGTERM shutdown
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const { createBot } = require('./bot');
const payments = require('./payments');
const admin = require('./admin');
const draw = require('./draw');
const { pool } = require('./db');

function required(name, val) {
  if (!val) {
    console.error(`[boot] FATAL: environment variable ${name} is missing.`);
    console.error(`[boot] Copy .env.example to .env and fill in ${name}.`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const PORT = parseInt(process.env.PORT || '3000', 10);
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || 'false') === 'true';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

required('BOT_TOKEN', BOT_TOKEN);
required('ADMIN_KEY', ADMIN_KEY);
required('DATABASE_URL', DATABASE_URL);

if (ADMIN_KEY === 'change-me') {
  console.warn('[boot] WARNING: ADMIN_KEY is still "change-me". Set a strong key in .env.');
}

const app = express();
app.use(express.json());

// Serve admin dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routers
app.use('/api/payments', payments.router);
app.use('/api/admin', admin.router);

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Boot
(async () => {
  const bot = createBot(BOT_TOKEN);

  // Wire bot reference into modules that need to send messages
  payments.setBot(bot);
  admin.setBot(bot);
  draw.setBot(bot);

  if (USE_WEBHOOK) {
    if (!PUBLIC_URL) {
      console.error('[boot] FATAL: USE_WEBHOOK=true but PUBLIC_URL is not set.');
      process.exit(1);
    }
    const webhookPath = `/webhook`;
    const secret = BOT_TOKEN.slice(-16);
    app.use(express.json({ limit: '1mb' }));
    app.post(webhookPath, (req, res) => bot.handleUpdate(req.body, res));

    try {
      const hookUrl = `${PUBLIC_URL}${webhookPath}`;
      await bot.telegram.setWebhook(hookUrl, { secret_token: secret });
      console.log(`[boot] Webhook set to ${hookUrl}`);
    } catch (err) {
      console.error('[boot] setWebhook failed:', err.message);
    }
  } else {
    try {
      await bot.launch();
      console.log('[boot] Bot launched in long-polling mode.');
    } catch (err) {
      console.error('[boot] Bot launch failed:', err);
      process.exit(1);
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`[boot] HTTP server listening on port ${PORT}`);
    console.log(`[boot] Admin dashboard: http://localhost:${PORT}/admin.html`);
  });

  // Graceful shutdown
  const shutdown = async (sig) => {
    console.log(`[boot] ${sig} received, shutting down...`);
    try { bot.stop(sig); } catch (e) { /* ignore */ }
    try { server.close(); } catch (e) { /* ignore */ }
    try { await pool.end(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[boot] Unhandled rejection:', reason);
  });
})();
