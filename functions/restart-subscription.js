/**
 * restart-subscription.js  —  Netlify Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Clears a FoxyCart subscription's end_date (un-cancels it) and sets
 * next_transaction_date to tomorrow, via the FoxyCart REST API.
 *
 * Called by the "Restart Subscription" button on the checkout/cart cancel page.
 *
 * DEPLOYMENT
 * ──────────
 *  1. Copy this file to your Netlify project:
 *       netlify/functions/restart-subscription.js
 *
 *  2. Deploy (git push or Netlify CLI).
 *
 *  3. In Netlify → Site Settings → Environment Variables add:
 *       FOXY_CLIENT_ID      →  from FoxyCart Admin → API → OAuth Clients
 *       FOXY_CLIENT_SECRET  →  same
 *       FOXY_REFRESH_TOKEN  →  obtained when you authorized the OAuth client
 *
 *  4. In the checkout + cart templates, set GD_RESTART_FN to:
 *       https://YOUR-SITE.netlify.app/.netlify/functions/restart-subscription
 *
 * HOW TO GET FOXY API CREDENTIALS
 * ────────────────────────────────
 *  1. Go to FoxyCart Admin → API
 *  2. Create a new OAuth client (name: "Green Dragon Restart", redirect: any URL)
 *  3. Note the client_id and client_secret
 *  4. Authorize the client:
 *       https://my.foxycart.com/authorize?response_type=code&client_id=YOUR_ID&redirect_uri=YOUR_REDIRECT
 *  5. Exchange the auth code for tokens — use the refresh_token from that response
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');

/* ─── CORS ──────────────────────────────────────────────────────────────────── */

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

    const bodyStr =
      bodyObj !== undefined
        ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj))
        : undefined;

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

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

/* ─── FOXY AUTH ─────────────────────────────────────────────────────────────── */

async function getAccessToken() {
  // FoxyCart expects credentials as HTTP Basic Auth (client_id:client_secret base64-encoded)
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
    throw new Error('FoxyCart token error: ' + res.text);
  }

  return res.json.access_token;
}

/* ─── HANDLER ───────────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  let customer_id, sub_nextdate;
  try {
    ({ customer_id, sub_nextdate } = JSON.parse(event.body || '{}'));
  } catch (_) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!customer_id || !sub_nextdate) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing customer_id or sub_nextdate' }) };
  }

  try {
    const token = await getAccessToken();
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'FOXY-API-VERSION': '1',
      'Content-Type': 'application/json',
    };

    // ── Get this customer's active subscriptions ──────────────────────────────
    const subsRes = await httpsReq(
      `https://api.foxycart.com/subscriptions?customer_id=${encodeURIComponent(customer_id)}&limit=50`,
      { headers: authHeaders }
    );

    if (!subsRes.ok) {
      throw new Error(`Subscriptions API returned ${subsRes.status}: ${subsRes.text}`);
    }

    const subs = (subsRes.json && subsRes.json._embedded && subsRes.json._embedded['fx:subscriptions']) || [];

    // ── Find the subscription with a pending end_date ─────────────────────────
    const target = subs.find(
      (s) => s.end_date && s.end_date !== '' && !s.end_date.startsWith('0000')
    );

    if (!target) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No pending-cancel subscription found for this customer' }),
      };
    }

    const subUrl = target._links && target._links.self && target._links.self.href;
    if (!subUrl) throw new Error('Subscription self-link missing');

    // ── Clear end_date, set next_transaction_date ─────────────────────────────
    const updateRes = await httpsReq(
      subUrl,
      { method: 'PATCH', headers: authHeaders },
      { end_date: '', next_transaction_date: sub_nextdate + 'T00:00:00+00:00' }
    );

    if (!updateRes.ok) {
      throw new Error(`Subscription update failed (${updateRes.status}): ${updateRes.text}`);
    }

    console.log(`[restart-subscription] Cleared end_date for customer ${customer_id}, next date ${sub_nextdate}`);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    };

  } catch (err) {
    console.error('[restart-subscription]', err.message);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
