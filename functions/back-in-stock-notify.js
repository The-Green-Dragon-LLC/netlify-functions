/**
 * BACK-IN-STOCK — SCHEDULED NOTIFIER
 * ────────────────────────────────────────────────────────────────────────────
 * Runs ONCE A DAY at 4pm Central. For every Pending row in the Airtable "Back In
 * Stock Requests" table it checks the item's CURRENT inventory in Airtable (the
 * source of record). When an item is back in stock it triggers the Rejoiner
 * restock-alert journey for that customer and flips the row to Notified so it
 * never sends twice.
 *
 * Why the schedule looks odd: Netlify cron is UTC-only and DST-blind, so 4pm Central
 * is 21:00 UTC in summer and 22:00 UTC in winter. netlify.toml fires at BOTH hours
 * ("0 21,22 * * *") and the hour guard below drops the one that isn't 4pm locally —
 * so exactly one sweep runs per day year-round. Alerts therefore batch: an item that
 * restocks at 9am is emailed at 4pm the same day; one that restocks at 5pm waits for
 * tomorrow's run.
 *
 * Why Airtable (not Webflow): Airtable is the inventory source of record; Webflow
 * CMS inventory is a downstream sync. The Foxy `code`/SKU stored on each request
 * equals the Airtable record id (the "Website Product Code" formula = RECORD_ID()),
 * so matching a request to its item is a direct record fetch — variants first,
 * then products, with a slug/code fallback for any non-record-id code.
 *
 * Manual run (for testing): the handler also responds to a direct HTTP hit, and an
 * HTTP hit BYPASSES the 4pm hour guard so you can test at any time of day. If env
 * BIS_NOTIFY_KEY is set, an HTTP call must pass ?key=<that value>.
 *
 * EMAIL PLATFORM: REJOINER (migrated off Omnisend, Aug 2026)
 * ─────────────────────────────────────────────────────────
 * The alert is a webhook-TRIGGERED Rejoiner journey, started per customer:
 *   POST /api/v2/{site}/journeys/{journey_id}/webhook_trigger/
 *   { email, session_data: { ... } }
 * Every session_data key is readable in the template as
 * {{ session.metadata.<key> }}. See sessionData() below for the contract.
 *
 * Env: AIRTABLE_API_KEY (or AIRTABLE_TOKEN), optional BIS_NOTIFY_KEY,
 *      REJOINER_API_KEY, REJOINER_SITE_ID, REJOINER_BIS_ALERT_JOURNEY,
 *      optional BIS_TZ (default America/Chicago) and BIS_SEND_HOUR (default 16).
 *      If you change BIS_SEND_HOUR or BIS_TZ, revisit the UTC hours in netlify.toml.
 */

const https = require('https');
const rejoiner = require('../lib/rejoiner.js');

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || 'appWUsGD3byrYcN3l';
const REQUESTS_TABLE = process.env.AIRTABLE_BIS_TABLE || 'tblcPKQSoRpYu7VXW'; // Back In Stock Requests
const VARIANTS_TABLE = process.env.AIRTABLE_VARIANTS_TABLE || 'tblEtb1aIH5Xk4Nh9';
const PRODUCTS_TABLE = process.env.AIRTABLE_PRODUCTS_TABLE || 'tblkLl9qqg654fWi7';
const WEBSITE_CODE_FIELD = 'Website Product Code'; // RECORD_ID() formula, for the fallback lookup

// Rejoiner journey that sends the "it's back in stock" alert.
const ALERT_JOURNEY = process.env.REJOINER_BIS_ALERT_JOURNEY || '';

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

// Send window: the scheduled sweep only runs when it is this hour in this timezone.
const TZ = process.env.BIS_TZ || 'America/Chicago';
const SEND_HOUR = Number(process.env.BIS_SEND_HOUR || 16); // 16 = 4pm store-local

/* Current hour (0–23) in the store timezone. */
function localHour(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).formatToParts(date);
  const h = parseInt(((parts.find((p) => p.type === 'hour') || {}).value) || '0', 10);
  return h === 24 ? 0 : h;
}

/* ─── HTTPS helper ────────────────────────────────────────────────────────── */
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

