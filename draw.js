/**
 * Draw engine. Generates winning numbers + jolly, settles all paid tickets,
 * credits prize winners, rolls over jackpot if no 6-match, and opens a new draw.
 *
 * Settlement is wrapped in a database transaction with FOR UPDATE locking on the
 * draw row to prevent concurrent draws from double-settling.
 */
const { getClient, query } = require('./db');

const PRIZES = { 3: 50, 4: 500, 5: 50000 };

/** Bot reference for notifications, set by index.js. */
let botRef = null;
function setBot(b) { botRef = b; }

/**
 * Generate 6 unique random ints in [1,90], sorted ascending.
 * @returns {number[]}
 */
function generateWinning() {
  const set = new Set();
  while (set.size < 6) {
    set.add(Math.floor(Math.random() * 90) + 1);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * Send a Telegram message to a user by DB id.
 * @param {number} userId
 * @param {string} text
 */
async function notifyUserById(userId, text) {
  if (!botRef) return;
  try {
    const u = await query(`SELECT telegram_id FROM users WHERE id = $1`, [userId]);
    if (u.rows.length > 0) {
      await botRef.telegram.sendMessage(u.rows[0].telegram_id, text);
    }
  } catch (err) {
    console.error('[draw] notify error:', err.message);
  }
}

/**
 * Run the next open draw: pick winning numbers, settle tickets, roll/open draw.
 * Concurrency-safe via transaction + FOR UPDATE.
 */
async function runDraw() {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const drawRes = await client.query(
      `SELECT * FROM draws WHERE status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE`
    );
    if (drawRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('No open draw to run.');
    }
    const draw = drawRes.rows[0];

    const winning = generateWinning();
    const jolly = Math.floor(Math.random() * 90) + 1;

    await client.query(
      `UPDATE draws SET winning_numbers = $1, jolly_number = $2, status = 'drawn', draw_date = NOW()
       WHERE id = $3`,
      [winning, jolly, draw.id]
    );

    const ticketsRes = await client.query(
      `SELECT t.id, t.user_id, t.numbers FROM tickets t
       WHERE t.draw_id = $1 AND t.status = 'paid'`,
      [draw.id]
    );

    const winningSet = new Set(winning);
    const jackpotWinners = [];

    for (const t of ticketsRes.rows) {
      const matches = (t.numbers || []).filter((n) => winningSet.has(n)).length;
      if (matches === 6) {
        jackpotWinners.push(t);
      } else if (PRIZES[matches]) {
        const prize = PRIZES[matches];
        await client.query(
          `UPDATE users SET balance = balance + $2 WHERE id = $1`,
          [t.user_id, prize]
        );
        await client.query(
          `UPDATE tickets SET status = 'won' WHERE id = $1`,
          [t.id]
        );
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, reference, status, meta)
           VALUES ($1, 'prize', $2, $3, 'success', $4)`,
          [t.user_id, prize, `PRIZE-${t.id}-${Date.now()}`, JSON.stringify({ ticket_id: t.id, matches })]
        );
        // notify outside the transaction would risk orphan; queue ids and notify after commit
      } else {
        await client.query(`UPDATE tickets SET status = 'lost' WHERE id = $1`, [t.id]);
      }
    }

    let perWinner = 0;
    if (jackpotWinners.length > 0) {
      perWinner = Math.floor(Number(draw.jackpot_amount) / jackpotWinners.length);
      for (const t of jackpotWinners) {
        await client.query(
          `UPDATE users SET balance = balance + $2 WHERE id = $1`,
          [t.user_id, perWinner]
        );
        await client.query(`UPDATE tickets SET status = 'won' WHERE id = $1`, [t.id]);
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, reference, status, meta)
           VALUES ($1, 'jackpot', $2, $3, 'success', $4)`,
          [t.user_id, perWinner, `JACKPOT-${t.id}-${Date.now()}`, JSON.stringify({ ticket_id: t.id, matches: 6 })]
        );
      }
      await client.query(`UPDATE draws SET status = 'settled' WHERE id = $1`, [draw.id]);
    } else {
      // Rollover: jackpot grows by 20%
      const newJackpot = Math.floor(Number(draw.jackpot_amount) * 1.2);
      await client.query(
        `UPDATE draws SET status = 'settled', jackpot_amount = $2 WHERE id = $1`,
        [draw.id, newJackpot]
      );
    }

    // Open a new draw, carrying forward the (possibly rolled-over) jackpot
    const rolledJackpotRes = await client.query(
      `SELECT jackpot_amount FROM draws WHERE id = $1`,
      [draw.id]
    );
    const nextJackpot = jackpotWinners.length > 0
      ? 50000000 // reset to base after a jackpot win
      : Number(rolledJackpotRes.rows[0].jackpot_amount);
    const newDrawRes = await client.query(
      `INSERT INTO draws (status, jackpot_amount) VALUES ('open', $1) RETURNING id`,
      [nextJackpot]
    );

    await client.query('COMMIT');

    // Notifications (after commit so we never notify on a rolled-back settlement)
    const allWinners = ticketsRes.rows.filter((t) => {
      const matches = (t.numbers || []).filter((n) => winningSet.has(n)).length;
      return matches >= 3;
    });
    for (const t of allWinners) {
      const matches = (t.numbers || []).filter((n) => winningSet.has(n)).length;
      if (matches === 6) {
        await notifyUserById(
          t.user_id,
          `🏆 JACKPOT! You matched all 6 numbers (${winning.join('-')}). You won ${perWinner.toLocaleString()} ETB! 🎉`
        );
      } else {
        const prize = PRIZES[matches];
        await notifyUserById(
          t.user_id,
          `🎉 You matched ${matches} numbers in draw #${draw.id}. Prize: ${prize} ETB credited to your balance.`
        );
      }
    }
    // Notify losers who had a paid ticket
    for (const t of ticketsRes.rows) {
      const matches = (t.numbers || []).filter((n) => winningSet.has(n)).length;
      if (matches < 3) {
        await notifyUserById(
          t.user_id,
          `🎲 Draw #${draw.id} results: ${winning.join('-')} (jolly ${jolly}). Your ticket #${t.id} matched ${matches}. No prize this time. Good luck next draw!`
        );
      }
    }

    return {
      drawId: draw.id,
      winning,
      jolly,
      jackpotWinners: jackpotWinners.length,
      perWinner,
      newDrawId: newDrawRes.rows[0].id,
      nextJackpot,
    };
  } catch (err) {
    console.error('[draw] runDraw error:', err);
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runDraw, setBot, generateWinning };
