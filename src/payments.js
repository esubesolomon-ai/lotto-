/**
 * Payment webhook routes for Telebirr & CBE Birr.
 * Idempotent: repeated callbacks for the same reference never double-credit.
 */
const express = require('express');
const { query, getClient } = require('./db');
const telebirr = require('./telebirr');
const cbe = require('./cbe');

const router = express.Router();

/** Notify a buyer via Telegram. botRef is set by index.js after bot boot. */
let botRef = null;
function setBot(b) {
  botRef = b;
}

/**
 * @param {number} telegramId
 * @param {string} text
 */
async function notifyUser(telegramId, text) {
  if (!botRef) return;
  try {
    await botRef.telegram.sendMessage(telegramId, text);
  } catch (err) {
    console.error('[payments] notifyUser error:', err.message);
  }
}

/**
 * Extract ticketId from a reference like "TLOT-<ticketId>-<ts>".
 * @param {string} ref
 */
function ticketIdFromRef(ref) {
  const parts = String(ref).split('-');
  if (parts.length < 3) return null;
  const id = parseInt(parts[1], 10);
  return Number.isNaN(id) ? null : id;
}

/**
 * Core settlement — shared by both webhooks.
 * @param {{ref: string, method: string, paymentRef: string, meta: object}} info
 */
async function settlePayment(info) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `SELECT id, user_id, status, reference FROM transactions
       WHERE reference = $1 FOR UPDATE`,
      [info.ref]
    );
    if (txRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 404, msg: 'transaction not found' };
    }
    const tx = txRes.rows[0];
    if (tx.status === 'success') {
      // idempotent: already settled
      await client.query('ROLLBACK');
      return { ok: true, already: true };
    }

    await client.query(
      `UPDATE transactions SET status = 'success', meta = $2 WHERE id = $1`,
      [tx.id, JSON.stringify({ ...(info.meta || {}), settled_at: new Date().toISOString() })]
    );

    const ticketId = ticketIdFromRef(tx.reference);
    if (ticketId != null) {
      await client.query(
        `UPDATE tickets SET status = 'paid', payment_ref = $2
         WHERE id = $1 AND status = 'pending'`,
        [ticketId, info.paymentRef]
      );
    }

    await client.query('COMMIT');

    if (ticketId != null) {
      const u = await query(
        `SELECT u.telegram_id FROM users u
         JOIN tickets t ON t.user_id = u.id
         WHERE t.id = $1`,
        [ticketId]
      );
      if (u.rows.length > 0) {
        await notifyUser(
          u.rows[0].telegram_id,
          `✅ Payment received. Ticket #${ticketId} is active. Good luck! 🎉`
        );
      }
    }
    return { ok: true };
  } catch (err) {
    console.error('[payments] settlePayment error:', err);
    try { await client.query('ROLLBACK'); } catch {}
    return { ok: false, code: 500, msg: 'internal error' };
  } finally {
    client.release();
  }
}

// Telebirr callback
router.post('/telebirr/notify', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const body = req.body || {};
    let valid = false;
    try {
      valid = telebirr.verifyCallback(body);
    } catch (err) {
      console.error('[payments] telebirr verify error:', err.message);
      return res.status(400).json({ code: 'FAIL', msg: 'bad signature' });
    }
    if (!valid) {
      return res.status(400).json({ code: 'FAIL', msg: 'bad signature' });
    }

    if (body.tradeStatus && body.tradeStatus !== 'TRADE_SUCCESS') {
      return res.json({ code: 'SUCCESS', msg: 'ignored non-success' });
    }

    const ref = body.outTradeNo;
    if (!ref) return res.status(400).json({ code: 'FAIL', msg: 'missing outTradeNo' });

    const result = await settlePayment({
      ref,
      method: 'telebirr',
      paymentRef: body.tradeNo || body.transNo || '',
      meta: { raw: body, provider: 'telebirr' },
    });

    if (!result.ok && result.code) {
      return res.status(result.code).json({ code: 'FAIL', msg: result.msg });
    }
    return res.json({ code: 'SUCCESS', msg: 'ok' });
  } catch (err) {
    console.error('[payments] telebirr notify error:', err);
    return res.status(500).json({ code: 'FAIL', msg: 'internal error' });
  }
});

// CBE Birr callback
router.post('/cbe/notify', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    let valid = false;
    try {
      valid = cbe.verifyCallback(body);
    } catch (err) {
      console.error('[payments] cbe verify error:', err.message);
      return res.status(400).json({ error: 'bad signature' });
    }
    if (!valid) {
      return res.status(400).json({ error: 'bad signature' });
    }

    if (body.status && body.status !== 'SUCCESS') {
      return res.json({ status: 'ok', msg: 'ignored non-success' });
    }

    const ref = body.orderRef;
    if (!ref) return res.status(400).json({ error: 'missing orderRef' });

    const result = await settlePayment({
      ref,
      method: 'cbe',
      paymentRef: body.transactionId || '',
      meta: { raw: body, provider: 'cbe' },
    });

    if (!result.ok && result.code) {
      return res.status(result.code).json({ error: result.msg });
    }
    return res.json({ status: 'ok', msg: 'ok' });
  } catch (err) {
    console.error('[payments] cbe notify error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

module.exports = { router, setBot };
