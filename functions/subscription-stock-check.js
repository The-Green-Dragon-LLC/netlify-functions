/**
 * SUBSCRIPTION STOCK CHECK — DAILY PRE-BILLING INVENTORY GUARD
 * ────────────────────────────────────────────────────────────────────────────
 * FoxyCart runs ALL subscription renewals in one batch around ~7am store-local
 * time and does NOT check inventory before billing. So a subscription can bill
 * and commit us to ship something we don't have in stock. This scheduled
 * function runs BEFORE that 7am batch, tallies what every due subscription
 * needs, compares it against Airtable (the inventory source of record), and
 * posts a Slack digest of any subscriptions we can't fully ship.
 *
 * WINDOW (store-local):
 *   • Mon–Thu → just today's renewals.
 *   • Fri     → Fri + Sat + Sun + Mon, because stock won't be replenished over
 *               the weekend, so weekend + Monday renewals must be vetted before
 *               the team leaves Friday.
 *
 * SHORTFALL LOGIC = AGGREGATE DEMAND: sum the units each SKU needs across ALL
 * subscriptions in the window and compare to ONE current stock number (a single
 * pool — no restock over the window). Items flagged "Allow Backorders" in
 * Airtable are never reported (Foxy will let them ship).
 *
 * WHY AIRTABLE (not Webflow): Airtable is the inventory source of record; the
 * Webflow CMS inventory is a downstream sync. The Foxy line-item `code`/SKU
 * equals the Airtable record id (the "Website Product Code" formula = RECORD_ID()),
 * so a SKU → inventory lookup is a direct record fetch (variants then products).
 *
 * MANUAL RUN (for testing): the handler also responds to a direct HTTP hit.
 *   ?key=<STOCK_CHECK_KEY>   required if STOCK_CHECK_KEY env is set
 *   ?dry=1                   compute + return JSON, do NOT post to Slack
 *   ?date=YYYY-MM-DD         pretend "today" is this store-local date
 *   ?window=N                override the window to N inclusive days
 *
 * Env: FOXY_CLIENT_ID/SECRET/REFRESH_TOKEN, AIRTABLE_API_KEY, SLACK_WEBHOOK_URL.
 *      Optional: FOXY_TZ (default America/Chicago), FOXY_STORE_ID (else resolved),
 *      STOCK_CHECK_KEY, STOCK_CHECK_ALLCLEAR ("off" to suppress the green post).
 */

const https = require('https');

const FOXY_API_HOST = 'api.foxycart.com';

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || 'appWUsGD3byrYcN3l';
const VARIANTS_TABLE = process.env.AIRTABLE_VARIANTS_TABLE || 'tblEtb1aIH5Xk4Nh9';
const PRODUCTS_TABLE = process.env.AIRTABLE_PRODUCTS_TABLE || 'tblkLl9qqg654fWi7';
const WEBSITE_CODE_FIELD = 'Website Product Code'; // RECORD_ID() formula, for the fallback lookup

const TZ = process.env.FOXY_TZ || 'America/Chicago';
const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const MAX_PAGES = 50; // safety cap on subscription pagination

/* ─── HTTPS helper (same shape as back-in-stock-notify) ─────────────────────── */
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

/* ─── FOXY OAUTH (copied from manage-subscription.js) ───────────────────────── */
async function getAccessToken() {
  const credentials = Buffer.from(
    `${process.env.FOXY_CLIENT_ID || ''}:${process.env.FOXY_CLIENT_SECRET || ''}`
  ).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.FOXY_REFRESH_TOKEN || '',
  });
  const res = await httpsReq('https://api.foxycart.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
  }, params.toString());
  if (!res.ok || !res.json || !res.json.access_token) {
    throw new Error('FoxyCart token error: ' + (res.text || '').slice(0, 300));
  }
  return res.json.access_token;
}

/* ─── DATE HELPERS (store-local, DST-safe) ──────────────────────────────────── */

