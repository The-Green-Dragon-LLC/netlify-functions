/**
 * restart-subscription.js  —  Netlify Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Clears a FoxyCart subscription's end_date (un-cancels it) and sets
 * next_transaction_date to tomorrow.
 *
 * TWO PATHS
 * ─────────
 *  PATH A — cart cancel page (/cart?sub_token=...)
 *    Calls FoxyCart cart API with sub_token + sub_enddate=0000-00-00.
 *
 *  PATH B — checkout cancel page (/checkout.php?fcsid=...)
 *    Uses FoxyCart REST API via OAuth:
 *      1. Gets access token via refresh_token grant
 *      2. Tries store-nested URL /stores/{store_id}/subscriptions first,
 *         then falls back to /subscriptions
 *      3. Accepts response data even on 4XX (FoxyCart returns 400 with
 *         valid embedded data in some query configurations)
 *      4. Finds subscription where end_date is set AND next_transaction_date
 *         starts with sub_nextdate_current
 *      5. PATCHes end_date and next_transaction_date
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

  console.log('[restart] PATH A:', url);
  const res = await httpsReq(url, {});
  console.log('[restart] PATH A status:', res.status);

  if (res.status >= 200 && res.status < 400) return { success: true };
  throw new Error(`Cart API returned ${res.status}: ${res.text.slice(0, 200)}`);
}

/* ─── PATH B: OAuth — find subscription by next_transaction_date ─────────────── */

async function restartViaNextdate({ store_id, sub_nextdate_current, sub_nextdate }) {
  const token = await getAccessToken();

  // GET headers — NO Content-Type on GET requests (some APIs reject that with 400)
  const getHeaders = {
    'Authorization': `Bearer ${token}`,
    'FOXY-API-VERSION': '1',
  };
  // PATCH headers — Content-Type needed for JSON body
  const patchHeaders = {
    'Authorization': `Bearer ${token}`,
    'FOXY-API-VERSION': '1',
    'Content-Type': 'application/json',
  };

  // Try store-nested URL first (most correct), then fall back to flat endpoint
  const candidateUrls = [
    `https://api.foxycart.com/stores/${store_id}/subscriptions?limit=300`,
    `https://api.foxycart.com/subscriptions?limit=300`,
  ];

  let subs = [];
  let lastStatus = 0;

  for (const baseUrl of candidateUrls) {
    console.log('[restart] PATH B trying:', baseUrl);
    const res = await httpsReq(baseUrl, { headers: getHeaders });
    console.log('[restart] PATH B status:', res.status, 'total:', res.json && res.json.total);

    const embedded = res.json && res.json._embedded && res.json._embedded['fx:subscriptions'];

    if (embedded && embedded.length > 0) {
      subs = embedded;
      console.log('[restart] PATH B got', subs.length, 'subscriptions from', baseUrl);
      break;
    }
    lastStatus = res.status;
    if (res.ok && (!embedded || embedded.length === 0)) {
      // API returned 200 but no subscriptions — nothing to iterate
      break;
    }
    // Non-200 with no embedded data: try next URL
  }

  if (subs.length === 0) {
    throw new Error(`No subscriptions returned (last status: ${lastStatus}). Check store_id ${store_id} and OAuth credentials.`);
  }

  // Find subscription with pending end_date AND matching next_transaction_date
  let target = subs.find(s =>
    s.end_date &&
    s.end_date !== '' &&
    !s.end_date.startsWith('0000') &&
    s.next_transaction_date &&
    s.next_transaction_date.startsWith(sub_nextdate_current)
  );

  // Fallback: any subscription with end_date set (if next_transaction_date changed)
  if (!target) {
    console.log('[restart] PATH B: no match by next_transaction_date, trying end_date-only fallback');
    target = subs.find(s =>
      s.end_date &&
      s.end_date !== '' &&
      !s.end_date.startsWith('0000')
    );
  }

  if (!target) {
    throw new Error(
      `No pending-cancel subscription found. Checked ${subs.length} subscription(s). ` +
      `Looking for next_transaction_date starting '${sub_nextdate_current}' with end_date set.`
    );
  }

  const subUrl = target._links && target._links.self && target._links.self.href;
  if (!subUrl) throw new Error('Subscription self-link missing from API response');

  console.log('[restart] PATH B patching:', subUrl);
  console.log('[restart] PATH B end_date="" next_transaction_date=' + sub_nextdate + 'T00:00:00+00:00');

  const patchRes = await httpsReq(
    subUrl,
    { method: 'PATCH', headers: patchHeaders },
    { end_date: '', next_transaction_date: sub_nextdate + 'T00:00:00+00:00' }
  );

  console.log('[restart] PATH B PATCH status:', patchRes.status);
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
      result = await restartViaSubToken({ sub_token, timestamp, sub_nextdate, store_domain });
    } else if (sub_nextdate_current) {
      result = await restartViaNextdate({ store_id, sub_nextdate_current, sub_nextdate });
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
