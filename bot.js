/**
 * Telegram bot handlers (Telegraf).
 * SuperEnalotto-style 6/90 lottery with Quick Pick, Telebirr & CBE Birr payments.
 */
const { Telegraf, Markup } = require('telegraf');
const { query } = require('./db');
const telebirr = require('./telebirr');
const cbe = require('./cbe');

const TICKET_PRICE = parseFloat(process.env.TICKET_PRICE || '10');

/** In-memory selection state keyed by telegram_id. Cleared on Confirm/Cancel. */
const selections = new Map(); // telegram_id -> Set<number>

const RULES_TEXT =
  '🇪🇹 *Ethio Lottery — Rules*\n\n' +
  '• Pick 6 numbers from 1–90\n' +
  '• Draws run twice a week: Wednesday & Saturday\n' +
  '• Ticket price: ' + TICKET_PRICE + ' ETB\n\n' +
  '*Prize tiers:*\n' +
  '✅ Match 3 — 50 ETB\n' +
  '✅ Match 4 — 500 ETB\n' +
  '✅ Match 5 — 50,000 ETB\n' +
  '🏆 Match 6 — JACKPOT (rolls over if no winner)\n\n' +
  'Good luck! 🍀';

/**
 * @param {string} token
 */
function createBot(token) {
  const bot = new Telegraf(token);
  bot.context.db = { query };

  bot.catch((err) => console.error('[bot] Telegraf error:', err));

  bot.start(async (ctx) => {
    try {
      const tgId = ctx.from.id;
      const username = ctx.from.username || null;
      const firstName = ctx.from.first_name || null;
      await query(
        `INSERT INTO users (telegram_id, username, first_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id)
         DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name`,
        [tgId, username, firstName]
      );
      await ctx.reply(
        `🇪🇹 *Welcome to Ethio Lottery!* 🎰\n\nPick 6 numbers from 1–90 and win the jackpot. Draws every Wednesday & Saturday.`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
    } catch (err) {
      console.error('[bot] /start error:', err);
      await ctx.reply('⚠️ Something went wrong starting the bot. Please try again.');
    }
  });

  bot.command('menu', async (ctx) => {
    try {
      await ctx.reply('🇪🇹 *Ethio Lottery* — Main menu', {
        parse_mode: 'Markdown',
        ...mainMenu(),
      });
    } catch (err) {
      console.error('[bot] /menu error:', err);
    }
  });

  bot.action('home', async (ctx) => {
    try {
      await ctx.editMessageText('🇪🇹 *Ethio Lottery* — Main menu', {
        parse_mode: 'Markdown',
        ...mainMenu(),
      });
    } catch (err) {
      // edit may fail if message is old; fall back to reply
      try {
        await ctx.reply('🇪🇹 *Ethio Lottery* — Main menu', {
          parse_mode: 'Markdown',
          ...mainMenu(),
        });
      } catch (e2) {
        console.error('[bot] home fallback error:', e2);
      }
    }
  });

  bot.action('buy', async (ctx) => {
    try {
      const tgId = ctx.from.id;
      selections.set(tgId, new Set());
      await ctx.editMessageText(
        `🎲 *Pick 6 numbers* from 1–90.\n\nSelected: _none_\n\nTap numbers to toggle. Max 6.`,
        { parse_mode: 'Markdown', ...numberKeyboard(tgId) }
      );
    } catch (err) {
      console.error('[bot] buy error:', err);
    }
  });

  bot.action(/^num:(\d+)$/, async (ctx) => {
    try {
      const tgId = ctx.from.id;
      const n = parseInt(ctx.match[1], 10);
      let sel = selections.get(tgId);
      if (!sel) {
        sel = new Set();
        selections.set(tgId, sel);
      }
      if (sel.has(n)) {
        sel.delete(n);
      } else {
        if (sel.size >= 6) {
          await ctx.answerCbQuery('You can pick at most 6 numbers.');
          return;
        }
        sel.add(n);
      }
      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup(numberKeyboard(tgId).reply_markup);
    } catch (err) {
      console.error('[bot] num toggle error:', err);
    }
  });

  bot.action('quickpick', async (ctx) => {
    try {
      const tgId = ctx.from.id;
      const sel = new Set();
      while (sel.size < 6) {
        sel.add(Math.floor(Math.random() * 90) + 1);
      }
      selections.set(tgId, sel);
      await ctx.answerCbQuery('Quick pick: 6 random numbers');
      await ctx.editMessageText(
        `🎲 *Quick Pick* selected:\n\n${formatSelection(sel)}\n\nTap ✔️ Confirm to buy a ticket.`,
        { parse_mode: 'Markdown', ...numberKeyboard(tgId) }
      );
    } catch (err) {
      console.error('[bot] quickpick error:', err);
    }
  });

  bot.action('confirm', async (ctx) => {
    try {
      const tgId = ctx.from.id;
      const sel = selections.get(tgId);
      if (!sel || sel.size !== 6) {
        await ctx.answerCbQuery('Please select exactly 6 numbers.', { show_alert: true });
        return;
      }
      const numbers = Array.from(sel).sort((a, b) => a - b);

      const drawRes = await query(
        `SELECT id FROM draws WHERE status = 'open' ORDER BY id DESC LIMIT 1`
      );
      if (drawRes.rows.length === 0) {
        await ctx.answerCbQuery('No open draw. Try again later.', { show_alert: true });
        return;
      }
      const drawId = drawRes.rows[0].id;

      const userRes = await query(`SELECT id FROM users WHERE telegram_id = $1`, [tgId]);
      if (userRes.rows.length === 0) {
        await ctx.answerCbQuery('Please send /start first.', { show_alert: true });
        return;
      }
      const userId = userRes.rows[0].id;

      const ins = await query(
        `INSERT INTO tickets (user_id, numbers, draw_id, status, amount)
         VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
        [userId, numbers, drawId, TICKET_PRICE]
      );
      const ticketId = ins.rows[0].id;

      await ctx.editMessageText(
        `✅ Ticket #${ticketId} created.\nNumbers: ${numbers.join('-')}\nPrice: ${TICKET_PRICE} ETB\n\nChoose a payment method:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📱 Telebirr', `pay:telebirr:${ticketId}`),
            Markup.button.callback('🏦 CBE Birr', `pay:cbe:${ticketId}`),
          ],
          [Markup.button.callback('❌ Cancel', `cancel:${ticketId}`)],
        ])
      );
    } catch (err) {
      console.error('[bot] confirm error:', err);
      try {
        await ctx.answerCbQuery('Error creating ticket. Try again.', { show_alert: true });
      } catch {}
    }
  });

  bot.action(/^pay:(telebirr|cbe):(\d+)$/, async (ctx) => {
    try {
      const method = ctx.match[1];
      const ticketId = parseInt(ctx.match[2], 10);
      const tgId = ctx.from.id;

      const userRes = await query(`SELECT id FROM users WHERE telegram_id = $1`, [tgId]);
      if (userRes.rows.length === 0) {
        await ctx.answerCbQuery('User not found. Send /start.', { show_alert: true });
        return;
      }
      const userId = userRes.rows[0].id;

      const ticketRes = await query(
        `SELECT * FROM tickets WHERE id = $1 AND user_id = $2`,
        [ticketId, userId]
      );
      if (ticketRes.rows.length === 0) {
        await ctx.answerCbQuery('Ticket not found.', { show_alert: true });
        return;
      }
      const ticket = ticketRes.rows[0];
      if (ticket.status === 'paid') {
        await ctx.answerCbQuery('This ticket is already paid.', { show_alert: true });
        return;
      }

      const outTradeNo = `TLOT-${ticketId}-${Date.now()}`;
      const subject = `Lottery Ticket #${ticketId}`;

      await query(
        `UPDATE tickets SET payment_method = $1 WHERE id = $2`,
        [method, ticketId]
      );
      await query(
        `INSERT INTO transactions (user_id, type, amount, reference, status, meta)
         VALUES ($1, 'ticket_purchase', $2, $3, 'pending', $4)`,
        [userId, ticket.amount, outTradeNo, JSON.stringify({ ticket_id: ticketId, method })]
      );

      let payUrl;
      try {
        if (method === 'telebirr') {
          const res = await telebirr.createOrder({
            outTradeNo,
            totalAmount: String(ticket.amount),
            subject,
          });
          payUrl = res.payUrl;
        } else {
          const res = await cbe.createOrder({
            orderRef: outTradeNo,
            amount: String(ticket.amount),
            description: subject,
          });
          payUrl = res.payUrl;
        }
      } catch (err) {
        console.error(`[bot] ${method} createOrder error:`, err.message);
        await ctx.answerCbQuery(`Payment error: ${err.message}`, { show_alert: true });
        return;
      }

      selections.delete(tgId);
      await ctx.editMessageText(
        `💳 Tap below to pay ${ticket.amount} ETB via ${method === 'telebirr' ? 'Telebirr' : 'CBE Birr'}.\nRef: ${outTradeNo}`,
        Markup.inlineKeyboard([
          [Markup.button.url('💳 Pay Now', payUrl)],
          [Markup.button.callback('🏠 Home', 'home')],
        ])
      );
    } catch (err) {
      console.error('[bot] pay error:', err);
      try {
        await ctx.answerCbQuery('Payment initiation failed.', { show_alert: true });
      } catch {}
    }
  });

  bot.action(/^cancel:(\d+)$/, async (ctx) => {
    try {
      const ticketId = parseInt(ctx.match[1], 10);
      const tgId = ctx.from.id;
      selections.delete(tgId);
      await query(
        `UPDATE tickets SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`,
        [ticketId]
      );
      await ctx.editMessageText(
        `❌ Ticket #${ticketId} cancelled.`,
        Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'home')]])
      );
    } catch (err) {
      console.error('[bot] cancel error:', err);
    }
  });

  bot.action('tickets', async (ctx) => {
    try {
      const tgId = ctx.from.id;
      const userRes = await query(`SELECT id FROM users WHERE telegram_id = $1`, [tgId]);
      if (userRes.rows.length === 0) {
        await ctx.answerCbQuery('Send /start first.', { show_alert: true });
        return;
      }
      const userId = userRes.rows[0].id;
      const res = await query(
        `SELECT id, numbers, status, amount FROM tickets
         WHERE user_id = $1 ORDER BY id DESC LIMIT 10`,
        [userId]
      );
      if (res.rows.length === 0) {
        await ctx.editMessageText(
          '📜 *My Tickets*\n\nNo tickets yet. Tap Buy Ticket to play!',
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'home')]]) }
        );
        return;
      }
      const lines = res.rows
        .map((t) => {
          const nums = (t.numbers || []).join('-');
          const status = statusEmoji(t.status);
          return `#${t.id} | ${nums} | ${status} | ${t.amount} ETB`;
        })
        .join('\n');
      await ctx.editMessageText(`📜 *My Tickets*\n\n${lines}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'home')]]),
      });
    } catch (err) {
      console.error('[bot] tickets error:', err);
    }
  });

  bot.action('balance', async (ctx) => {
    try {
      const tgId = ctx.from.id;
      const res = await query(`SELECT balance FROM users WHERE telegram_id = $1`, [tgId]);
      if (res.rows.length === 0) {
        await ctx.answerCbQuery('Send /start first.', { show_alert: true });
        return;
      }
      const bal = res.rows[0].balance;
      await ctx.editMessageText(`💳 *My Balance*\n\n${bal} ETB`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'home')]]),
      });
    } catch (err) {
      console.error('[bot] balance error:', err);
    }
  });

  bot.action('rules', async (ctx) => {
    try {
      await ctx.editMessageText(RULES_TEXT, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'home')]]),
      });
    } catch (err) {
      console.error('[bot] rules error:', err);
    }
  });

  return bot;
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎰 Buy Ticket', 'buy')],
    [
      Markup.button.callback('📜 My Tickets', 'tickets'),
      Markup.button.callback('💳 My Balance', 'balance'),
    ],
    [Markup.button.callback('📖 Rules', 'rules')],
  ]);
}

/**
 * Build the 9x10 number grid + Quick Pick/Confirm/Cancel/Home.
 * @param {number} tgId
 */
function numberKeyboard(tgId) {
  const sel = selections.get(tgId) || new Set();
  const rows = [];
  for (let row = 0; row < 9; row++) {
    const buttons = [];
    for (let col = 1; col <= 10; col++) {
      const n = row * 10 + col;
      if (n > 90) break;
      const label = sel.has(n) ? `✅${n}` : `${n}`;
      buttons.push(Markup.button.callback(label, `num:${n}`));
    }
    rows.push(buttons);
  }
  rows.push([
    Markup.button.callback('🎲 Quick Pick', 'quickpick'),
    Markup.button.callback('✔️ Confirm', 'confirm'),
    Markup.button.callback('❌ Cancel', 'home'),
  ]);
  return Markup.inlineKeyboard(rows);
}

/** @param {Set<number>} sel */
function formatSelection(sel) {
  if (sel.size === 0) return '_none_';
  return Array.from(sel).sort((a, b) => a - b).join(', ');
}

/** @param {string} s */
function statusEmoji(s) {
  switch (s) {
    case 'paid': return '✅ PAID';
    case 'pending': return '⏳ PENDING';
    case 'cancelled': return '❌ CANCELLED';
    case 'won': return '🏆 WON';
    case 'lost': return '💸 LOST';
    default: return s ? s.toUpperCase() : 'UNKNOWN';
  }
}

module.exports = { createBot, selections, TICKET_PRICE };