/* Store-local calendar date ("YYYY-MM-DD") for a JS Date. */
function localDate(date) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/* Add N calendar days to a "YYYY-MM-DD" string (noon-UTC anchor dodges DST). */
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Day-of-week for a "YYYY-MM-DD" string: 0=Sun … 5=Fri … 6=Sat. */
function weekdayOf(ymd) {
  return new Date(ymd + 'T12:00:00Z').getUTCDay();
}

/* A subscription's billing date as a store-local "YYYY-MM-DD".
 * Foxy usually returns next_transaction_date as a bare date; handle a full
 * datetime too by converting into the store timezone. */
function subBillDate(nextTxn) {
  const s = String(nextTxn || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s.slice(0, 10) : localDate(d);
}

/* "Fri Jul 17" for display. */
function niceDate(ymd) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(ymd + 'T12:00:00Z'));
}

/* Build the target date window given a store-local "today". */
function buildWindow(todayLocal, windowOverride) {
  let days;
  if (windowOverride && windowOverride > 0) days = windowOverride;
  else if (weekdayOf(todayLocal) === 5) days = 4; // Friday → Fri..Mon
  else days = 1;
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(addDays(todayLocal, i));
  return dates;
}

/* ─── FOXY: resolve store + list due subscriptions ──────────────────────────── */

async function resolveSubscriptionsUrl(authHeaders) {
  if (process.env.FOXY_STORE_ID) {
    return `https://${FOXY_API_HOST}/stores/${process.env.FOXY_STORE_ID}/subscriptions`;
  }
  // API root → fx:store → its fx:subscriptions collection.
  const home = await httpsReq(`https://${FOXY_API_HOST}/`, { headers: authHeaders });
  const storeHref = home.json && home.json._links && home.json._links['fx:store']
    && home.json._links['fx:store'].href;
  if (!storeHref) throw new Error('Could not resolve fx:store from Foxy API root: ' + (home.text || '').slice(0, 200));
  const storeRes = await httpsReq(storeHref, { headers: authHeaders });
  const subsHref = storeRes.json && storeRes.json._links && storeRes.json._links['fx:subscriptions']
    && storeRes.json._links['fx:subscriptions'].href;
  return subsHref || (storeHref.replace(/\/$/, '') + '/subscriptions');
}

/* Fetch all active subscriptions, embedding the transaction_template items +
 * the customer. Paginated.
 *
 * We deliberately do NOT use Foxy's next_transaction_date filter: the
 * colon-modifier form (`next_transaction_date:lessthanorequal=<ISO datetime>`)
 * returned 0 even for a +10-year window (confirmed live against store 112423),
 * so relying on it would silently miss every due subscription. Instead we pull
 * active subs and bucket them by store-local date in code (runCheck) — the
 * authoritative filter anyway. Active-sub counts are modest and paginated at 200. */
async function fetchActiveSubscriptions(authHeaders) {
  const base = await resolveSubscriptionsUrl(authHeaders);
  const LIMIT = 200;
  const subs = [];
  // Offset-based pagination: Foxy always emits a `_links.next` (even past the end),
  // so we advance offset ourselves and stop on the first non-full page.
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      is_active: 'true',
      zoom: 'transaction_template:items,customer',
      limit: String(LIMIT),
      offset: String(page * LIMIT),
    });
    const url = base + (base.includes('?') ? '&' : '?') + params.toString();
    const res = await httpsReq(url, { headers: authHeaders });
    if (!res.ok || !res.json) throw new Error(`Foxy subscriptions ${res.status}: ${(res.text || '').slice(0, 200)}`);
    const items = (res.json._embedded && res.json._embedded['fx:subscriptions']) || [];
    for (const s of items) subs.push(s);
    if (items.length < LIMIT) break; // last (or only) page
  }
  return subs;
}

function subIdOf(sub) {
  const href = (sub._links && sub._links.self && sub._links.self.href) || '';
  const m = /\/subscriptions\/(\d+)/.exec(href);
  return m ? m[1] : String(sub.id || '?');
}

