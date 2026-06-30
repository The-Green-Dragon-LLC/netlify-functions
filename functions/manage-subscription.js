/**
 * manage-subscription.js  —  Netlify Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-service subscription management for the Green Dragon customer portal.
 *
 * Driven by the FoxyCart REST API (OAuth refresh-token grant).  Every Foxy
 * field touched here is confirmed PATCHable on the subscription resource
 * (next_transaction_date, frequency) or on its transaction_template (shipping
 * address).  See https://api.foxy.io/rels/subscription.
 *
 * ACTIONS  (POST JSON { action, subscription_uri, sub_token, ... })
 * ───────
 *   ship-now      → next charge = tomorrow.  Foxy auto-advances the next date by
 *                   one frequency interval *after* the charge runs, so the normal
 *                   cadence resets itself from the ship date — no double charge.
 *   skip          → advance next charge by exactly one frequency interval.
 *   set-frequency → change billing frequency (allowed: 1w, 2w, 1m).
 *   pause         → push next charge far into the future (indefinite).  The portal
 *                   detects this and shows "Resume" instead of the action buttons.
 *   resume        → next charge = tomorrow (un-pause).
 *   change-address→ PATCH the subscription's transaction_template shipping address
 *                   (Foxy does not allow address edits on the subscription itself).
 *
 * SECURITY
 *   The browser sends the subscription's own `sub_token` (an unguessable
 *   per-subscription capability the portal already exposes via
 *   _links['fx:sub_token_url']).  We fetch the subscription with admin
 *   credentials, then verify the token on the fetched resource matches the one
 *   supplied.  A customer can therefore only modify a subscription they actually
 *   hold the token for — passing someone else's subscription URI is rejected.
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

const ALLOWED_FREQUENCIES = ['1w', '2w', '1m'];
const PAUSE_YEARS_OUT = 5; // "indefinite" — far enough that it never charges until resumed
const FOXY_API_HOST = 'api.foxycart.com';

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
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, json });
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

/* ─── DATE HELPERS (UTC, to avoid timezone drift) ───────────────────────────── */

function fmt(d) {
  // → "YYYY-MM-DD"
  return d.toISOString().slice(0, 10);
}

function tomorrow() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return fmt(d);
}

function farFuture() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + PAUSE_YEARS_OUT);
  return fmt(d);
}

/* Add one frequency interval (e.g. "1w", "2w", "1m", ".5m", "1y") to a date. */
function addFrequency(fromDateStr, frequency) {
  const base = new Date((fromDateStr || tomorrow()).slice(0, 10) + 'T00:00:00Z');
  // Never advance from a date already in the past — start from tomorrow instead.
  const floor = new Date(tomorrow() + 'T00:00:00Z');
  const start = base > floor ? base : floor;

  const m = /^(\.?\d+(?:\.\d+)?)([dwmy])$/.exec(String(frequency || '').trim());
  if (!m) throw new Error('Unrecognized frequency: ' + frequency);
  const qty = parseFloat(m[1]);
  const unit = m[2];

  const d = new Date(start.getTime());
  if (unit === 'd') d.setUTCDate(d.getUTCDate() + Math.round(qty));
  else if (unit === 'w') d.setUTCDate(d.getUTCDate() + Math.round(qty * 7));
  else if (unit === 'm') {
    // ".5m" = twice a month → ~15 days; whole months → calendar months
    if (qty < 1) d.setUTCDate(d.getUTCDate() + 15);
    else d.setUTCMonth(d.getUTCMonth() + Math.round(qty));
  } else if (unit === 'y') d.setUTCFullYear(d.getUTCFullYear() + Math.round(qty));

  return fmt(d);
}

/* ─── SUB_TOKEN OWNERSHIP CHECK ─────────────────────────────────────────────── */

