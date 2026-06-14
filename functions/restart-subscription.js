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
 *    Calls FoxyCart cart API: the HMAC-validated sub_token authorises the
 *    modification directly.
 *
 *  PATH B — checkout cancel page (/checkout.php?fcsid=...)
 *    Receives store_id + sub_nextdate_current (from FC.json) + sub_nextdate.
 *    Uses FoxyCart REST API via OAuth:
 *      1. Gets access token via refresh_token grant
 *      2. Queries /subscriptions (no store_id filter — OAuth scopes it)
 *      3. Finds the subscription with end_date set AND next_transaction_date
 *         matching sub_nextdate_current
 *      4. PATCHes end_date to '' and next_transaction_date to tomorrow
 *
 * ENV VARS
 *   FOXY_CLIENT_ID, FOXY_CLIENT_SECRET, FOXY_REFRESH_TOKEN
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

  if (res.status >= 200 && res.status < 400) return { success: true };
  throw new Error(`Cart API returned ${res.status}: ${res.text.slice(0, 200)}`);
}

/* ─── PATH B: sub_nextdate_current + OAuth (checkout cancel page) ────────────── */

async function restartViaNextdate({ sub_nextdate_current, sub_nextdate }) {
  const token = await getAccessToken();
  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'FOXY-API-VERSION': '1',
    'Content-Type': 'application/json',
  };

  // Fetch subscriptions — no store_id filter; OAuth token is already store-scoped.
  // Page through up to 3000 subscriptions (10 pages × 300).
  let target = null;
  let offset = 0;
  const limit = 300;

  for (let page = 0; page < 10 && !target; page++) {
    const url = `https://api.foxycart.com/subscriptions?limit=${limit}&offset=${offset}`;
    console.log('[restart] PATH B page', page + 1, ':', url);

    const subsRes = await httpsReq(url, { headers: authHeaders });
    console.log('[restart] PATH B status:', subsRes.status, 'total:', subsRes.json && subsRes.json.total);

    if (!subsRes.ok) throw new Error(`Subscriptions API ${subsRes.status}: ${subsRes.text.slice(0, 200)}`);

    const subs = (subsRes.json && subsRes.json._embedded && subsRes.json._embedded['fx:subscriptions']) || [];

    // Find the subscription where:
    //   - end_date is set (has pending cancellation)
    //   - next_transaction_date matches what FC.json reported (stable identifier)
    target = subs.find(s =>
      s.end_date &&
      s.end_date !== '' &&
      !s.end_date.startsWith('0000') &&
      s.next_transaction_date &&
      s.next_transaction_date.startsWith(sub_nextdate_current)
    );

    if (!target && subs.length < limit) break; // last page
    offset += limit;
  }

  if (!target) {
    throw new Error(
      `No subscription found with pending end_date AND next_transaction_date starting '${sub_nextdate_current}'`
    );
  }

  const subUrl = target._links && target._links.self && target._links.self.href;
  if (!subUrl) throw new Error('Subscription self-link missing from API response');

  console.log('[restart] PATH B patching:', subUrl);
  console.log('[restart] PATH B setting end_date="" next_transaction_date=' + sub_nextdate + 'T00:00:00+00:00');

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

  let sub_token, timestamp, store_domain, store_id, sub_nextdate_current, sub_nextdate;
  try {
    ({ sub_token, timestamp, store_domain, store_id, sub_nextdate_current, sub_nextdate } = JSON.parse(event.body || '{}'));
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
    } else if (sub_nextdate_current) {
      // Path B: checkout cancel page — identify by current next_transaction_date
      result = await restartViaNextdate({ sub_nextdate_current, sub_nextdate });
    } else {
      return {
        statusCode: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Provide sub_token + store_domain (cart page) OR sub_nextdate_current (checkout page)' }),
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
