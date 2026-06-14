/**
 * restart-subscription.js  —  Netlify Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Clears a FoxyCart subscription's end_date (un-cancels it) and optionally
 * sets next_transaction_date to tomorrow.
 *
 * STRATEGY
 * ─────────
 *  - Cart cancel page (/cart?sub_token=...): receives sub_token + timestamp;
 *    calls FoxyCart cart API with those values + sub_enddate=0000-00-00.
 *    The HMAC-validated sub_token authorises the modification.
 *
 *  - Checkout cancel page (/checkout.php?fcsid=...): no sub_token in URL;
 *    receives customer_id (foxy_customer_id DOM field, populated after sign-in);
 *    uses FoxyCart REST API via OAuth to find and PATCH the subscription.
 *
 * DEPLOYMENT
 * ──────────
 *  Env vars required:
 *    FOXY_CLIENT_ID      — FoxyCart Admin → Integrations → Get Token
 *    FOXY_CLIENT_SECRET  — same
 *    FOXY_REFRESH_TOKEN  — same
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* ─── HTTPS HELPER ──────────────────────────────────────────────────────────── */

function httpsReq(url, opts, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
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
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, json, location: res.headers && res.headers.location });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/* ─── FOXY OAUTH ────────────────────────────────────────────────────────────── */

async function getAccessToken() {
  const credentials = Buffer.from(
    `${process.env.FOXY_CLIENT_ID || ''}:${process.env.FOXY_CLIENT_SECRET || ''}`
  ).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.FOXY_REFRESH_TOKEN || '',
  });

  const res = await httpsReq(
    'https://api.foxycart.com/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` } },
    params.toString()
  );

  if (!res.ok || !res.json || !res.json.access_token) {
    throw new Error('FoxyCart token error: ' + res.text);
  }
  return res.json.access_token;
}

/* ─── PATH A: sub_token (cart cancel page) ──────────────────────────────────── */

async function restartViaSubToken({ sub_token, timestamp, sub_nextdate, store_domain }) {
  const params = new URLSearchParams({ sub_token, sub_enddate: '0000-00-00', sub_nextdate });
  if (timestamp) params.set('timestamp', timestamp);
  const url = `https://${store_domain}/cart?${params.toString()}`;

  console.log('[restart-subscription] PATH A (sub_token) cart URL:', url);
  const res = await httpsReq(url, {});
  console.log('[restart-subscription] PATH A response status:', res.status, 'location:', res.location || '(none)');

  // FoxyCart redirects on success (302/301); it returns 200 for no-session calls
  if (res.status >= 200 && res.status < 400) {
    return { success: true };
  }
  throw new Error(`Cart API returned ${res.status}: ${res.text.slice(0, 200)}`);
}

/* ─── PATH B: customer_id + OAuth (checkout cancel page) ────────────────────── */

async function restartViaCustomerId({ customer_id, sub_nextdate }) {
  const token = await getAccessToken();
  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'FOXY-API-VERSION': '1',
    'Content-Type': 'application/json',
  };

  // List all subscriptions for this customer
  const subsRes = await httpsReq(
    `https://api.foxycart.com/subscriptions?customer_id=${encodeURIComponent(customer_id)}&limit=50`,
    { headers: authHeaders }
  );
  if (!subsRes.ok) throw new Error(`Subscriptions API ${subsRes.status}: ${subsRes.text.slice(0, 200)}`);

  const subs = (subsRes.json && subsRes.json._embedded && subsRes.json._embedded['fx:subscriptions']) || [];
  console.log('[restart-subscription] PATH B customer', customer_id, ': found', subs.length, 'subscription(s)');

  // Find the one with a pending end_date (not empty, not 0000-00-00)
  const target = subs.find(s => s.end_date && s.end_date !== '' && !s.end_date.startsWith('0000'));
  if (!target) {
    throw new Error('No pending-cancel subscription found for this customer (end_date already clear or no subscriptions)');
  }

  const subUrl = target._links && target._links.self && target._links.self.href;
  if (!subUrl) throw new Error('Subscription self-link missing from API response');

  console.log('[restart-subscription] PATH B patching:', subUrl, '-> clear end_date, next_transaction_date:', sub_nextdate);

  const patchRes = await httpsReq(
    subUrl,
    { method: 'PATCH', headers: authHeaders },
    { end_date: '', next_transaction_date: sub_nextdate + 'T00:00:00+00:00' }
  );

  if (!patchRes.ok) throw new Error(`PATCH ${subUrl} failed (${patchRes.status}): ${patchRes.text.slice(0, 200)}`);

  return { success: true };
}

/* ─── HANDLER ───────────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let sub_token, timestamp, customer_id, sub_nextdate, store_domain;
  try {
    ({ sub_token, timestamp, customer_id, sub_nextdate, store_domain } = JSON.parse(event.body || '{}'));
  } catch (_) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!sub_nextdate) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing sub_nextdate' }) };
  }

  try {
    let result;

    if (sub_token && store_domain) {
      // Path A: cart cancel page — sub_token is in the URL
      result = await restartViaSubToken({ sub_token, timestamp, sub_nextdate, store_domain });
    } else if (customer_id) {
      // Path B: checkout cancel page — customer signed in, use OAuth
      result = await restartViaCustomerId({ customer_id, sub_nextdate });
    } else {
      return {
        statusCode: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Provide sub_token + store_domain (cart page) or customer_id (checkout page)' }),
      };
    }

    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };

  } catch (err) {
    console.error('[restart-subscription] ERROR:', err.message);
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