function customerLabel(sub) {
  const c = (sub._embedded && sub._embedded['fx:customer']) || {};
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown customer';
}

/* Won't-actually-bill guard: a subscription with an end_date on or before its
 * next transaction date is ending and Foxy won't charge it. */
function willBill(sub, billDate) {
  if (sub.is_active === false) return false; // defensive: in case the is_active filter is ignored
  const end = String(sub.end_date || '').trim().slice(0, 10);
  if (end && end <= billDate) return false;
  if (sub.is_frozen === true) return false;
  return true;
}

/* ─── AIRTABLE: current inventory + backorder flag for a SKU/code ────────────── */
function airtableHeaders() {
  const token = process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN || '';
  return { Authorization: 'Bearer ' + token };
}

function toInt(v) {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : 0;
}

function readInv(fields) {
  const ab = fields['Allow Backorders'];
  return {
    inventory: toInt(fields.Inventory),
    allowBackorders: ab === true || ab === 'true',
  };
}

/* Returns { inventory, allowBackorders } or null if the code can't be resolved. */
async function inventoryForCode(code) {
  if (RECORD_ID_RE.test(code)) {
    for (const table of [VARIANTS_TABLE, PRODUCTS_TABLE]) {
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${code}`;
      const res = await httpsReq(url, { headers: airtableHeaders() });
      if (res.ok && res.json && res.json.fields) return readInv(res.json.fields);
      if (res.status !== 404) console.error(`[stock-check] inventory fetch ${table}/${code} → ${res.status}`);
    }
    return null;
  }
  // Fallback: match on the Website Product Code formula for any non-record-id code.
  const formula = encodeURIComponent(`{${WEBSITE_CODE_FIELD}}="${String(code).replace(/"/g, '\\"')}"`);
  for (const table of [VARIANTS_TABLE, PRODUCTS_TABLE]) {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?filterByFormula=${formula}&maxRecords=1`;
    const res = await httpsReq(url, { headers: airtableHeaders() });
    if (res.ok && res.json && (res.json.records || []).length) return readInv(res.json.records[0].fields);
  }
  return null;
}

/* ─── SLACK ─────────────────────────────────────────────────────────────────── */
async function postToSlack(text, blocks) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) { console.error('[stock-check] SLACK_WEBHOOK_URL not set — cannot post'); return false; }
  const res = await httpsReq(webhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  }, { text, blocks });
  if (!res.ok) { console.error('[stock-check] Slack post failed', res.status, (res.text || '').slice(0, 200)); return false; }
  return true;
}

/* Build the Block Kit payload for the digest. */
function buildSlackMessage(windowDates, subsChecked, shortfalls, unresolved, allClear) {
  const windowLabel = windowDates.length > 1
    ? `${niceDate(windowDates[0])} → ${niceDate(windowDates[windowDates.length - 1])}`
    : niceDate(windowDates[0]);

  const blocks = [{
    type: 'header',
    text: { type: 'plain_text', text: '🌿 Subscription stock check', emoji: true },
  }, {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Renewals billing *${windowLabel}* · ${subsChecked} subscription(s) checked` }],
  }, { type: 'divider' }];

  if (allClear) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '✅ *All good.* Every subscription in this window can be fulfilled from current inventory.' },
    });
  } else {
    for (const s of shortfalls) {
      const lines = s.subs.map((x) =>
        `• ${x.customer} — sub #${x.subId} · qty ${x.qty} · bills ${niceDate(x.billDate)}`).join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *${s.name}*  \`${s.code}\`\n*Need ${s.demand} · have ${s.inventory} · short ${s.short}*\n${lines}`,
        },
      });
    }
    if (unresolved.length) {
      const lines = unresolved.map((u) =>
        `• ${u.name} \`${u.code}\` — needed ${u.demand} (subs: ${u.subs.map((x) => '#' + x.subId).join(', ')})`).join('\n');
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `❓ *Couldn't verify inventory* (SKU not found in Airtable):\n${lines}` },
      });
    }
  }

  // Plain-text fallback (notifications / no-blocks clients).
  let text;
  if (allClear) {
    text = `Subscription stock check (${windowLabel}): all ${subsChecked} subscription(s) can ship. ✅`;
  } else {
    text = `Subscription stock check (${windowLabel}): ${shortfalls.length} SKU shortfall(s)`
      + (unresolved.length ? `, ${unresolved.length} unverified` : '') + '. ⚠️';
  }
  return { text, blocks };
}

