/**
 * CBE Birr merchant API client.
 * Signs payloads with HMAC-SHA256 using CBE_API_KEY. No stubs.
 */
const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = process.env.CBE_BASE_URL || 'https://api.cbe.com.et/cbebirrmerchant';
const MERCHANT_ID = process.env.CBE_MERCHANT_ID;
const API_KEY = process.env.CBE_API_KEY;
const NOTIFY_URL = process.env.CBE_NOTIFY_URL;

function requireEnv(name, val) {
  if (!val) {
    throw new Error(
      `[cbe] Missing env ${name}. Set it in .env before creating orders.`
    );
  }
  return val;
}

/**
 * Build the canonical signing string: keys sorted alphabetically, joined as k=v&k=v.
 * @param {Record<string, string>} payload
 */
function canonicalString(payload) {
  return Object.keys(payload)
    .sort()
    .map((k) => `${k}=${payload[k]}`)
    .join('&');
}

/** HMAC-SHA256 hex signature. */
function hmacSign(payload) {
  const key = requireEnv('CBE_API_KEY', API_KEY);
  return crypto
    .createHmac('sha256', key)
    .update(canonicalString(payload))
    .digest('hex');
}

/**
 * Verify a callback: same HMAC over the body's fields, compared against body.signature.
 * @param {Record<string, string>} body
 */
function verifyCallback(body) {
  requireEnv('CBE_API_KEY', API_KEY);
  if (!body.signature) return false;
  const expected = crypto
    .createHmac('sha256', API_KEY)
    .update(canonicalString({ ...body, signature: undefined }))
    .digest('hex');
  // Constant-time compare
  return (
    expected.length === body.signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(body.signature))
  );
}

/**
 * Create a CBE Birr payment request. Returns { payUrl, raw }.
 * @param {{orderRef: string, amount: string|number, description: string}} opts
 */
async function createOrder({ orderRef, amount, description }) {
  requireEnv('CBE_MERCHANT_ID', MERCHANT_ID);
  requireEnv('CBE_API_KEY', API_KEY);
  requireEnv('CBE_NOTIFY_URL', NOTIFY_URL);

  const payload = {
    merchantId: MERCHANT_ID,
    orderRef,
    amount: String(amount),
    currency: 'ETB',
    description,
    notifyUrl: NOTIFY_URL,
    timestamp: Date.now().toString(),
  };
  const signature = hmacSign(payload);
  const body = { ...payload, signature };

  try {
    const res = await axios.post(`${BASE_URL}/api/v1/payment/request`, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const data = res.data || {};
    if (String(data.status || data.code || '0') !== '0' && data.payUrl == null) {
      throw new Error(`[cbe] createOrder failed: ${JSON.stringify(data)}`);
    }
    const payUrl = data.payUrl || (data.data && data.data.payUrl);
    if (!payUrl) {
      throw new Error(`[cbe] createOrder: no payUrl in response: ${JSON.stringify(data)}`);
    }
    return { payUrl, raw: data };
  } catch (err) {
    if (err.response) {
      throw new Error(`[cbe] createOrder HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

module.exports = { createOrder, verifyCallback };
