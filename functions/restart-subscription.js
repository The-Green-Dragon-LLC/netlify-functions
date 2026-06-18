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

/* ─── SHARED: fetch subscriptions via OAuth (paginated) ─────────────────────── */

async function fetchSubscriptions(store_id, token) {
  const getHeaders = {
    'Authorization': `Bearer ${token}`,
    'FOXY-API-VERSION': '1',
  };

  // Paginate through all subscriptions starting from the store-nested URL.
  // FoxyCart uses total_items / returned_items (not "total"), and _links.next
  // for the next page URL.
  let allSubs = [];
  let nextUrl = `https://api.foxycart.com/stores/${store_id}/subscriptions?limit=300`;

  while (nextUrl) {
    console.log('[restart] fetching page:', nextUrl);
    const res = await httpsReq(nextUrl, { headers: getHeaders });
    const data = res.json || {};
    const page = data._embedded && data._embedded['fx:subscriptions'];
    console.log(
      '[restart] page status:', res.status,
      'total_items:', data.total_items,
      'returned_items:', data.returned_items,
      'page_count:', page ? page.length : 0
    );

    if (!page || page.length === 0) break;
    allSubs = allSubs.concat(page);

    // Follow _links.next only if there are more items to retrieve
    const hasMore = data.total_items && allSubs.length < data.total_items;
    nextUrl = (hasMore && data._links && data._links.next && data._links.next.href) || null;
  }

  if (allSubs.length > 0) {
    console.log('[restart] total subscriptions fetched:', allSubs.length);
    return allSubs;
  }

  // Fallback to /subscriptions (no store_id scope)
  const fallbackUrl = `https://api.foxycart.com/subscriptions?limit=300`;
  console.log('[restart] fetching fallback:', fallbackUrl);
  const res2 = await httpsReq(fallbackUrl, { headers: getHeaders });
  const fallbackPage = res2.json && res2.json._embedded && res2.json._embedded['fx:subscriptions'];
  if (fallbackPage && fallbackPage.length > 0) {
    console.log('[restart] fallback got', fallbackPage.length, 'subscriptions');
    return fallbackPage;
  }

  throw new Error(`No subscriptions returned. Check store_id ${store_id} and OAuth credentials.`);
}

/* ─── CHECK: is subscription actually cancelled right now? ──────────────────── */

async function checkSubscription({ store_id, sub_nextdate_current, sub_enddate_current }) {
  const token = await getAccessToken();
  const subs = await fetchSubscriptions(store_id, token);

  console.log(
    '[restart] check: searching', subs.length, 'subs',
    '| nextdate_current:', sub_nextdate_current,
    '| enddate_current:', sub_enddate_current
  );

  // Primary: collect ALL subs with matching next_transaction_date, then check if
  // any of them has end_date set.  A simple .find() would stop at the first match
  // even if that match is an *active* sub sharing the same next billing date —
  // causing a false negative when a cancelled sub comes later in the list.
  const byNextdate = subs.filter(s =>
    s.next_transaction_date &&
    s.next_transaction_date.startsWith(sub_nextdate_current)
  );

  if (byNextdate.length > 0) {
    const cancelled = byNextdate.find(s =>
      s.end_date && s.end_date !== '' && !s.end_date.startsWith('0000')
    );
    console.log(
      '[restart] check: found', byNextdate.length, 'sub(s) by nextdate —',
      cancelled ? 'cancelled end_date: ' + cancelled.end_date : 'none cancelled'
    );
    if (cancelled) return { cancelled: true, end_date: cancelled.end_date };
    return { cancelled: false, end_date: '' };
  }

  console.log('[restart] check: not found by nextdate, trying end_date fallback');

  // Fallback: FoxyCart may clear next_transaction_date when cancellation is pending,
  // so look for a subscription whose end_date matches the FC.json sub_enddate.
  // This is safe — FC.json sub_enddate would be 0000 for active subscriptions so
  // the JS never reaches here in that case.
  if (sub_enddate_current && !sub_enddate_current.startsWith('0000')) {
    const edc = sub_enddate_current.slice(0, 10); // "YYYY-MM-DD"
    const byEndDate = subs.find(s =>
      s.end_date && s.end_date.slice(0, 10) === edc
    );
    if (byEndDate) {
      console.log('[restart] check: found by end_date match:', byEndDate.end_date, '→ cancelled: true');
      return { cancelled: true, reason: 'found_by_end_date' };
    }
    console.log('[restart] check: no end_date match for', edc);
  }

  // Cannot verify — play it safe and hide restart UI
  console.log('[restart] check: not_found → cancelled: false');
  return { cancelled: false, reason: 'not_found' };
}