/* ─── CORE ──────────────────────────────────────────────────────────────────── */
async function runCheck({ dateOverride, windowOverride, dry }) {
  if (!process.env.AIRTABLE_API_KEY && !process.env.AIRTABLE_TOKEN) throw new Error('AIRTABLE_API_KEY not set');

  const todayLocal = dateOverride || localDate(new Date());
  const windowDates = buildWindow(todayLocal, windowOverride);
  const targetSet = new Set(windowDates);

  // 1. List active subscriptions in the (padded) window.
  const token = await getAccessToken();
  const authHeaders = { 'Authorization': `Bearer ${token}`, 'FOXY-API-VERSION': '1' };
  const rawSubs = await fetchActiveSubscriptions(authHeaders);

  // 2. Keep only subs actually billing on a target date, and build demand.
  const demand = new Map();   // code → total qty needed across the window
  const affected = new Map(); // code → [{ subId, customer, qty, billDate }]
  const nameFor = new Map();  // code → human item name (from the Foxy line)
  let subsChecked = 0;

  for (const sub of rawSubs) {
    const billDate = subBillDate(sub.next_transaction_date);
    if (!targetSet.has(billDate)) continue;
    if (!willBill(sub, billDate)) continue;

    const tt = sub._embedded && sub._embedded['fx:transaction_template'];
    const items = (tt && tt._embedded && tt._embedded['fx:items']) || [];
    if (!items.length) continue;

    subsChecked++;
    const customer = customerLabel(sub);
    const subId = subIdOf(sub);

    for (const it of items) {
      const code = String(it.code || '').trim();
      if (!code) continue;
      const qty = toInt(it.quantity) || 1;
      demand.set(code, (demand.get(code) || 0) + qty);
      if (!affected.has(code)) affected.set(code, []);
      affected.get(code).push({ subId, customer, qty, billDate });
      if (!nameFor.has(code)) nameFor.set(code, String(it.name || '').trim() || code);
    }
  }

  // 3. Check inventory per unique code and compute shortfalls.
  const shortfalls = [];
  const unresolved = [];
  for (const [code, need] of demand) {
    const inv = await inventoryForCode(code);
    const entry = { code, name: nameFor.get(code) || code, demand: need, subs: affected.get(code) || [] };
    if (inv === null) { unresolved.push(entry); continue; }
    if (inv.allowBackorders) continue;                 // backorderable → never flag
    if (need > inv.inventory) {
      shortfalls.push({ ...entry, inventory: inv.inventory, short: need - inv.inventory });
    }
  }
  // Worst shortfall first.
  shortfalls.sort((a, b) => b.short - a.short);

  const clean = shortfalls.length === 0 && unresolved.length === 0;
  const summary = {
    window: windowDates,
    subsChecked,
    skusChecked: demand.size,
    shortfalls: shortfalls.map((s) => ({ code: s.code, name: s.name, demand: s.demand, inventory: s.inventory, short: s.short, subs: s.subs })),
    unresolved: unresolved.map((u) => ({ code: u.code, name: u.name, demand: u.demand })),
  };

  // 4. Post to Slack (unless dry, or a clean run with all-clear suppressed).
  const allClearSuppressed = clean && String(process.env.STOCK_CHECK_ALLCLEAR || '').toLowerCase() === 'off';
  if (!dry && !allClearSuppressed) {
    const { text, blocks } = buildSlackMessage(windowDates, subsChecked, shortfalls, unresolved, clean);
    summary.slackPosted = await postToSlack(text, blocks);
  } else {
    summary.slackPosted = false;
  }

  console.log('[stock-check] complete', JSON.stringify({
    window: windowDates, subsChecked, skusChecked: demand.size,
    shortfalls: shortfalls.length, unresolved: unresolved.length, dry: !!dry, posted: summary.slackPosted,
  }));
  return summary;
}

