/**
 * SUBSCRIPTION STOCK CHECK — DAILY LOOK-AHEAD INVENTORY GUARD
 * ────────────────────────────────────────────────────────────────────────────
 * FoxyCart runs ALL subscription renewals in one batch around ~7am store-local
 * time and does NOT check inventory before billing. So a subscription can bill
 * and commit us to ship something we don't have in stock. This scheduled
 * function runs each weekday MORNING (after 7am, in business hours — no
 * middle-of-the-night pings), tallies what the UPCOMING renewals need, compares
 * against Airtable (the inventory source of record), and posts a Slack digest of
 * any subscriptions we can't fully ship — with lead time to restock before they bill.
 *
 * WINDOW (store-local, look-ahead): we run AFTER ~7am, by which point "today" has
 * already billed and Foxy has advanced those subs, so we report the UPCOMING day(s):
 *   • Mon–Thu → tomorrow.
 *   • Fri     → Sat + Sun + Mon (no weekend runs; Monday bills before Monday's run).
 * Every billing day is covered by the prior weekday's run.
 *
 * POST WINDOW: the digest is only posted to Slack between 7am and 7pm store-local,
 * so a run (scheduled or manual) outside business hours never notifies anyone.
 *
 * SHORTFALL LOGIC = AGGREGATE DEMAND: sum the units each SKU needs across ALL
 * subscriptions in the window and compare to ONE current stock number (a single
 * pool — no restock over the window). Items flagged "Allow Backorders" in
 * Airtable are never reported (Foxy will let them ship).
 *
 * WHY AIRTABLE (not Webflow): Airtable is the inventory source of record; the
 * Webflow CMS inventory is a downstream sync. Each Foxy line resolves to a specific
 * Airtable record: the line `code` is usually the VARIANT record id; when it's the
 * PARENT PRODUCT id (whose Inventory formula is 0 for variant parents), we use the
 * line's differentiator option (Flavor/Size/…) to pick the right variant.
 *
 * MANUAL RUN (for testing): the handler also responds to a direct HTTP hit.
 *   ?key=<STOCK_CHECK_KEY>   required if STOCK_CHECK_KEY env is set
 *   ?dry=1                   compute + return JSON, do NOT post to Slack
 *   ?force=1                 bypass the 7am–7pm post window (still posts)
 *   ?date=YYYY-MM-DD         pretend "today" is this store-local date
 *   ?window=N                report N upcoming days (starting tomorrow)
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

/* Current hour (0–23) in the store timezone. */
function localHour(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).formatToParts(date);
  const h = parseInt(((parts.find((p) => p.type === 'hour') || {}).value) || '0', 10);
  return h === 24 ? 0 : h;
}

/* Build the LOOK-AHEAD window of billing dates to report, given store-local "today".
 * We run in the morning AFTER Foxy's ~7am billing (so posts land in business hours,
 * not the middle of the night). By then "today" has already billed and Foxy has
 * advanced those subs, so we report the UPCOMING day(s) — giving lead time to restock
 * before they bill:
 *   • Mon–Thu → tomorrow.
 *   • Fri     → Sat + Sun + Mon (no weekend runs; Monday bills before Monday's run).
 * Every billing day is covered by the prior weekday's run. */
