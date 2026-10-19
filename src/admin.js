/**
 * Admin API routes. All routes require x-admin-key header matching ADMIN_KEY.
 */
const express = require('express');
const { query, getClient } = require('./db');
const { runDraw } = require('./draw');

const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';

/** Auth middleware. */
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.use(adminAuth);

// Stats overview
router.get('/stats', async (req, res) => {
  try {
    const users = await query(`SELECT COUNT(*)::int AS c FROM users`);
    const tickets = await query(`SELECT COUNT(*)::int AS c FROM tickets`);
    const sales = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS s FROM tickets WHERE status = 'paid'`
    );
    const jackpot = await query(
      `SELECT jackpot_amount::float AS j FROM draws WHERE status = 'open' ORDER BY id DESC LIMIT 1`
    );
    res.json({
      users: users.rows[0].c,
      tickets: tickets.rows[0].c,
      sales: sales.rows[0].s,
      jackpot: jackpot.rows.length > 0 ? jackpot.rows[0].j : 0,
    });
  } catch (err) {
    console.error('[admin] stats error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Recent users
router.get('/users', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, telegram_id, username, first_name, balance, created_at
       FROM users ORDER BY id DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin] users error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Recent tickets joined with user
router.get('/tickets', async (req, res) => {
  try {
    const r = await query(
      `SELECT t.id, t.numbers, t.status, t.amount, t.payment_method, t.payment_ref,
              t.created_at, u.username, u.telegram_id
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       ORDER BY t.id DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin] tickets error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Run draw now
router.post('/draw/run', async (req, res) => {
  try {
    const result = await runDraw();
    res.json(result);
  } catch (err) {
    console.error('[admin] draw/run error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Broadcast message to all users
let botRef = null;
function setBot(b) { botRef = b; }

router.post('/broadcast', express.json(), async (req, res) => {
  try {
    const message = (req.body && req.body.message) || '';
    if (!message) return res.status(400).json({ error: 'message required' });
    if (!botRef) return res.status(500).json({ error: 'bot not initialized' });

    const users = await query(`SELECT telegram_id FROM users`);
    let sent = 0;
    for (const u of users.rows) {
      try {
        await botRef.telegram.sendMessage(u.telegram_id, message);
        sent++;
      } catch (err) {
        console.error(`[admin] broadcast to ${u.telegram_id} failed:`, err.message);
      }
    }
    res.json({ sent, total: users.rows.length });
  } catch (err) {
    console.error('[admin] broadcast error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Manual credit a user
router.post('/user/:id/credit', express.json(), async (req, res) => {
  const client = await getClient();
  try {
    const userId = parseInt(req.params.id, 10);
    const amount = parseFloat(req.body && req.body.amount);
    if (Number.isNaN(amount) || amount === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    await client.query('BEGIN');
    const u = await client.query(
      `UPDATE users SET balance = balance + $2 WHERE id = $1 RETURNING balance`,
      [userId, amount]
    );
    if (u.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, reference, status, meta)
       VALUES ($1, 'admin_credit', $2, $3, 'success', $4)`,
      [userId, amount, `ADMIN-${userId}-${Date.now()}`, JSON.stringify({ by: 'admin', note: 'manual credit' })]
    );
    await client.query('COMMIT');
    res.json({ id: userId, balance: u.rows[0].balance });
  } catch (err) {
    console.error('[admin] credit error:', err);
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

module.exports = { router, setBot };