/* ─── DEBUG (temporary diagnostics; no secrets) ─────────────────────────────── */
async function runDebug() {
  const token = await getAccessToken();
  const authHeaders = { 'Authorization': `Bearer ${token}`, 'FOXY-API-VERSION': '1' };
  const subsUrl = await resolveSubscriptionsUrl(authHeaders);
  const u = new URL(subsUrl);

  const join = (extra) => subsUrl + (subsUrl.includes('?') ? '&' : '?') + extra;

  // 1. UNFILTERED active subs (ground truth) — sample their real dates + items.
  const a = await httpsReq(join('is_active=true&limit=5&zoom=transaction_template:items,customer'),
    { headers: authHeaders });
  const unfilteredSample = ((a.json && a.json._embedded && a.json._embedded['fx:subscriptions']) || []).map((s) => ({
    id: subIdOf(s), next_transaction_date: s.next_transaction_date, is_active: s.is_active, end_date: s.end_date,
    items: (((s._embedded || {})['fx:transaction_template'] || {})._embedded || {})['fx:items']
      ? s._embedded['fx:transaction_template']._embedded['fx:items'].map((i) => ({ code: i.code, qty: i.quantity, name: i.name }))
      : 'NO_ITEMS_EMBEDDED',
  }));

  // 2. Same active subs but with a VERY wide date filter (+10y). If this returns
  //    the full count, the colon-modifier date filter works and any 0 in the real
  //    run is just far-future data; if it returns 0, the date filter is broken.
  const wideMax = addDays(localDate(new Date()), 3650) + 'T23:59:59Z';
  const w = await httpsReq(join(new URLSearchParams({
    is_active: 'true', 'next_transaction_date:lessthanorequal': wideMax, limit: '1',
  }).toString()), { headers: authHeaders });

  // 3. Next 60 days (what a normal run would roughly see).
  const max60 = addDays(localDate(new Date()), 60) + 'T23:59:59Z';
  const f = await httpsReq(join(new URLSearchParams({
    is_active: 'true', 'next_transaction_date:lessthanorequal': max60, limit: '1',
  }).toString()), { headers: authHeaders });

  return {
    subsHost: u.host, subsPath: u.pathname,
    activeTotal: a.json ? a.json.total_items : null, activeStatus: a.status,
    wideFilterTotal_plus10y: w.json ? w.json.total_items : null, wideStatus: w.status,
    wideFilterUrlSuffix: 'next_transaction_date:lessthanorequal=' + wideMax,
    filteredNext60dTotal: f.json ? f.json.total_items : null, filteredStatus: f.status,
    filterErrorText: w.ok ? undefined : (w.text || '').slice(0, 300),
    unfilteredSample,
  };
}

/* ─── HANDLER (scheduled + manual HTTP) ─────────────────────────────────────── */
exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};

  // Manual HTTP invocation — optionally gate with STOCK_CHECK_KEY.
  if (event && event.httpMethod) {
    const key = process.env.STOCK_CHECK_KEY;
    if (key && (q.key || '') !== key) return { statusCode: 401, body: 'unauthorized' };
  }

  if (q.debug === '1') {
    try { return { statusCode: 200, body: JSON.stringify({ ok: true, debug: await runDebug() }) }; }
    catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) }; }
  }

  const opts = {
    dry: q.dry === '1' || q.dry === 'true',
    dateOverride: /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : null,
    windowOverride: q.window ? parseInt(q.window, 10) : null,
  };

  try {
    const summary = await runCheck(opts);
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...summary }) };
  } catch (e) {
    console.error('[stock-check] failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