function tokenFromSubTokenUrl(sub) {
  const href = sub && sub._links && sub._links['fx:sub_token_url'] && sub._links['fx:sub_token_url'].href;
  if (!href) return null;
  try {
    return new URL(href).searchParams.get('sub_token');
  } catch (_) {
    const m = /[?&]sub_token=([^&]+)/.exec(href);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

/* ─── HANDLER ───────────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method Not Allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return resp(400, { error: 'Invalid JSON body' });
  }

  const { action, subscription_uri, sub_token, frequency, address } = body;

  const VALID = ['ship-now', 'skip', 'set-frequency', 'pause', 'resume', 'change-address'];
  if (!VALID.includes(action)) return resp(400, { error: 'Unknown action: ' + action });
  if (!subscription_uri || !sub_token) return resp(400, { error: 'Missing subscription_uri or sub_token' });

  // SSRF guard: only ever talk to the Foxy API host.
  let subUri;
  try {
    subUri = new URL(subscription_uri);
  } catch (_) {
    return resp(400, { error: 'Invalid subscription_uri' });
  }
  if (subUri.hostname !== FOXY_API_HOST) {
    return resp(400, { error: 'subscription_uri must point to ' + FOXY_API_HOST });
  }

  if (action === 'set-frequency' && !ALLOWED_FREQUENCIES.includes(frequency)) {
    return resp(400, { error: 'frequency must be one of ' + ALLOWED_FREQUENCIES.join(', ') });
  }
  if (action === 'change-address' && (!address || typeof address !== 'object')) {
    return resp(400, { error: 'change-address requires an address object' });
  }

  try {
    const token = await getAccessToken();
    const authHeaders = { 'Authorization': `Bearer ${token}`, 'FOXY-API-VERSION': '1' };

    // 1. Fetch the subscription (single request — fast).
    const subRes = await httpsReq(subUri.href, { headers: authHeaders });
    const sub = subRes.json;
    if (!sub || !sub._links) {
      throw new Error(`Could not load subscription (${subRes.status}): ${subRes.text.slice(0, 200)}`);
    }

    // 2. Verify the caller actually owns this subscription.
    const realToken = tokenFromSubTokenUrl(sub);
    if (!realToken || realToken !== sub_token) {
      console.warn('[manage] sub_token mismatch for', subUri.href);
      return resp(403, { error: 'Not authorized for this subscription' });
    }

    const patchHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

    // 3. Perform the action.
    if (action === 'change-address') {
      const ttHref = sub._links['fx:transaction_template'] && sub._links['fx:transaction_template'].href;
      if (!ttHref) throw new Error('Subscription has no transaction_template link');
      const patchBody = buildAddressPatch(address);
      const r = await patchOrThrow(ttHref, patchHeaders, patchBody, 'address');
      return resp(200, { success: true, action, applied: patchBody, status: r.status });
    }

    let patchBody;
    if (action === 'ship-now')        patchBody = { next_transaction_date: tomorrow() };
    else if (action === 'resume')     patchBody = { next_transaction_date: tomorrow() };
    else if (action === 'pause')      patchBody = { next_transaction_date: farFuture() };
    else if (action === 'set-frequency') patchBody = { frequency };
    else if (action === 'skip')       patchBody = { next_transaction_date: addFrequency(sub.next_transaction_date, sub.frequency) };

    const r = await patchOrThrow(subUri.href, patchHeaders, patchBody, action);
    return resp(200, { success: true, action, applied: patchBody, status: r.status });

  } catch (err) {
    console.error('[manage] ERROR:', err.message);
    return resp(500, { error: err.message });
  }
};

/* ─── HELPERS ───────────────────────────────────────────────────────────────── */

function buildAddressPatch(a) {
  // Only forward known shipping_* fields that were supplied.
  const map = {
    first_name:  'shipping_first_name',
    last_name:   'shipping_last_name',
    company:     'shipping_company',
    address1:    'shipping_address1',
    address2:    'shipping_address2',
    city:        'shipping_city',
    region:      'shipping_state',
    postal_code: 'shipping_postal_code',
    country:     'shipping_country',
    phone:       'shipping_phone',
  };
  const out = {};
  Object.keys(map).forEach((k) => {
    if (a[k] !== undefined && a[k] !== null) out[map[k]] = String(a[k]);
  });
  if (!Object.keys(out).length) throw new Error('No recognized address fields supplied');
  return out;
}

async function patchOrThrow(url, headers, bodyObj, label) {
  console.log(`[manage] PATCH (${label}):`, url, '| body:', JSON.stringify(bodyObj));
  const r = await httpsReq(url, { method: 'PATCH', headers }, bodyObj);
  console.log(`[manage] PATCH (${label}) status:`, r.status, (r.text || '').slice(0, 200));
  if (!r.ok) throw new Error(`PATCH ${label} failed (${r.status}): ${(r.text || '').slice(0, 200)}`);
  return r;
}

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
