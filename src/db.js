/**
 * PostgreSQL connection pool.
 * Reads DATABASE_URL from env (falls back to SUPABASE_DB_URL for Bolt-hosted runs).
 */
const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!connectionString) {
  console.error('[db] FATAL: DATABASE_URL (or SUPABASE_DB_URL) is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected idle client error', err);
});

/** Run a parameterized query. Returns rows. */
async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

/** Get a client for multi-statement transactions. */
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, getClient };