/* ─── PATH B: OAuth — find subscription by next_transaction_date ─────────────── */

async function restartViaNextdate({ store_id, sub_nextdate_current, sub_enddate_current, sub_nextdate }) {
  const token = await getAccessToken();
  const patchHeaders = {
    'Authorization': `Bearer ${token}`,
    'FOXY-API-VERSION': '1',
    'Content-Type': 'application/json',
  };

  const subs = await fetchSubscriptions(store_id, token);

  console.log(
    '[restart] PATH B: searching', subs.length, 'subs',
    '| nextdate_current:', sub_nextdate_current,
    '| enddate_current:', sub_enddate_current
  );

  // Primary: find by next_transaction_date + end_date set
  let target = subs.find(s =>
    s.end_date &&
    s.end_date !== '' &&
    !s.end_date.startsWith('0000') &&
    s.next_transaction_date &&
    s.next_transaction_date.startsWith(sub_nextdate_current)
  );

  // Fallback: FoxyCart may clear next_transaction_date when cancellation is pending.
  // Match by end_date == sub_enddate_current (same logic as checkSubscription).
  if (!target && sub_enddate_current && !sub_enddate_current.startsWith('0000')) {
    console.log('[restart] PATH B: no match by next_transaction_date, trying end_date fallback');
    const edc = sub_enddate_current.slice(0, 10);
    target = subs.find(s =>
      s.end_date &&
      s.end_date.slice(0, 10) === edc
    );
    if (target) {
      console.log('[restart] PATH B: found by end_date match:', target.end_date);
    }
  }

  if (!target) {
    throw new Error(
      `No pending-cancel subscription found. Checked ${subs.length} subscription(s). ` +
      `Looking for next_transaction_date starting '${sub_nextdate_current}' with end_date set.`
    );
  }

  const subUrl = target._links && target._links.self && target._links.self.href;
  if (!subUrl) throw new Error('Subscription self-link missing from API response');

  // Use FoxyCart's zero-date to clear end_date — empty string is silently ignored.
  const patchBody = {
    end_date: '0000-00-00T00:00:00+00:00',
    next_transaction_date: sub_nextdate + 'T00:00:00+00:00',
  };
  console.log('[restart] PATH B patching:', subUrl, '| body:', JSON.stringify(patchBody));
  const patchRes = await httpsReq(subUrl, { method: 'PATCH', headers: patchHeaders }, patchBody);

  console.log('[restart] PATH B PATCH status:', patchRes.status, patchRes.text && patchRes.text.slice(0, 200));
  if (!patchRes.ok) throw new Error(`PATCH failed (${patchRes.status}): ${patchRes.text.slice(0, 200)}`);

  return { success: true };
}

/* ─── HANDLER ───────────────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let action, sub_token, timestamp, store_domain, store_id, sub_nextdate_current, sub_nextdate, sub_enddate_current;
  try {
    ({ action, sub_token, timestamp, store_domain, store_id, sub_nextdate_current, sub_nextdate, sub_enddate_current } = JSON.parse(event.body || '{}'));
  } catch (_) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // action: 'check' — live verify whether subscription is actually cancelled right now
  if (action === 'check') {
    if (!sub_nextdate_current) {
      return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing sub_nextdate_current' }) };
    }
    try {
      const result = await checkSubscription({ store_id, sub_nextdate_current, sub_enddate_current });
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
    } catch (err) {
      console.error('[restart] check ERROR:', err.message);
      // On check failure, hide restart UI — a false positive is worse than a missed button.
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ cancelled: false, reason: 'check_error' }) };
    }
  }

  if (!sub_nextdate) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing sub_nextdate' }) };
  }

  try {
    let result;

    if (sub_token && store_domain) {
      result = await restartViaSubToken({ sub_token, timestamp, sub_nextdate, store_domain });
    } else if (sub_nextdate_current) {
      result = await restartViaNextdate({ store_id, sub_nextdate_current, sub_enddate_current, sub_nextdate });
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
