-- Ethiopian Telegram Lottery — schema
-- Apply manually for local PostgreSQL: psql "$DATABASE_URL" -f schema.sql
-- In Bolt, this schema is applied automatically via the Supabase migration tool.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username VARCHAR(100),
  first_name VARCHAR(100),
  balance DECIMAL(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS draws (
  id SERIAL PRIMARY KEY,
  winning_numbers INTEGER[],
  jolly_number INTEGER,
  status VARCHAR(20) DEFAULT 'open',
  jackpot_amount DECIMAL(14,2) DEFAULT 50000000,
  draw_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  numbers INTEGER[] NOT NULL,
  draw_id INTEGER REFERENCES draws(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending',
  amount DECIMAL(10,2),
  payment_method VARCHAR(20),
  payment_ref VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20),
  amount DECIMAL(12,2),
  reference VARCHAR(120),
  status VARCHAR(20) DEFAULT 'pending',
  meta JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_draw_id ON tickets(draw_id);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);

-- Seed one open draw if none exists
INSERT INTO draws (status)
SELECT 'open'
WHERE NOT EXISTS (SELECT 1 FROM draws WHERE status = 'open');