function airtableToken() {
  return process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN || '';
}
function airtableHeaders() {
  return { Authorization: 'Bearer ' + airtableToken() };
}

/* ─── Airtable reads ──────────────────────────────────────────────────────── */

/* All Pending request rows (paginated). */
async function fetchPendingRequests(token) {
  const rows = [];
  let offset = '';
  do {
    const formula = encodeURIComponent('{Status}="Pending"');
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${REQUESTS_TABLE}`
      + `?filterByFormula=${formula}&pageSize=100${offset ? `&offset=${offset}` : ''}`;
    const res = await httpsReq(url, { headers: airtableHeaders() });
    if (!res.ok || !res.json) throw new Error(`Airtable pending ${res.status}: ${(res.text || '').slice(0, 200)}`);
    for (const rec of (res.json.records || [])) rows.push({ id: rec.id, f: rec.fields || {} });
    offset = res.json.offset || '';
  } while (offset);
  return rows;
}

/* Current inventory + discontinued flag for a product code. Returns
 * { inventory:Number, discontinued:Boolean }, or null if not found.
 * Tries a direct record fetch (code === Airtable record id) in Variants then
 * Products; falls back to a Website-Product-Code lookup for any odd code.
 * Discontinued is an Airtable checkbox (present & true only when checked). */
async function itemForCode(code) {
  if (RECORD_ID_RE.test(code)) {
    for (const table of [VARIANTS_TABLE, PRODUCTS_TABLE]) {
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${code}`;
      const res = await httpsReq(url, { headers: airtableHeaders() });
      if (res.ok && res.json && res.json.fields) {
        return { inventory: toInt(res.json.fields.Inventory), discontinued: res.json.fields.Discontinued === true };
      }
      if (res.status !== 404) {
        console.error(`[bis-notify] inventory fetch ${table}/${code} → ${res.status}`);
      }
    }
    return null;
  }
  // Fallback: match on the Website Product Code formula.
  const formula = encodeURIComponent(`{${WEBSITE_CODE_FIELD}}="${String(code).replace(/"/g, '\\"')}"`);
  for (const table of [VARIANTS_TABLE, PRODUCTS_TABLE]) {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}`
      + `?filterByFormula=${formula}&maxRecords=1`;
    const res = await httpsReq(url, { headers: airtableHeaders() });
    if (res.ok && res.json && (res.json.records || []).length) {
      const f = res.json.records[0].fields;
      return { inventory: toInt(f.Inventory), discontinued: f.Discontinued === true };
    }
  }
  return null;
}

function toInt(v) {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : 0;
}

/* ─── Airtable write ──────────────────────────────────────────────────────── */
async function markNotified(recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${REQUESTS_TABLE}/${recordId}`;
  const res = await httpsReq(url, {
    method: 'PATCH',
    headers: { ...airtableHeaders(), 'Content-Type': 'application/json' },
  }, { fields: { Status: 'Notified', 'Notified At': new Date().toISOString() } });
  if (!res.ok) throw new Error(`Airtable mark ${res.status}: ${(res.text || '').slice(0, 200)}`);
}

/* ─── Rejoiner alert ──────────────────────────────────────────────────────── */

/* Human-readable date for the template, e.g. "July 1, 2026", in store-local time.
 * Returns '' for a missing/unparseable value so the template never prints junk. */
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric',
  }).format(d);
}

/* session_data for the alert template — {{ session.metadata.<key> }}.
 * Mirrors sessionData() in back-in-stock-subscribe.js (plus inventory and the
 * requested_* pair) so the confirmation and alert templates can share a block.
 *
 * Values are PRE-FORMATTED for the same reason as in the subscribe function:
 * Rejoiner's template engine is undocumented, so the template should only ever
 * need plain {{ }} substitution — no filters, no fallbacks, no conditionals. */
