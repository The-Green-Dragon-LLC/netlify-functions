/**
 * BACK-IN-STOCK — SIGNUP FUNCTION
 * ────────────────────────────────────────────────────────────────────────────
 * Captures a customer's request to be notified when an out-of-stock product or
 * variant is back in stock. Called by the on-page widget (public/back-in-stock.js).
 *
 * Flow (POST JSON):
 *   { email, code, name, url, image, price, variantLabel, itemType, optIn }
 *   1. validate email + code
 *   2. de-dupe: skip if an identical Pending row already exists
 *   3. insert a row in Airtable "Back In Stock Requests" (Status = Pending)
 *   4. fire the Omnisend "back in stock signup" event  → confirmation automation
 *   5. if optIn: upsert the Omnisend contact as email-subscribed (marketing)
 *
 * The scheduled sibling `back-in-stock-notify.js` later reads the Pending rows,
 * checks Airtable inventory, and fires the "back in stock" alert event.
 *
 * Env (on the netlify-functions site):
 *   AIRTABLE_API_KEY (or AIRTABLE_TOKEN)  — needs data.records:read + write on the Website base
 *   OMNISEND_API_KEY                       — events.write (+ contacts write for the opt-in upsert)
 *
 * Best-effort on both Omnisend calls: a signup is never failed because Omnisend
 * hiccups — the Airtable row is the source of truth the notifier reads.
 */

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || 'appWUsGD3byrYcN3l';
const AIRTABLE_TABLE = process.env.AIRTABLE_BIS_TABLE || 'tblcPKQSoRpYu7VXW'; // "Back In Stock Requests"

const OMNISEND_BASE = 'https://api.omnisend.com/api';
const OMNISEND_VERSION = '2026-03-15';
const SIGNUP_EVENT_NAME = 'back in stock signup';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ─── HTTPS helper (same shape as manage-subscription.js) ─────────────────── */
function httpsReq(url, opts, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: (opts && opts.method) || 'GET',
      headers: (opts && opts.headers) || {},
    };
    const bodyStr = bodyObj !== undefined
      ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj))
      : undefined;
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, json });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function resp(statusCode, obj) {
  return { statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

/* ─── Airtable ────────────────────────────────────────────────────────────── */
function airtableToken() {
  return process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN || '';
}

/* Escape a value for safe interpolation inside an Airtable formula string. */
function esc(v) {
  return String(v == null ? '' : v).replace(/"/g, '\\"');
}

/* Is there already a Pending request for this email+code? (idempotent signups) */
async function hasPendingRequest(token, email, code) {
  const formula = `AND(LOWER({Email})="${esc(email)}",{Product Code}="${esc(code)}",{Status}="Pending")`;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`
    + `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const res = await httpsReq(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok || !res.json) throw new Error(`Airtable lookup ${res.status}: ${(res.text || '').slice(0, 200)}`);
  return (res.json.records || []).length > 0;
}

async function createRequest(token, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
  const res = await httpsReq(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, { fields, typecast: true });
  if (!res.ok) throw new Error(`Airtable create ${res.status}: ${(res.text || '').slice(0, 300)}`);
  return res.json;
}

/* ─── Omnisend (best-effort) ─────────────────────────────────────────────── */
async function fireSignupEvent(email, properties) {
  const apiKey = process.env.OMNISEND_API_KEY;
  if (!apiKey) { console.warn('[bis] OMNISEND_API_KEY not set — skipping signup event'); return; }
  try {
    const res = await httpsReq(OMNISEND_BASE + '/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Omnisend-API-Key ' + apiKey,
        'Omnisend-Version': OMNISEND_VERSION,
      },
    }, {
      eventName: SIGNUP_EVENT_NAME,
      origin: 'api',
      eventTime: new Date().toISOString(),
      contact: { email },
      properties: properties || {},
    });
    if (!res.ok) console.error('[bis] Omnisend signup event failed', res.status, (res.text || '').slice(0, 300));
  } catch (e) {
    console.error('[bis] Omnisend signup event error:', e.message);
  }
}

/* Only called when the customer ticked the marketing opt-in box. */
async function subscribeContact(email, ip) {
  const apiKey = process.env.OMNISEND_API_KEY;
  if (!apiKey) { console.warn('[bis] OMNISEND_API_KEY not set — skipping contact upsert'); return; }
  try {
    const now = new Date().toISOString();
    const res = await httpsReq(OMNISEND_BASE + '/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Omnisend-API-Key ' + apiKey,
        'Omnisend-Version': OMNISEND_VERSION,
      },
    }, {
      identifiers: [{
        type: 'email',
        id: email,
        channels: { email: { status: 'subscribed', statusChangedAt: now } },
        consent: { source: 'Back in Stock Form', createdAt: now, ip: ip || undefined },
      }],
      tags: ['source: back-in-stock'],
    });
    if (!res.ok) console.error('[bis] Omnisend contact upsert failed', res.status, (res.text || '').slice(0, 300));
  } catch (e) {
    console.error('[bis] Omnisend contact upsert error:', e.message);
  }
}

/* ─── Handler ─────────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return resp(400, { ok: false, error: 'Invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  if (!EMAIL_RE.test(email)) return resp(400, { ok: false, error: 'A valid email is required.' });
  if (!code) return resp(400, { ok: false, error: 'Missing product code.' });

  const productName = String(body.name || '').trim();
  const variantLabel = String(body.variantLabel || '').trim();
  const productUrl = String(body.url || '').trim();
  const imageUrl = String(body.image || '').trim();
  const priceNum = Number(body.price);
  const itemType = body.itemType === 'Product' ? 'Product' : 'Variant';
  const optIn = body.optIn === true || body.optIn === 'true';

  const token = airtableToken();
  if (!token) return resp(500, { ok: false, error: 'Server not configured.' });

  // De-dupe — a repeat signup for the same item is a no-op success.
  try {
    if (await hasPendingRequest(token, email, code)) {
      // Still (re)fire the signup event so the customer gets a confirmation and
      // any opt-in is honored, but don't create a duplicate row.
      await fireSignupEvent(email, {
        productCode: code, productName, variantLabel, productUrl, imageUrl,
        price: Number.isFinite(priceNum) ? priceNum : undefined,
      });
      if (optIn) await subscribeContact(email, clientIp(event));
      return resp(200, { ok: true, already: true });
    }
  } catch (e) {
    console.error('[bis] dedupe lookup failed:', e.message);
    return resp(502, { ok: false, error: 'Could not reach the notification service. Please try again.' });
  }

  // Record the request.
  try {
    await createRequest(token, {
      Email: email,
      'Product Code': code,
      'Item Type': itemType,
      'Product Name': productName || undefined,
      'Variant Label': variantLabel || undefined,
      'Product URL': productUrl || undefined,
      'Image URL': imageUrl || undefined,
      Price: Number.isFinite(priceNum) ? priceNum : undefined,
      'Opt-in Marketing': optIn,
      Status: 'Pending',
      'Requested At': new Date().toISOString(),
    });
  } catch (e) {
    console.error('[bis] Airtable create failed:', e.message);
    return resp(502, { ok: false, error: 'Could not save your request. Please try again.' });
  }

  // Fire-and-forget Omnisend touches — never fail the signup on these.
  await fireSignupEvent(email, {
    productCode: code, productName, variantLabel, productUrl, imageUrl,
    price: Number.isFinite(priceNum) ? priceNum : undefined,
  });
  if (optIn) await subscribeContact(email, clientIp(event));

  return resp(200, { ok: true });
};

function clientIp(event) {
  const h = (event && event.headers) || {};
  return (h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || '').trim();
}
