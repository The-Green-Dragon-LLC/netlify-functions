/**
 * BACK-IN-STOCK — SIGNUP FUNCTION
 * ────────────────────────────────────────────────────────────────────────────
 * Captures a customer's request to be notified when an out-of-stock product or
 * variant is back in stock. Called by the on-page widget (public/back-in-stock.js).
 *
 * Flow (POST JSON):
 *   { email, code, name, url, image, price, variantLabel, itemType, optIn }
 *   1. validate email + code
 *   2. de-dupe: skip if an identical Pending row already exists
 *   3. insert a row in Airtable "Back In Stock Requests" (Status = Pending)
 *   4. trigger the Rejoiner signup-confirmation journey
 *   5. if optIn: record consent + add to the marketing list in Rejoiner
 *
 * The scheduled sibling `back-in-stock-notify.js` later reads the Pending rows,
 * checks Airtable inventory, and triggers the restock alert journey.
 *
 * EMAIL PLATFORM: REJOINER (migrated off Omnisend, Aug 2026)
 * ─────────────────────────────────────────────────────────
 * Rejoiner has no "custom event" primitive like Omnisend's. The equivalent is a
 * webhook-TRIGGERED journey, started per customer:
 *
 *   POST /api/v2/{site}/journeys/{journey_id}/webhook_trigger/
 *   { email, session_data: { ... } }
 *
 * `session_data` becomes the journey session's metadata, so every key below is
 * readable in the email template as {{ session.metadata.<key> }}.
 *
 * Rejoiner will NOT create an unknown customer — it answers
 * 404 {"error":"No customer was found with email ..."} — and a back-in-stock
 * signup is very often the first time we've ever seen that address. lib/rejoiner
 * handles this by upserting the profile and retrying once.
 *
 * Env (on the netlify-functions site):
 *   AIRTABLE_API_KEY (or AIRTABLE_TOKEN)  — data.records:read + write on the Website base
 *   REJOINER_API_KEY                      — Rejoiner → Domain Settings → API Key
 *   REJOINER_SITE_ID                      — Rejoiner → Domain Settings (e.g. ZLZZEJL)
 *   REJOINER_BIS_SIGNUP_JOURNEY           — journey id of the "we'll let you know" confirmation
 *   REJOINER_BIS_LIST_ID                  — optional; list opted-in shoppers join
 *
 * Best-effort on every Rejoiner call: a signup is never failed because Rejoiner
 * hiccups — the Airtable row is the source of truth the notifier reads.
 */