function sessionData(row, inventory) {
  const name = String(row['Product Name'] || '').trim();
  const label = String(row['Variant Label'] || '').trim();
  const raw = row.Price != null ? Number(row.Price) : null;
  const price = Number.isFinite(raw) ? raw : null;
  return {
    product_code: String(row['Product Code'] || '').trim(),
    product_name: name,
    variant_label: label,
    product_title: label ? `${name} — ${label}` : name,
    product_url: row['Product URL'] || '',
    image_url: row['Image URL'] || '',
    price,
    price_formatted: price == null ? '' : `$${price.toFixed(2)}`,
    inventory,
    // Lets the template say "you asked about this on ..." — often weeks earlier.
    requested_at: row['Requested At'] || '',
    requested_date: formatDate(row['Requested At']),
  };
}

/* Returns true only if Rejoiner accepted the trigger. Returning false leaves the
 * row Pending so the next sweep retries — never mark Notified on a failure. */
async function sendAlert(email, row, inventory) {
  if (!rejoiner.isConfigured()) {
    console.warn('[bis-notify] REJOINER_API_KEY/REJOINER_SITE_ID not set — cannot send alert');
    return false;
  }
  if (!ALERT_JOURNEY) {
    console.warn('[bis-notify] REJOINER_BIS_ALERT_JOURNEY not set — cannot send alert');
    return false;
  }
  try {
    // ensureCustomer defaults on: a signup could predate any other contact with
    // this address, or the profile could have been pruned since.
    await rejoiner.triggerJourney(ALERT_JOURNEY, email, sessionData(row, inventory), {
      customerFields: { metadata: { source: 'back-in-stock' } },
    });
    return true;
  } catch (e) {
    console.error('[bis-notify] Rejoiner alert failed:', e.message);
    return false;
  }
}

/* ─── Core sweep ──────────────────────────────────────────────────────────── */
async function runSweep() {
  const token = airtableToken();
  if (!token) throw new Error('AIRTABLE_API_KEY not set');

  const pending = await fetchPendingRequests(token);
  const itemCache = new Map(); // code → {inventory,discontinued}|null (fetch each code once)
  let notified = 0, stillOut = 0, unknown = 0, discontinued = 0, errors = 0;

  for (const row of pending) {
    const code = String(row.f['Product Code'] || '').trim();
    const email = String(row.f.Email || '').trim();
    if (!code || !email) { errors++; continue; }

    try {
      if (!itemCache.has(code)) itemCache.set(code, await itemForCode(code));
      const item = itemCache.get(code);

      if (item === null) { unknown++; continue; }      // couldn't resolve the item — leave Pending
      if (item.discontinued) { discontinued++; continue; } // discontinued — never notify, leave Pending
      const inv = item.inventory;
      if (inv <= 0) { stillOut++; continue; }          // still out of stock — leave Pending

      // Back in stock → alert, then mark Notified (mark immediately so an
      // overlapping run never double-sends this row).
      const sent = await sendAlert(email, row.f, inv);
      if (!sent) { errors++; continue; }               // keep Pending, retry next run
      await markNotified(row.id);
      notified++;
    } catch (e) {
      console.error(`[bis-notify] row ${row.id} (${code}) error:`, e.message);
      errors++;
    }
  }

  const summary = { pending: pending.length, notified, stillOut, unknown, discontinued, errors };
  console.log('[bis-notify] sweep complete', JSON.stringify(summary));
  return summary;
}

/* ─── Handler (scheduled + manual HTTP) ───────────────────────────────────── */
exports.handler = async (event) => {
  const isHttp = !!(event && event.httpMethod);

  // Direct HTTP invocation (manual test) — optionally gate with BIS_NOTIFY_KEY.
  if (isHttp) {
    const key = process.env.BIS_NOTIFY_KEY;
    const given = (event.queryStringParameters || {}).key || '';
    if (key && given !== key) return { statusCode: 401, body: 'unauthorized' };
  }

  // Scheduled runs fire at both 21:00 and 22:00 UTC so that one of them is 4pm
  // Central in either DST offset; drop the one that isn't. Manual HTTP runs are
  // exempt so testing works at any hour.
  if (!isHttp) {
    const hour = localHour(new Date());
    if (hour !== SEND_HOUR) {
      const skipped = `local hour ${hour} in ${TZ}, sends at ${SEND_HOUR}`;
      console.log('[bis-notify] skipped —', skipped);
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped }) };
    }
  }

  try {
    const summary = await runSweep();
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...summary }) };
  } catch (e) {
    console.error('[bis-notify] sweep failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
