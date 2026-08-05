/**
 * REJOINER API CLIENT
 * ────────────────────────────────────────────────────────────────────────────
 * Shared helper for talking to Rejoiner 2 from Netlify functions. Every shape in
 * here was verified against the live API (rj2.rejoiner.com, Aug 2026) rather than
 * inferred from docs — the docs omit the auth header entirely and the previous
 * integration shipped a payload that 400'd on every call.
 *
 * BASE / AUTH
 *   https://rj2.rejoiner.com/api/v2/{site_id}/...   (v1 for the older endpoints)
 *   Authorization: Rejoiner {api_key}
 *   A missing/bad key gives 403 {"code":"bad_api_key"} — these endpoints are all
 *   authenticated, including the per-node webhook URLs.
 *
 * THE ONE THING THAT TRIPS EVERYTHING UP
 *   Journey triggers are keyed on `email`, and Rejoiner will NOT create the
 *   customer for you:
 *       404 {"error":"No customer was found with email ..."}
 *   So anything that starts a journey for a possibly-new address must upsert the
 *   customer profile FIRST. `triggerJourney()` does that automatically.
 *
 * ENV
 *   REJOINER_API_KEY   - Rejoiner → Domain Settings → API Key
 *   REJOINER_SITE_ID   - Rejoiner → Domain Settings (e.g. "ZLZZEJL")
 */

const https = require('https');

const API_HOST = 'rj2.rejoiner.com';

/* ─── HTTPS helper (same shape as the rest of this repo's functions) ───────── */
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

/* ─── Config ──────────────────────────────────────────────────────────────── */
function apiKey() { return process.env.REJOINER_API_KEY || ''; }
function siteId() { return process.env.REJOINER_SITE_ID || ''; }

/* True when both credentials are present. Callers use this to degrade
 * gracefully instead of throwing on an unconfigured deploy. */
function isConfigured() { return !!(apiKey() && siteId()); }

function base(version) {
  return `https://${API_HOST}/api/${version}/${siteId()}`;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Rejoiner ${apiKey()}`,
  };
}

function post(url, body) {
  return httpsReq(url, { method: 'POST', headers: headers() }, body);
}

function fail(res, what) {
  return new Error(`Rejoiner ${what} ${res.status}: ${(res.text || '').slice(0, 300)}`);
}

/* Rejoiner signals "this address isn't in the account" with a 404 whose body
 * names the email. Detected by status + shape so a generic 404 (bad node id,
 * which returns {"detail":"Not found."}) isn't mistaken for it. */
function isUnknownCustomer(res) {
  return res.status === 404 && /No customer was found/i.test(res.text || '');
}

/* ─── Customers ───────────────────────────────────────────────────────────── */

/**
 * Create the customer, or update them if the email already exists.
 *   POST /api/v2/{site}/customers/    { email, first_name?, last_name?, metadata? }
 * `metadata` is arbitrary JSON stored on the profile (distinct from journey
 * SESSION metadata — see triggerJourney).
 */
async function upsertCustomer(email, fields) {
  const body = { email, ...(fields || {}) };
  const res = await post(`${base('v2')}/customers/`, body);
  if (!res.ok) throw fail(res, 'upsertCustomer');
  return res.json;
}

/* ─── Journeys ────────────────────────────────────────────────────────────── */

/**
 * Start a WEBHOOK-TRIGGERED journey for a customer.
 *   POST /api/v2/{site}/journeys/{journey_id}/webhook_trigger/
 *   { email, session_data: { ... } }
 *
 * `session_data` is merged into the journey session's metadata, so a key
 * `product_name` is readable in the email template as
 * {{ session.metadata.product_name }}.
 *
 * Pass `customerFields` to control the profile written when the address is new.
 * Set ensureCustomer:false to let an unknown address fail instead.
 */
async function triggerJourney(journeyId, email, sessionData, opts) {
  const { ensureCustomer = true, customerFields = null } = opts || {};
  const url = `${base('v2')}/journeys/${journeyId}/webhook_trigger/`;
  const body = { email, session_data: sessionData || {} };

  let res = await post(url, body);

  // Brand-new address: create the profile, then trigger once more. Only one
  // retry — if it still 404s the cause is the journey, not the customer.
  if (isUnknownCustomer(res) && ensureCustomer) {
    await upsertCustomer(email, customerFields || {});
    res = await post(url, body);
  }

  if (!res.ok) throw fail(res, `triggerJourney(${journeyId})`);
  return true;
}

/**
 * Release a customer sitting on a "Wait for Event → Inbound Webhook" node.
 *   POST /api/v2/{site}/nodes/{node_id}/webhook_event_wait/
 *   { email, session_data: { ... } }
 *
 * Accepts either a full node URL or a bare node id.
 *
 * Unlike triggerJourney there is NO customer upsert here: the customer must
 * already be queued on that exact node, so a 404 means the node URL is stale
 * (cloning a journey mints new node ids) or the wait already expired. Creating
 * a profile could not help and would just mask the real cause.
 */
async function releaseWaitingNode(nodeUrlOrId, email, sessionData) {
  const url = /^https?:\/\//.test(nodeUrlOrId)
    ? nodeUrlOrId
    : `${base('v2')}/nodes/${nodeUrlOrId}/webhook_event_wait/`;

  const res = await post(url, { email, session_data: sessionData || {} });
  if (!res.ok) throw fail(res, 'releaseWaitingNode');
  return true;
}

/* ─── Lists & consent (v1 endpoints) ─────────────────────────────────────── */

/**
 * Add a contact to an email list.
 *   POST /api/v1/{site}/lists/{list_id}/contacts/   { customer: { email, ... } }
 *
 * NOTE: adding to a list can itself START a journey (that's how the welcome
 * flow is triggered), so only call this on an explicit marketing opt-in.
 */
async function addToList(listId, email, fields) {
  const res = await post(`${base('v1')}/lists/${listId}/contacts/`, {
    customer: { email, ...(fields || {}) },
  });
  if (!res.ok) throw fail(res, 'addToList');
  return true;
}

/**
 * Record marketing consent against the profile.
 *   POST /api/v1/{site}/customer/opt_in/   { email, ... }
 */
async function recordOptIn(email, fields) {
  const res = await post(`${base('v1')}/customer/opt_in/`, { email, ...(fields || {}) });
  if (!res.ok) throw fail(res, 'recordOptIn');
  return true;
}

module.exports = {
  isConfigured,
  siteId,
  upsertCustomer,
  triggerJourney,
  releaseWaitingNode,
  addToList,
  recordOptIn,
  // exported for tests
  _internal: { httpsReq, isUnknownCustomer, base },
};
