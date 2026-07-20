/**
 * BACK-IN-STOCK — SCHEDULED NOTIFIER
 * ────────────────────────────────────────────────────────────────────────────
 * Runs on a cron (schedule set in netlify.toml). For every Pending row in the
 * Airtable "Back In Stock Requests" table it checks the item's CURRENT inventory
 * in Airtable (the source of record). When an item is back in stock it fires the
 * Omnisend "back in stock" alert event to that customer and flips the row to
 * Notified so it never sends twice.
 *
 * Why Airtable (not Webflow): Airtable is the inventory source of record; Webflow
 * CMS inventory is a downstream sync. The Foxy `code`/SKU stored on each request
 * equals the Airtable record id (the "Website Product Code" formula = RECORD_ID()),
 * so matching a request to its item is a direct record fetch — variants first,
 * then products, with a slug/code fallback for any non-record-id code.
 *
 * Manual run (for testing): the handler also responds to a direct HTTP hit. If
 * env BIS_NOTIFY_KEY is set, an HTTP call must pass ?key=<that value>; scheduled
 * invocations (no httpMethod) always run.
 *
 * Env: AIRTABLE_API_KEY (or AIRTABLE_TOKEN), OMNISEND_API_KEY, optional BIS_NOTIFY_KEY.
 */

const https = require('https');

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || 'appWUsGD3byrYcN3l';
const REQUESTS_TABLE = process.env.AIRTABLE_BIS_TABLE || 'tblcPKQSoRpYu7VXW'; // Back In Stock Requests
const VARIANTS_TABLE = process.env.AIRTABLE_VARIANTS_TABLE || 'tblEtb1aIH5Xk4Nh9';
const PRODUCTS_TABLE = process.env.AIRTABLE_PRODUCTS_TABLE || 'tblkLl9qqg654fWi7';
const WEBSITE_CODE_FIELD = 'Website Product Code'; // RECORD_ID() formula, for the fallback lookup

const OMNISEND_BASE = 'https://api.omnisend.com/api';
const OMNISEND_VERSION = '2026-03-15';
const ALERT_EVENT_NAME = 'back in stock';

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

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

/* ─── Omnisend alert ──────────────────────────────────────────────────────── */
async function fireAlertEvent(email, properties) {
  const apiKey = process.env.OMNISEND_API_KEY;
  if (!apiKey) { console.warn('[bis-notify] OMNISEND_API_KEY not set — cannot send alert'); return false; }
  const res = await httpsReq(OMNISEND_BASE + '/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Omnisend-API-Key ' + apiKey,
      'Omnisend-Version': OMNISEND_VERSION,
    },
  }, {
    eventName: ALERT_EVENT_NAME,
    origin: 'api',
    eventTime: new Date().toISOString(),
    contact: { email },
    properties: properties || {},
  });
  if (!res.ok) { console.error('[bis-notify] Omnisend alert failed', res.status, (res.text || '').slice(0, 300)); return false; }
  return true;
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
      const sent = await fireAlertEvent(email, {
        productCode: code,
        productName: row.f['Product Name'] || '',
        variantLabel: row.f['Variant Label'] || '',
        productUrl: row.f['Product URL'] || '',
        imageUrl: row.f['Image URL'] || '',
        price: (row.f.Price != null) ? Number(row.f.Price) : undefined,
        inventory: inv,
      });
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
  // Direct HTTP invocation (manual test) — optionally gate with BIS_NOTIFY_KEY.
  if (event && event.httpMethod) {
    const key = process.env.BIS_NOTIFY_KEY;
    const given = (event.queryStringParameters || {}).key || '';
    if (key && given !== key) return { statusCode: 401, body: 'unauthorized' };
  }
  try {
    const summary = await runSweep();
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...summary }) };
  } catch (e) {
    console.error('[bis-notify] sweep failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
