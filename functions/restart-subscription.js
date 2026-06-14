/**
 * restart-subscription.js  —  Netlify Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Clears a FoxyCart subscription's end_date (un-cancels it) and sets
 * next_transaction_date to tomorrow.
 *
 * TWO PATHS
 * ─────────
 *  PATH A — cart cancel page (/cart?sub_token=...)
 *    Receives sub_token + timestamp + store_domain.
 *    Calls FoxyCart cart API: the HMAC-validated sub_token authorises
 *    the modification directly; clears sub_enddate and sets sub_nextdate.
 *
 *  PATH B — checkout cancel page (/checkout.php?fcsid=...)
 *    Receives store_id + sub_enddate (both from FC.json, available before
 *    any sign-in).  Uses FoxyCart REST API via OAuth:
 *      1. Gets access token via refresh_token grant
 *      2. Queries /subscriptions for this store
 *      3. Finds the one whose end_date matches sub_enddate
 *      4. PATCHes end_date to '' and next_transaction_date to tomorrow
 *
 * ENV VARS (Netlify → Site Settings → Environment Variables)
 * ───────────────────────────────────────────────────────────
 *   FOXY_CLIENT_ID      — FoxyCart Admin → Integrations → Get Token
 *   FOXY_CLIENT_SECRET  — same
 *   FOXY_REFRESH_TOKEN  — same
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
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
    },
    params.toString()
  );

  if (!res.ok || !res.json || !res.json.access_token) {
    throw new Error('FoxyCart token error: ' + res.text.slice(0, 300));
  }
  return res.json.access_token;
}

/* ─── PATH A: sub_token (cart cancel page) ──────────────────────────────────── */

async function restartViaSubToken({ sub_token, timestamp, sub_nextdate, store_domain }) {
  const params = new URLSearchParams({ sub_token, sub_enddate: '0000-00-00', sub_nextdate });
  if (timestamp) params.set('timestamp', timestamp);
  const url = `https://${store_domain}/cart?${params.toString()}`;

  console.log('[restart] PATH A cart URL:', url);
  const res = await httpsReq(url, {});
  console.log('[restart] PATH A status:', res.status, 'location:', res.location || '(none)');

  // FoxyCart returns 302 on success (redirect to checkout), 200 for plain cart calls
  if (res.status >= 200 && res.status < 400) return { success: true };
  throw new Error(`Cart API returned ${res.status}: ${res.text.slice(0, 200)}`);
}

/* ─── PATH B: store_id + sub_enddate + OAuth (checkout cancel page) ─────────── */

async function restartViaStoreAndEnddate({ store_id, sub_enddate, sub_nextdate }) {
  const token = await getAccessToken();
  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'FOXY-API-VERSION': '1',
    'Content-Type': 'application/json',
  };

  // Page through subscriptions (limit 300 per page, up to 10 pages = 3000 subscriptions)
  let target = null;
  let offset = 0;
  const limit = 300;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page++) {
    const url = `https://api.foxycart.com/subscriptions?store_id=${encodeURIComponent(store_id)}&limit=${limit}&offset=${offset}`;
    console.log('[restart] PATH B fetching:', url);

    const subsRes = await httpsReq(url, { headers: authHeaders });
    if (!subsRes.ok) throw new Error(`Subscriptions API ${subsRes.status}: ${subsRes.text.slice(0, 200)}`);

    const subs = (subsRes.json && subsRes.json._embedded && subsRes.json._embedded['fx:subscriptions']) || [];
    console.log(`[restart] PATH B page ${page + 1}: ${subs.length} subscriptions`);

    // Find one whose end_date starts with sub_enddate (e.g. "2026-06-20" matches "2026-06-20T00:00:00+00:00")
    target = subs.find(s =>
      s.end_date &&
      s.end_date !== '' &&
      !s.end_date.startsWith('0000') &&
      s.end_date.startsWith(sub_enddate)
    );

    if (target) break;
    if (subs.length < limit) break; // Last page
    offset += limit;
  }

  if (!target) {
    throw new Error(`No subscription found with end_date '${sub_enddate}' in store ${store_id}`);
  }

  const subUrl = target._links && target._links.self && target._links.self.href;
  if (!subUrl) throw new Error('Subscription self-link missing from API response');

  console.log('[restart] PATH B patching:', subUrl);
  console.log('[restart] PATH B payload: end_date="" next_transaction_date=' + sub_nextdate + 'T00:00:00+00:00');

  const patchRes = await httpsReq(
    subUrl,
    { method: 'PATCH', headers: authHeaders },
    { end_date: '', next_transaction_date: sub_nextdate + 'T00:00:00+00:00' }
  );

  if (!patchRes.ok) throw new Error(`PATCH failed (${patchRes.status}): ${patchRes.text.slice(0, 200)}`);

  return { success: true };
}

/* ─── HANDLER ───────────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let sub_token, timestamp, store_domain, store_id, sub_enddate, sub_nextdate;
  try {
    ({ sub_token, timestamp, store_domain, store_id, sub_enddate, sub_nextdate } = JSON.parse(event.body || '{}'));
  } catch (_) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!sub_nextdate) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing sub_nextdate' }) };
  }

  try {
    let result;

    if (sub_token && store_domain) {
      // Path A: cart cancel page — sub_token + timestamp from URL
      result = await restartViaSubToken({ sub_token, timestamp, sub_nextdate, store_domain });
    } else if (store_id && sub_enddate) {
      // Path B: checkout cancel page — store_id + sub_enddate from FC.json
      result = await restartViaStoreAndEnddate({ store_id, sub_enddate, sub_nextdate });
    } else {
      return {
        statusCode: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Provide sub_token + store_domain (cart page) OR store_id + sub_enddate (checkout page)' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };

  } catch (err) {
    console.error('[restart] ERROR:', err.message);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