function buildWindow(todayLocal, windowOverride) {
  const count = (windowOverride && windowOverride > 0) ? windowOverride
    : (weekdayOf(todayLocal) === 5 ? 3 : 1); // Friday → Sat, Sun, Mon
  const dates = [];
  for (let i = 0; i < count; i++) dates.push(addDays(todayLocal, 1 + i)); // start at tomorrow
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

/* Airtable field NAMES (confirmed via schema on base appWUsGD3byrYcN3l). Both the
 * Products and Product Variants tables share these; the Products table additionally
 * has "Variants" (a link to its variant records). We read by name — the single-record
 * GET does NOT honor ?returnFieldsByFieldId, so field-id reads come back undefined. */
const truthy = (v) => v === true || v === 'true';
function readInv(fields) {
  return { inventory: toInt(fields.Inventory), allowBackorders: truthy(fields['Allow Backorders']), name: fields.Name };
}

/* Foxy item_option names that identify WHICH variant a product-level line is for. */
const DIFFERENTIATOR_OPTS = new Set(['flavor', 'size', 'strain', 'strength', 'type']);

/* The selected variant differentiator for a Foxy line item (e.g. "Wild Cherry"), or ''. */
function differentiatorOf(item) {
  const opts = ((item._embedded || {})['fx:item_options']) || [];
  for (const o of opts) {
    if (o && o.name && DIFFERENTIATOR_OPTS.has(String(o.name).toLowerCase())) return String(o.value || '').trim();
  }
  return '';
}

/* Fetch one Airtable record's fields (keyed by field NAME), or null on 404. */
async function airtableRecord(table, id) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${id}`;
  const res = await httpsReq(url, { headers: airtableHeaders() });
  if (res.ok && res.json && res.json.fields) return res.json.fields;
  if (res.status !== 404) console.error(`[stock-check] Airtable ${table}/${id} → ${res.status}`);
  return null;
}

/* Resolve a Foxy line (code + selected differentiator) to the specific inventory unit.
 * Returns { key, name, inventory, allowBackorders, aggregated? } or null if unresolvable.
 *  - code is a VARIANT record  → use it directly (this is the common, correct case).
 *  - code is a PRODUCT with variants → pick the variant matching the differentiator
 *    (the product's own Inventory is 0/meaningless for variant parents). If we can't
 *    match a specific variant, fall back to the SUM of variants (never false-alarms).
 *  - code is a PRODUCT without variants → use the product's own Inventory.
 *  - non-record-id code → legacy Website-Product-Code formula lookup. */
async function resolveInventory(code, differentiator) {
  if (!RECORD_ID_RE.test(code)) {
    const formula = encodeURIComponent(`{${WEBSITE_CODE_FIELD}}="${String(code).replace(/"/g, '\\"')}"`);
    for (const table of [VARIANTS_TABLE, PRODUCTS_TABLE]) {
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?filterByFormula=${formula}&maxRecords=1`;
      const res = await httpsReq(url, { headers: airtableHeaders() });
      if (res.ok && res.json && (res.json.records || []).length) {
        const r = res.json.records[0]; const i = readInv(r.fields || {});
        return { key: r.id, name: i.name || code, inventory: i.inventory, allowBackorders: i.allowBackorders };
      }
    }
    return null;
  }

  // 1. Is the code itself a variant?
  const v = await airtableRecord(VARIANTS_TABLE, code);
  if (v) { const i = readInv(v); return { key: code, name: i.name || code, inventory: i.inventory, allowBackorders: i.allowBackorders }; }

  // 2. Otherwise it should be a product.
  const p = await airtableRecord(PRODUCTS_TABLE, code);
  if (!p) return null;
  const prodName = p.Name || code;
  // "Variants" is a linked-record field → array of variant record-id strings (be
  // tolerant of {id} objects too, just in case).
  const variantIds = (Array.isArray(p.Variants) ? p.Variants : [])
    .map((x) => (typeof x === 'string' ? x : (x && x.id))).filter(Boolean);

  if (!variantIds.length) {
    // Simple product (stock tracked at product level).
    const i = readInv(p);
    return { key: code, name: prodName, inventory: i.inventory, allowBackorders: i.allowBackorders };
  }

  // Product WITH variants: the parent Inventory is 0 — resolve the specific variant.
  const variants = [];
  for (const vid of variantIds) {
    const vr = await airtableRecord(VARIANTS_TABLE, vid);
    if (vr) { const i = readInv(vr); variants.push({ id: vid, name: String(i.name || ''), inventory: i.inventory, allowBackorders: i.allowBackorders }); }
  }
  if (differentiator) {
    const want = differentiator.toLowerCase();
    const match = variants.find((x) => x.name.toLowerCase().includes(want));
    if (match) return { key: match.id, name: match.name, inventory: match.inventory, allowBackorders: match.allowBackorders };
  }
  // No differentiator, or it didn't match a variant name → safe aggregate (won't false-alarm).
  const total = variants.reduce((s, x) => s + x.inventory, 0);
  return { key: code, name: `${prodName} (all variants)`, inventory: total, allowBackorders: truthy(p['Allow Backorders']), aggregated: true };
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
async function runCheck({ dateOverride, windowOverride, dry, force }) {
  if (!process.env.AIRTABLE_API_KEY && !process.env.AIRTABLE_TOKEN) throw new Error('AIRTABLE_API_KEY not set');

  const todayLocal = dateOverride || localDate(new Date());
  const windowDates = buildWindow(todayLocal, windowOverride);
  const targetSet = new Set(windowDates);

  // 1. List all active subscriptions (bucketed by date below).
  const token = await getAccessToken();
  const authHeaders = { 'Authorization': `Bearer ${token}`, 'FOXY-API-VERSION': '1' };
  const rawSubs = await fetchActiveSubscriptions(authHeaders);

  // 2. For each due sub, resolve every line to its specific inventory unit (the
  //    selected variant) and build aggregate demand keyed by that unit. Foxy zoom
  //    is 2 levels deep, so we fetch each due sub's transaction_template items WITH
  //    item_options (the variant flavor/size/etc. lives in item_options) separately.
  const demand = new Map();        // inventory key → total qty needed across the window
  const affected = new Map();      // inventory key → [{ subId, customer, qty, billDate }]
  const info = new Map();          // inventory key → resolved { name, inventory, allowBackorders, aggregated }
  const unresolvedMap = new Map(); // code → { name, demand, subs }
  const resolveCache = new Map();  // `${code}|${diff}` → resolved | null
  let subsChecked = 0;

  for (const sub of rawSubs) {
    const billDate = subBillDate(sub.next_transaction_date);
    if (!targetSet.has(billDate)) continue;
    if (!willBill(sub, billDate)) continue;

    const tt = sub._embedded && sub._embedded['fx:transaction_template'];
    const ttHref = tt && tt._links && tt._links.self && tt._links.self.href;
    let items = [];
    if (ttHref) {
      const r = await httpsReq(ttHref + '?zoom=items:item_options', { headers: authHeaders });
      items = (((r.json || {})._embedded || {})['fx:items']) || [];
    }
    if (!items.length) items = (tt && tt._embedded && tt._embedded['fx:items']) || []; // fallback: no options
    if (!items.length) continue;

    subsChecked++;
    const customer = customerLabel(sub);
    const subId = subIdOf(sub);

    for (const it of items) {
      const code = String(it.code || '').trim();
      if (!code) continue;
      const qty = toInt(it.quantity) || 1;
      const diff = differentiatorOf(it);

      const cacheKey = `${code}|${diff}`;
      if (!resolveCache.has(cacheKey)) resolveCache.set(cacheKey, await resolveInventory(code, diff));
      const resolved = resolveCache.get(cacheKey);

      if (!resolved) { // SKU not found in Airtable — surface, never silently drop
        const u = unresolvedMap.get(code) || { name: String(it.name || '').trim() || code, demand: 0, subs: [] };
        u.demand += qty; u.subs.push({ subId, customer, qty, billDate });
        unresolvedMap.set(code, u);
        continue;
      }
      const key = resolved.key;
      demand.set(key, (demand.get(key) || 0) + qty);
      if (!affected.has(key)) affected.set(key, []);
      affected.get(key).push({ subId, customer, qty, billDate });
      if (!info.has(key)) info.set(key, resolved);
    }
  }

  // 3. Compute shortfalls from the resolved inventory.
  const shortfalls = [];
  for (const [key, need] of demand) {
    const inv = info.get(key);
    if (inv.allowBackorders) continue;                 // backorderable → never flag
    if (need > inv.inventory) {
      shortfalls.push({ code: key, name: inv.name, demand: need, inventory: inv.inventory, short: need - inv.inventory, aggregated: inv.aggregated, subs: affected.get(key) || [] });
    }
  }
  shortfalls.sort((a, b) => b.short - a.short); // worst first
  const unresolved = Array.from(unresolvedMap.entries()).map(([code, u]) => ({ code, name: u.name, demand: u.demand, subs: u.subs }));

  const clean = shortfalls.length === 0 && unresolved.length === 0;
  const summary = {
    window: windowDates,
    subsChecked,
    skusChecked: demand.size,
    shortfalls: shortfalls.map((s) => ({ code: s.code, name: s.name, demand: s.demand, inventory: s.inventory, short: s.short, subs: s.subs })),
    unresolved: unresolved.map((u) => ({ code: u.code, name: u.name, demand: u.demand })),
  };

  // 4. Post to Slack — never in the middle of the night. Only post between 7am and
  //    7pm store-local, so a scheduled (or manual) run outside business hours won't
  //    ping anyone. `force` bypasses the window for testing; `dry` never posts.
  summary.slackPosted = false;
  const allClearSuppressed = clean && String(process.env.STOCK_CHECK_ALLCLEAR || '').toLowerCase() === 'off';
  const hour = localHour(new Date());
  const inBusinessHours = hour >= 7 && hour < 19;
  if (dry) {
    summary.slackPosted = false;
  } else if (!inBusinessHours && !force) {
    summary.postSkipped = `outside 7am–7pm ${TZ} (local hour ${hour})`;
  } else if (allClearSuppressed) {
    summary.postSkipped = 'all-clear suppressed (STOCK_CHECK_ALLCLEAR=off)';
  } else {
    const { text, blocks } = buildSlackMessage(windowDates, subsChecked, shortfalls, unresolved, clean);
    summary.slackPosted = await postToSlack(text, blocks);
  }

  console.log('[stock-check] complete', JSON.stringify({
    window: windowDates, subsChecked, skusChecked: demand.size,
    shortfalls: shortfalls.length, unresolved: unresolved.length,
    dry: !!dry, localHour: hour, posted: summary.slackPosted, postSkipped: summary.postSkipped,
  }));
  return summary;
}

/* ─── HANDLER (scheduled + manual HTTP) ─────────────────────────────────────── */
exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};

  // Manual HTTP invocation — optionally gate with STOCK_CHECK_KEY.
  if (event && event.httpMethod) {
    const key = process.env.STOCK_CHECK_KEY;
    if (key && (q.key || '') !== key) return { statusCode: 401, body: 'unauthorized' };
  }

  if (q.crosstest) { // TEMP: does GET /{table}/{id} resolve across tables?
    try {
      const prodId = 'recy4JRo1Ug4FRSQA';  // OPiA PRODUCT
      const varId = 'recwqTM6v2l95rq0q';   // OPiA Wild Cherry VARIANT
      const probe = async (table, id) => {
        const f = await airtableRecord(table, id);
        return f ? { Name: f.Name, Inventory: f.Inventory, hasVariants: Array.isArray(f.Variants) && f.Variants.length > 0 } : null;
      };
      return { statusCode: 200, body: JSON.stringify({ ok: true,
        productId_via_VARIANTS: await probe(VARIANTS_TABLE, prodId),
        productId_via_PRODUCTS: await probe(PRODUCTS_TABLE, prodId),
        variantId_via_VARIANTS: await probe(VARIANTS_TABLE, varId),
        variantId_via_PRODUCTS: await probe(PRODUCTS_TABLE, varId) }) };
    } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) }; }
  }

  const opts = {
    dry: q.dry === '1' || q.dry === 'true',
    force: q.force === '1' || q.force === 'true', // bypass the 7am–7pm post window (testing)
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
