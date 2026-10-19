/**
 * Telebirr merchant API client.
 * Signs createOrder payloads with RSA-SHA256 and verifies callbacks with the
 * Telebirr public key. All keys are read from env — no stubs.
 */
const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = process.env.TELEBIRR_BASE_URL || 'https://api.telebirr.com';
const APP_ID = process.env.TELEBIRR_APP_ID;
const APP_KEY = process.env.TELEBIRR_APP_KEY;
const SHORT_CODE = process.env.TELEBIRR_SHORT_CODE;
const PUBLIC_KEY = process.env.TELEBIRR_PUBLIC_KEY;
const PRIVATE_KEY = process.env.TELEBIRR_PRIVATE_KEY;
const NOTIFY_URL = process.env.TELEBIRR_NOTIFY_URL;
const RETURN_URL = process.env.TELEBIRR_RETURN_URL;

function requireEnv(name, val) {
  if (!val) {
    throw new Error(
      `[telebirr] Missing env ${name}. Set it in .env before creating orders.`
    );
  }
  return val;
}

/**
 * Normalize a PEM key. Accepts either a single-line base64 body or a full
 * PEM block, and returns a valid PEM string for crypto.
 * @param {string} key
 * @param {string} kind
 */
function normalizePem(key, kind) {
  if (!key) return '';
  if (key.includes('-----BEGIN')) return key;
  const header = `-----BEGIN ${kind}-----`;
  const footer = `-----END ${kind}-----`;
  const wrapped = key.replace(/\\n/g, '\n').match(/.{1,64}/g).join('\n');
  return `${header}\n${wrapped}\n${footer}`;
}

/**
 * Sign a payload object with RSA-SHA256 using the merchant private key.
 * Returns base64 signature.
 * @param {Record<string, string>} payload
 */
function rsaSign(payload) {
  const priv = normalizePem(requireEnv('TELEBIRR_PRIVATE_KEY', PRIVATE_KEY), 'RSA PRIVATE KEY');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(JSON.stringify(payload));
  sign.end();
  return sign.sign(priv, 'base64');
}

/**
 * Verify a callback signature with the Telebirr RSA public key.
 * @param {Record<string, string>} body sorted-then-joined as k=v&k=v excluding sign
 * @param {string} signature base64
 */
function verifyCallback(body) {
  const pub = normalizePem(requireEnv('TELEBIRR_PUBLIC_KEY', PUBLIC_KEY), 'PUBLIC KEY');
  const keys = Object.keys(body)
    .filter((k) => k !== 'sign')
    .sort();
  const data = keys.map((k) => `${k}=${body[k]}`).join('&');
  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(data);
  verify.end();
  const sig = Buffer.from(body.sign, 'base64');
  return verify.verify(pub, sig);
}

/**
 * Create a Telebirr order. Returns { payUrl, raw }.
 * @param {{outTradeNo: string, totalAmount: string|number, subject: string}} opts
 */
async function createOrder({ outTradeNo, totalAmount, subject }) {
  requireEnv('TELEBIRR_APP_ID', APP_ID);
  requireEnv('TELEBIRR_APP_KEY', APP_KEY);
  requireEnv('TELEBIRR_SHORT_CODE', SHORT_CODE);
  requireEnv('TELEBIRR_NOTIFY_URL', NOTIFY_URL);
  requireEnv('TELEBIRR_RETURN_URL', RETURN_URL);

  const payload = {
    appId: APP_ID,
    shortCode: SHORT_CODE,
    outTradeNo,
    totalAmount: String(totalAmount),
    subject,
    returnUrl: RETURN_URL,
    notifyUrl: NOTIFY_URL,
    timeoutExpress: '30m',
    businessType: '10001',
  };

  const signature = rsaSign(payload);
  const body = { ...payload, sign: signature };

  try {
    const res = await axios.post(`${BASE_URL}/api/v1/merchant/order/create`, body, {
      headers: { 'X-APP-Key': APP_KEY, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const data = res.data || {};
    if (String(data.code) !== '0') {
      throw new Error(`[telebirr] createOrder failed: ${JSON.stringify(data)}`);
    }
    const payUrl = data.data && data.data.toPayUrl;
    if (!payUrl) {
      throw new Error(`[telebirr] createOrder: no payUrl in response: ${JSON.stringify(data)}`);
    }
    return { payUrl, raw: data };
  } catch (err) {
    if (err.response) {
      throw new Error(`[telebirr] createOrder HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

module.exports = { createOrder, verifyCallback };