const https = require('https');
const rejoiner = require('../lib/rejoiner.js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || 'appWUsGD3byrYcN3l';
const AIRTABLE_TABLE = process.env.AIRTABLE_BIS_TABLE || 'tblcPKQSoRpYu7VXW'; // "Back In Stock Requests"

// Rejoiner journey that sends the "we'll email you when it's back" confirmation.
const SIGNUP_JOURNEY = process.env.REJOINER_BIS_SIGNUP_JOURNEY || '';
// Optional list that opted-in shoppers join. Leave unset to record consent only.
const MARKETING_LIST = process.env.REJOINER_BIS_LIST_ID || '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ─── HTTPS helper (same shape as manage-subscription.js) ─────────────────── */
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

function resp(statusCode, obj) {
  return { statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

/* ─── Airtable ────────────────────────────────────────────────────────────── */
function airtableToken() {
  return process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN || '';
}

/* Escape a value for safe interpolation inside an Airtable formula string. */
function esc(v) {
  return String(v == null ? '' : v).replace(/"/g, '\\"');
}

/* Is there already a Pending request for this email+code? (idempotent signups) */
async function hasPendingRequest(token, email, code) {
  const formula = `AND(LOWER({Email})="${esc(email)}",{Product Code}="${esc(code)}",{Status}="Pending")`;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`
    + `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const res = await httpsReq(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok || !res.json) throw new Error(`Airtable lookup ${res.status}: ${(res.text || '').slice(0, 200)}`);
  return (res.json.records || []).length > 0;
}

async function createRequest(token, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
  const res = await httpsReq(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, { fields, typecast: true });
  if (!res.ok) throw new Error(`Airtable create ${res.status}: ${(res.text || '').slice(0, 300)}`);
  return res.json;
}

/* ─── Rejoiner (best-effort) ─────────────────────────────────────────────── */

/* Build the session_data payload the email template reads.
 * Every key here is available in Rejoiner as {{ session.metadata.<key> }}.
 * Keep this in sync with the same helper in back-in-stock-notify.js so the
 * confirmation and the alert can share one template block. */
function sessionData(item) {
  const label = String(item.variantLabel || '').trim();
  const name = String(item.productName || '').trim();
  return {
    product_code: item.code,
    product_name: name,
    variant_label: label,
    // Pre-joined for templates that just want one line to print.
    product_title: label ? `${name} — ${label}` : name,
    product_url: item.productUrl || '',
    image_url: item.imageUrl || '',
    price: Number.isFinite(item.price) ? item.price : null,
  };
}

/* Confirmation email: "we'll let you know when this is back." */
async function sendSignupConfirmation(email, item) {
  if (!rejoiner.isConfigured()) {
    console.warn('[bis] REJOINER_API_KEY/REJOINER_SITE_ID not set — skipping confirmation');
    return;
  }
  if (!SIGNUP_JOURNEY) {
    console.warn('[bis] REJOINER_BIS_SIGNUP_JOURNEY not set — skipping confirmation');
    return;
  }
  try {
    // ensureCustomer (the default) matters most here: a back-in-stock signup is
    // frequently the first time this address has ever hit the account.
    await rejoiner.triggerJourney(SIGNUP_JOURNEY, email, sessionData(item), {
      customerFields: { metadata: { source: 'back-in-stock' } },
    });
  } catch (e) {
    console.error('[bis] Rejoiner confirmation failed:', e.message);
  }
}

/* Only called when the customer ticked the marketing opt-in box.
 * Consent is recorded first and independently of the list add: if the list add
 * fails we still want a durable record that they said yes. */
async function optInMarketing(email, ip) {
  if (!rejoiner.isConfigured()) {
    console.warn('[bis] Rejoiner not configured — skipping marketing opt-in');
    return;
  }
  try {
    await rejoiner.recordOptIn(email, { ip_address: ip || undefined });
  } catch (e) {
    console.error('[bis] Rejoiner opt-in record failed:', e.message);
  }
  if (!MARKETING_LIST) return;
  try {
    // Adding to a list can itself start a journey (that's how the welcome flow
    // fires), so this runs ONLY behind the explicit opt-in checkbox.
    await rejoiner.addToList(MARKETING_LIST, email);
  } catch (e) {
    console.error('[bis] Rejoiner list add failed:', e.message);
  }
}

/* ─── Handler ─────────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return resp(400, { ok: false, error: 'Invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  if (!EMAIL_RE.test(email)) return resp(400, { ok: false, error: 'A valid email is required.' });
  if (!code) return resp(400, { ok: false, error: 'Missing product code.' });

  const productName = String(body.name || '').trim();
  const variantLabel = String(body.variantLabel || '').trim();
  const productUrl = String(body.url || '').trim();
  const imageUrl = String(body.image || '').trim();
  const priceNum = Number(body.price);
  const itemType = body.itemType === 'Product' ? 'Product' : 'Variant';
  const optIn = body.optIn === true || body.optIn === 'true';

  const token = airtableToken();
  if (!token) return resp(500, { ok: false, error: 'Server not configured.' });

  const item = {
    code, productName, variantLabel, productUrl, imageUrl,
    price: Number.isFinite(priceNum) ? priceNum : null,
  };

  // De-dupe — a repeat signup for the same item is a no-op success.
  try {
    if (await hasPendingRequest(token, email, code)) {
      // Still (re)send the confirmation so the customer gets feedback and any
      // opt-in is honored, but don't create a duplicate row.
      await sendSignupConfirmation(email, item);
      if (optIn) await optInMarketing(email, clientIp(event));
      return resp(200, { ok: true, already: true });
    }
  } catch (e) {
    console.error('[bis] dedupe lookup failed:', e.message);
    return resp(502, { ok: false, error: 'Could not reach the notification service. Please try again.' });
  }

  // Record the request.
  try {
    await createRequest(token, {
      Email: email,
      'Product Code': code,
      'Item Type': itemType,
      'Product Name': productName || undefined,
      'Variant Label': variantLabel || undefined,
      'Product URL': productUrl || undefined,
      'Image URL': imageUrl || undefined,
      Price: Number.isFinite(priceNum) ? priceNum : undefined,
      'Opt-in Marketing': optIn,
      Status: 'Pending',
      'Requested At': new Date().toISOString(),
    });
  } catch (e) {
    console.error('[bis] Airtable create failed:', e.message);
    return resp(502, { ok: false, error: 'Could not save your request. Please try again.' });
  }

  // Fire-and-forget Rejoiner touches — never fail the signup on these. The
  // Airtable row is already saved, and it's what the notifier actually reads.
  await sendSignupConfirmation(email, item);
  if (optIn) await optInMarketing(email, clientIp(event));

  return resp(200, { ok: true });
};

function clientIp(event) {
  const h = (event && event.headers) || {};
  return (h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || '').trim();
}
