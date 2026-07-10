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
 *   restart       → un-cancel: clear end_date + reactivate (is_active=true). Keeps
 *                   the existing next charge date if still future, else tomorrow.
 *   change-address→ PATCH the subscription's transaction_template shipping OR
 *                   billing address (address_type: 'shipping' | 'billing'; Foxy
 *                   does not allow address edits on the subscription itself).
 *   list-variants → (read) return the switchable variants for a line item, priced
 *                   from the Webflow CMS.
 *   set-quantity  → change a line item's quantity (1..99).
 *   set-variant   → swap a line item to a sibling variant of the same product.
 *                   Price is read from the CMS, never the client (HMAC is off).
 *
 * SECURITY
 *   The browser sends the subscription's own `sub_token` (an unguessable
 *   per-subscription capability the portal already exposes via
 *   _links['fx:sub_token_url']).  We fetch the subscription with admin
 *   credentials, then verify the token on the fetched resource matches the one
 *   supplied.  A customer can therefore only modify a subscription they actually
 *   hold the token for — passing someone else's subscription URI is rejected.
 *
 * OMNISEND EVENTS
 *   After a successful change we fire a custom Omnisend event (best-effort) so an
 *   automation can email the customer: `subscription cancelled` on cancel,
 *   `subscription updated` on every other mutating action.
 *
 * ENV VARS
 *   FOXY_CLIENT_ID, FOXY_CLIENT_SECRET, FOXY_REFRESH_TOKEN  (required)
 *   WEBFLOW_API_TOKEN  (required for list-variants / set-variant price lookups)
 *   OMNISEND_API_KEY   (optional — enables the cancel/update customer-email events)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ALLOWED_FREQUENCIES = ['1w', '2w', '1m'];
const PAUSE_YEARS_OUT = 5; // "indefinite" — far enough that it never charges until resumed
const FOXY_API_HOST = 'api.foxycart.com';

/* Omnisend custom-event trigger (fires on cancel so an automation can email the
 * customer their cancellation details). Best-effort — never blocks the cancel.
 * Requires OMNISEND_API_KEY on THIS Netlify site (same key/scope as the order
 * sync: events.write). Matches the Events API used by foxy-order-sync.js. */
const OMNISEND_BASE = 'https://api.omnisend.com/api';
const OMNISEND_VERSION = '2026-03-15';
const CANCEL_EVENT_NAME = 'subscription cancelled';
const UPDATE_EVENT_NAME = 'subscription updated';

/* ── Webflow CMS (variant price guard) ──────────────────────────────────────
 * Foxy global HMAC cart validation is OFF for this store, so Foxy does NOT
 * validate item prices. When switching a variant we therefore look the price up
 * from the Webflow CMS ourselves and never trust a client-supplied price.
 * A Foxy line item's `code` equals the variant's `sku`; the item's `url` is the
 * parent product slug, whose `variants-options` list the switchable variants. */
const WEBFLOW_API = 'https://api.webflow.com/v2';
const WF_PRODUCTS_COLLECTION = '62a16d0c459d465de7ebf815';
const WF_VARIANTS_COLLECTION = '62a16e12370c3ef89e3c8c79';
const VARIANT_ATTR_SLUGS = ['strain', 'size', 'flavor', 'strength', 'type'];
const MAX_QUANTITY = 99;

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

/* ─── WEBFLOW CMS LOOKUPS (variant price guard) ─────────────────────────────── */

async function webflowGet(path) {
  const token = process.env.WEBFLOW_API_TOKEN || '';
  if (!token) throw new Error('WEBFLOW_API_TOKEN is not set — variant editing is unavailable.');
  const res = await httpsReq(WEBFLOW_API + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'accept': 'application/json' },
  });
  if (!res.ok) throw new Error('Webflow GET ' + path + ' failed (' + res.status + '): ' + (res.text || '').slice(0, 150));
  return res.json || {};
}

/* Product slug lives in the Foxy line item's `url` (e.g. "products/foo-bar"). */
function productSlugFromItem(item) {
  return String((item && item.url) || '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^.*\//, '');
}

async function wfGetProductBySlug(slug) {
  if (!slug) return null;
  const data = await webflowGet('/collections/' + WF_PRODUCTS_COLLECTION + '/items?slug=' + encodeURIComponent(slug));
  const items = (data && data.items) || [];
  // Guard against the API ignoring the slug filter: match exactly.
  return items.find((it) => it.fieldData && it.fieldData.slug === slug) || items[0] || null;
}

async function wfGetVariant(id) {
  const data = await webflowGet('/collections/' + WF_VARIANTS_COLLECTION + '/items/' + id);
  return (data && data.fieldData) ? data.fieldData : null;
}

/* Best human label for a variant: the first non-empty differentiator attribute,
 * else the variant name with the product-name prefix stripped. */
function variantLabel(fd, productName) {
  for (const slug of VARIANT_ATTR_SLUGS) {
    if (fd[slug]) return String(fd[slug]).trim();
  }
  let n = String(fd.name || '').trim();
  if (productName && n.indexOf(productName) === 0) {
    n = n.slice(productName.length).replace(/^[\s\-]+/, '').trim();
  }
  return n || fd.name || 'Option';
}

function variantPrice(fd) {
  return (fd['sale-price'] !== undefined && fd['sale-price'] !== null) ? fd['sale-price'] : fd.price;
}

function roundMoney(n) { return Math.round(Number(n) * 100) / 100; }

/* The subscription's effective discount (e.g. Green Dragon's 22% off → ~0.78)
 * derived from the CURRENT line item: its charged unit price ÷ the current
 * variant's CMS retail price. Applied to sibling variants so the dropdown shows
 * the real subscription price AND a flavor swap keeps the same discount instead
 * of jumping to full retail. Falls back to 1 (no discount) when it can't be
 * derived or would imply a markup (ratio > 1). */
function subDiscountRatio(item, variants) {
  const cur = variants.find((v) => String(v.code) === String(item.code));
  const retail = cur && Number(cur.price);
  const line = Number(item.price);
  if (retail > 0 && line > 0) {
    const r = line / retail;
    if (r > 0 && r <= 1.0001) return r;
  }
  return 1;
}

/* Load a product's variants (by the item's product slug) → normalized list. */
async function loadProductVariants(item) {
  const slug = productSlugFromItem(item);
  const product = await wfGetProductBySlug(slug);
  if (!product) return { product: null, productName: '', variants: [], variant_type: null };
  const productName = (product.fieldData && product.fieldData.name) || '';
  const ids = (product.fieldData && product.fieldData['variants-options']) || [];
  const variants = [];
  const attrsSeen = {};
  for (const id of ids) {
    let fd = null;
    try { fd = await wfGetVariant(id); } catch (_) { continue; }
    if (!fd || !fd.sku) continue;
    // Track which differentiator attributes the variants actually carry.
    VARIANT_ATTR_SLUGS.forEach((s) => { if (fd[s]) attrsSeen[s] = (attrsSeen[s] || 0) + 1; });
    variants.push({
      code: fd.sku,
      label: variantLabel(fd, productName),
      price: variantPrice(fd),
      image: (fd['primary-image'] && fd['primary-image'].url) || null,
      name: fd.name || null,
      in_stock: (fd.inventory === undefined || fd.inventory === null) ? true : fd.inventory > 0,
    });
  }
  // The attribute that differentiates these variants (flavor/size/strength/…),
  // so the UI can label the picker "Change Flavor", "Change Size", etc.
  let variant_type = null;
  for (const s of VARIANT_ATTR_SLUGS) { if (attrsSeen[s]) { variant_type = s; break; } }
  return { product, productName, variants, variant_type };
}

/* Find a subscription's transaction_template line item by its Foxy code. */
function findTemplateItem(sub, code) {
  const tt = sub._embedded && sub._embedded['fx:transaction_template'];
  const items = (tt && tt._embedded && tt._embedded['fx:items']) || [];
  return items.find((it) => String(it.code) === String(code)) || null;
}

/* Always rebuild a canonical admin item URL — never fetch a caller-supplied one. */
function toAdminItemUrl(href) {
  const m = /\/items\/(\d+)/.exec(String(href || ''));
  if (!m) throw new Error('Could not determine the item id to update.');
  return 'https://' + FOXY_API_HOST + '/items/' + m[1];
}

/* ─── SHIPPING RESTRICTIONS (address-change guard) ──────────────────────────
 * When a customer moves a subscription's SHIPPING address we must not let a
 * restricted product start shipping somewhere it's banned. The rules are the
 * SINGLE SOURCE OF TRUTH in Airtable → base "Website" → table "Shipping
 * Restrictions" (the same table the Foxy checkout shipping script's data comes
 * from), so there's no hardcoded copy to drift. Each row: Code (matches a line
 * item's `Restricted_Shipping_Code` option), State Restriction + State List,
 * Zip Restriction + Zip List, and an optional customer-facing Error Message.
 * Uses env AIRTABLE_API_KEY (Airtable REST API accepts a legacy key or a PAT as
 * a Bearer token; falls back to AIRTABLE_TOKEN). */
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || 'appWUsGD3byrYcN3l';
const AIRTABLE_SHIPPING_TABLE = process.env.AIRTABLE_SHIPPING_TABLE || 'tbljI90QZ7C6NWcxa';
const SHIP_RULES_TTL_MS = 10 * 60 * 1000; // cache across warm invocations
let _shipRulesCache = null;
let _shipRulesAt = 0;

/* Fetch + normalize the restriction rules from Airtable, cached for TTL. Shape:
 * { <code>: { name, states:[UPPER], zips:Set<number>, error } }. Throws on a
 * fetch/auth error so the caller can decide (we fail OPEN — see change-address). */
async function getShippingRestrictions() {
  if (_shipRulesCache && (Date.now() - _shipRulesAt) < SHIP_RULES_TTL_MS) return _shipRulesCache;
  const token = process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN || '';
  if (!token) throw new Error('AIRTABLE_API_KEY not set');
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_SHIPPING_TABLE}?pageSize=100`;
  const res = await httpsReq(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok || !res.json) throw new Error(`Airtable ${res.status}: ${(res.text || '').slice(0, 200)}`);
  const map = {};
  for (const rec of (res.json.records || [])) {
    const f = rec.fields || {};
    const code = String(f.Code || '').trim().toLowerCase();
    if (!code) continue;
    const states = (f['State Restriction'] && Array.isArray(f['State List']))
      ? f['State List'].map((s) => String(s).trim().toUpperCase()) : [];
    const zips = new Set();
    if (f['Zip Restriction'] && f['Zip List']) {
      String(f['Zip List']).split(/[\s,]+/).forEach((z) => { const n = Number(z); if (n > 0) zips.add(n); });
    }
    map[code] = { name: f.Name || code, states, zips, error: (f['Error Message'] || '').trim() };
  }
  _shipRulesCache = map;
  _shipRulesAt = Date.now();
  return map;
}

/* Returns a customer-facing error string if the new shipping locale bans any
 * restricted item on the subscription; '' when everything can ship there.
 * `rules` is the map from getShippingRestrictions(). Uses each rule's Airtable
 * Error Message when present, else a generated line. */
function shippingRestrictionError(items, region, postalRaw, rules) {
  rules = rules || {};
  const st = String(region || '').trim().toUpperCase();
  const postal = Number(String(postalRaw || '').replace(/\D/g, ''));
  const msgs = [];
  for (const item of (items || [])) {
    const opts = (item._embedded && item._embedded['fx:item_options']) || [];
    let restricted = false, codeStr = '';
    for (const o of opts) {
      if (o.name === 'Restricted_Shipping') restricted = true;
      else if (o.name === 'Restricted_Shipping_Code') codeStr = String(o.value || '');
    }
    if (!restricted || !codeStr) continue;
    for (const raw of codeStr.split(',')) {
      const rule = rules[raw.trim().toLowerCase()];
      if (!rule) continue;
      const stateHit = st && rule.states.includes(st);
      const zipHit = postal && rule.zips.has(postal);
      if (stateHit || zipHit) {
        msgs.push(rule.error ||
          (rule.name + ' (' + (item.name || 'item') + ') can’t ship to ' + (stateHit ? st : postal) + '.'));
      }
    }
  }
  if (!msgs.length) return '';
  const unique = msgs.filter((m, i) => msgs.indexOf(m) === i);
  return unique.join(' ') + ' or <a href="/contact">contact us</a> for help.';
}

/* ─── FOXY CUSTOMER-PORTAL JWT (authenticate the customer for SSO) ───────────
 * The portal stores a JWT signed (HS256) with the store's Customer Portal
 * "JWT shared secret". We verify that signature ourselves (env FOXY_JWT_SECRET)
 * and read the customer id from it, so a logged-in customer can be authenticated
 * at checkout WITHOUT relying on Foxy accepting the (often stale) JWT on its own
 * API — we just mint a fresh SSO token for the verified id. */
function b64urlToBuf(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function verifyPortalJwt(jwt, secret) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3 || !secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1])
    .digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8')); } catch (_) { return null; }
  if (payload && payload.exp && (Date.now() / 1000) > Number(payload.exp)) return null; // expired
  return payload;
}
function customerIdFromJwt(payload) {
  if (!payload) return null;
  const raw = payload.sub != null ? payload.sub
            : (payload.customer_id != null ? payload.customer_id
            : (payload.id != null ? payload.id : null));
  if (raw == null) return null;
  const s = String(raw);
  const m = s.indexOf('/customers/') !== -1 ? /\/customers\/(\d+)/.exec(s) : /^(\d+)$/.exec(s.trim());
  return (m && Number(m[1]) > 0) ? m[1] : null;
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

  const { action, subscription_uri, sub_token, frequency, address, address_type, item_code, quantity, variant_code } = body;

  const VALID = ['ship-now', 'skip', 'set-frequency', 'pause', 'resume', 'restart', 'change-address', 'cancel',
                 'list-variants', 'set-quantity', 'set-variant', 'get-payment-url', 'sso-guest', 'sso-customer'];
  const ITEM_ACTIONS = ['list-variants', 'set-quantity', 'set-variant'];
  if (!VALID.includes(action)) return resp(400, { error: 'Unknown action: ' + action });

  // Guest SSO: store-level SSO routes EVERY checkout through our /sso endpoint,
  // and Foxy loops on a token-less return. For a NON-payment-update checkout we
  // mint a GUEST token (fc_customer_id=0) so Foxy lets the customer straight
  // through to checkout (Foxy's documented "allow guest" path). A guest token
  // grants no account access, so this needs no sub_token/ownership check.
  if (action === 'sso-guest') {
    const secret = process.env.FOXY_SSO_SECRET || '';
    if (!secret) return resp(500, { error: 'SSO not configured (missing secret).' });
    const origin = String((body && body.checkout_origin) || '').replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+\.foxycart\.com$/i.test(origin) &&
        origin !== 'https://secure.thegreendragoncbd.com') {
      return resp(400, { error: 'Invalid checkout origin.' });
    }
    const ts = Math.floor(Date.now() / 1000) + 3600; // future expiry
    const authToken = crypto.createHash('sha1').update('0|' + ts + '|' + secret).digest('hex');
    const fcsid = String((body && body.fcsid) || '').trim();
    let url = origin + '/checkout?fc_customer_id=0&timestamp=' + ts + '&fc_auth_token=' + authToken;
    if (/^[A-Za-z0-9]+$/.test(fcsid)) url += '&fcsid=' + fcsid;
    return resp(200, { success: true, url: url });
  }

  // Logged-in customer SSO: verify the portal JWT (signed with the Customer
  // Portal JWT shared secret) ourselves and mint a token for that REAL customer
  // id, so a customer who's already signed in isn't asked to log in again at
  // checkout. The /sso page falls back to sso-guest if this errors (JWT missing,
  // stale, or unverifiable).
  if (action === 'sso-customer') {
    const secret = process.env.FOXY_SSO_SECRET || '';
    const jwtSecret = process.env.FOXY_JWT_SECRET || '';
    if (!secret || !jwtSecret) return resp(500, { error: 'SSO not configured (missing secret).' });
    const origin = String((body && body.checkout_origin) || '').replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+\.foxycart\.com$/i.test(origin) &&
        origin !== 'https://secure.thegreendragoncbd.com') {
      return resp(400, { error: 'Invalid checkout origin.' });
    }
    const payload = verifyPortalJwt(body && body.jwt, jwtSecret);
    if (!payload) return resp(401, { error: 'Invalid or expired session token.' });
    const customerId = customerIdFromJwt(payload);
    if (!customerId) return resp(400, { error: 'Could not read customer id from session token.' });
    const ts = Math.floor(Date.now() / 1000) + 3600;
    const authToken = crypto.createHash('sha1').update(customerId + '|' + ts + '|' + secret).digest('hex');
    const fcsid = String((body && body.fcsid) || '').trim();
    let url = origin + '/checkout?fc_customer_id=' + customerId + '&timestamp=' + ts + '&fc_auth_token=' + authToken;
    if (/^[A-Za-z0-9]+$/.test(fcsid)) url += '&fcsid=' + fcsid;
    return resp(200, { success: true, url: url });
  }

  if (!subscription_uri || !sub_token) return resp(400, { error: 'Missing subscription_uri or sub_token' });

  // SSRF guard + normalization. The portal exposes the subscription's self link
  // on the *store* customer API (e.g. tgd-test.foxycart.com/s/customer/
  // subscriptions/777700), but we operate via the admin hAPI. Accept any
  // foxycart.com URL, pull out the numeric subscription id, and always rebuild
  // the canonical admin URL ourselves — we never fetch a caller-supplied URL.
  let parsed;
  try {
    parsed = new URL(subscription_uri);
  } catch (_) {
    return resp(400, { error: 'Invalid subscription_uri' });
  }
  if (!/(^|\.)foxycart\.com$/.test(parsed.hostname)) {
    return resp(400, { error: 'subscription_uri must be a foxycart.com URL' });
  }
  var idMatch = /\/subscriptions\/(\d+)/.exec(parsed.pathname);
  if (!idMatch) {
    return resp(400, { error: 'Could not find a subscription id in subscription_uri' });
  }
  var adminSubUrl = 'https://' + FOXY_API_HOST + '/subscriptions/' + idMatch[1];

  if (action === 'set-frequency' && !ALLOWED_FREQUENCIES.includes(frequency)) {
    return resp(400, { error: 'frequency must be one of ' + ALLOWED_FREQUENCIES.join(', ') });
  }
  if (action === 'change-address' && (!address || typeof address !== 'object')) {
    return resp(400, { error: 'change-address requires an address object' });
  }
  if (ITEM_ACTIONS.includes(action) && !item_code) {
    return resp(400, { error: action + ' requires item_code' });
  }

  try {
    const token = await getAccessToken();
    const authHeaders = { 'Authorization': `Bearer ${token}`, 'FOXY-API-VERSION': '1' };

    // 1. Fetch the subscription. Zoom the transaction_template items so the
    //    item-editing actions can find the line to modify. (Foxy zoom only goes
    //    2 levels deep, so item_options can't be embedded here — change-address
    //    fetches those separately from the template.)
    const subRes = await httpsReq(adminSubUrl + '?zoom=transaction_template:items', { headers: authHeaders });
    const sub = subRes.json;
    if (!sub || !sub._links) {
      throw new Error(`Could not load subscription (${subRes.status}): ${subRes.text.slice(0, 200)}`);
    }

    // 2. Verify the caller actually owns this subscription.
    const realToken = tokenFromSubTokenUrl(sub);
    if (!realToken) {
      console.warn('[manage] no fx:sub_token_url on admin resource; links:', Object.keys(sub._links || {}));
      return resp(500, { error: 'Could not verify subscription ownership (token link missing).' });
    }
    if (realToken !== sub_token) {
      console.warn('[manage] sub_token mismatch for', adminSubUrl);
      return resp(403, { error: 'Not authorized for this subscription' });
    }

    const patchHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

    // 3. Perform the action.

    // Payment-card update: mint a fresh, server-SIGNED Foxy SSO checkout URL so
    // the customer lands on an authenticated "update info" checkout. This
    // replaces the flaky client-side portal JWT (which 401s once it goes stale
    // and then bounces to the /sso endpoint). The caller is already verified
    // above via sub_token ownership; we read the customer id off the sub and
    // sign fc_auth_token = sha1(customerId|timestamp|secret) with a future
    // expiry (per Foxy SSO). Since the token is always valid, Foxy establishes
    // the session and never redirects to /sso.
    if (action === 'get-payment-url') {
      const secret = process.env.FOXY_SSO_SECRET || '';
      if (!secret) return resp(500, { error: 'Payment update is not configured (missing SSO secret).' });
      const custHref = (sub._links['fx:customer'] && sub._links['fx:customer'].href) || '';
      const cm = /\/customers\/(\d+)/.exec(custHref);
      if (!cm) return resp(500, { error: 'Could not determine the customer for this subscription.' });
      const customerId = cm[1];
      // The checkout origin comes from the client (the portal's base origin) so
      // this works on both the test and production stores; restrict it to Foxy
      // domains / the store's secure domain to avoid signing a foreign URL.
      const origin = String((body && body.checkout_origin) || '').replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+\.foxycart\.com$/i.test(origin) &&
          origin !== 'https://secure.thegreendragoncbd.com') {
        return resp(400, { error: 'Invalid checkout origin.' });
      }
      const ts = Math.floor(Date.now() / 1000) + 3600; // must be a FUTURE expiry
      const authToken = crypto.createHash('sha1')
        .update(customerId + '|' + ts + '|' + secret).digest('hex');
      // This is the Foxy SSO handshake RESPONSE. The customer hit
      // /cart?cart=updateinfo (unauthenticated), Foxy bounced them to the /sso
      // endpoint with an fcsid, and /sso calls us to mint the token. Redirect
      // back to /checkout with the token + the SAME fcsid so Foxy authenticates
      // the session and RESUMES its pending cart=updateinfo request → the
      // checkout loads in update-info mode (is_updateinfo=true).
      const fcsid = String((body && body.fcsid) || '').trim();
      let url = origin + '/checkout?fc_customer_id=' + customerId +
                '&timestamp=' + ts + '&fc_auth_token=' + authToken;
      if (/^[A-Za-z0-9]+$/.test(fcsid)) url += '&fcsid=' + fcsid;
      return resp(200, { success: true, url: url });
    }

    if (action === 'change-address') {
      const ttHref = sub._links['fx:transaction_template'] && sub._links['fx:transaction_template'].href;
      if (!ttHref) throw new Error('Subscription has no transaction_template link');
      const tt = (sub._embedded && sub._embedded['fx:transaction_template']) || {};
      const type = (address_type === 'billing') ? 'billing' : 'shipping';
      // Guard: don't let a restricted product start shipping to a banned
      // state/ZIP. Billing changes don't affect where it ships, so skip them.
      if (type === 'shipping') {
        // Item options aren't embedded on the subscription (zoom depth limit),
        // so fetch the template's items WITH their options (2-level zoom on the
        // template) to read each line's Restricted_Shipping_Code. Fail open on
        // any fetch error so a lookup hiccup never blocks a legitimate change.
        let ttItems = [];
        try {
          const itemsRes = await httpsReq(ttHref + '?zoom=items:item_options', { headers: authHeaders });
          ttItems = (itemsRes.json && itemsRes.json._embedded && itemsRes.json._embedded['fx:items']) || [];
        } catch (e) { console.warn('[manage] restriction items fetch failed:', e && e.message); }
        // Rules come from Airtable (cached). If that lookup fails, FAIL OPEN
        // (allow the change) rather than block a legit edit — the Foxy checkout
        // shipping script is still the hard enforcement at charge time.
        let rules = {};
        try { rules = await getShippingRestrictions(); }
        catch (e) { console.warn('[manage] shipping rules fetch failed, allowing change:', e && e.message); }
        const restrictErr = shippingRestrictionError(ttItems, address.region, address.postal_code, rules);
        if (restrictErr) return resp(422, { error: restrictErr, restricted: true });
      }
      const patchBody = buildAddressPatch(address, type, tt);
      const r = await patchOrThrow(ttHref, patchHeaders, patchBody, type + '-address');
      await finishWithEvent(action, adminSubUrl, authHeaders, idMatch[1], { address_type: type });
      return resp(200, { success: true, action, applied: patchBody, status: r.status });
    }

    if (action === 'cancel') {
      /* Cancel by setting end_date to TOMORROW: the subscription stays active
       * through today, ends the next day, and never bills again — Foxy does not
       * process a transaction on/after end_date, so the upcoming charge is
       * skipped and it stops renewing. (A bare "YYYY-MM-DD" for *today* is
       * rejected 400 because end_date must be in the future; tomorrow is valid.
       * We send a full datetime to match Foxy's accepted format.) The 'restart'
       * action clears end_date. */
      const end = tomorrow() + 'T00:00:00Z';
      const r = await patchOrThrow(adminSubUrl, patchHeaders, { end_date: end }, 'cancel');
      await finishWithEvent('cancel', adminSubUrl, authHeaders, idMatch[1], { end_date: end });
      return resp(200, { success: true, action, applied: { end_date: end }, status: r.status });
    }

    /* ── Item editing: quantity + variant changes on the transaction_template ── */
    if (ITEM_ACTIONS.includes(action)) {
      const item = findTemplateItem(sub, item_code);
      if (!item) return resp(404, { error: 'That item is no longer on this subscription. Please refresh.' });

      if (action === 'list-variants') {
        const { variants, variant_type } = await loadProductVariants(item);
        const ratio = subDiscountRatio(item, variants);
        const priced = variants.map((v) => Object.assign({}, v, {
          sub_price: (v.price != null) ? roundMoney(v.price * ratio) : null,
        }));
        return resp(200, { success: true, current_code: item.code, quantity: item.quantity, variants: priced, discount_ratio: ratio, variant_type });
      }

      if (action === 'set-quantity') {
        const q = parseInt(quantity, 10);
        if (!(q >= 1 && q <= MAX_QUANTITY)) return resp(400, { error: 'Quantity must be between 1 and ' + MAX_QUANTITY + '.' });
        const itemUrl = toAdminItemUrl(item._links && item._links.self && item._links.self.href);
        const r = await patchOrThrow(itemUrl, patchHeaders, { quantity: q }, 'set-quantity');
        await finishWithEvent(action, adminSubUrl, authHeaders, idMatch[1], { quantity: q });
        return resp(200, { success: true, action, applied: { quantity: q }, status: r.status });
      }

      // set-variant — swap to a sibling variant of the SAME product. Price is
      // read from the CMS (never the client) since Foxy HMAC validation is off.
      if (!variant_code) return resp(400, { error: 'set-variant requires variant_code' });
      const { productName, variants } = await loadProductVariants(item);
      const target = variants.find((v) => String(v.code) === String(variant_code));
      if (!target) return resp(400, { error: 'That option isn\'t available for this product.' });
      if (!target.in_stock) return resp(400, { error: 'That option is out of stock.' });

      // Preserve the subscription's discount: charge the sibling variant at the
      // same effective ratio as the current line, not full CMS retail.
      const ratio = subDiscountRatio(item, variants);
      const itemUrl = toAdminItemUrl(item._links && item._links.self && item._links.self.href);
      const patch = { code: target.code, name: target.name || (productName + ' - ' + target.label), price: roundMoney(target.price * ratio) };
      if (target.image) patch.image = target.image;
      const r = await patchOrThrow(itemUrl, patchHeaders, patch, 'set-variant');
      await finishWithEvent(action, adminSubUrl, authHeaders, idMatch[1], { code: patch.code, name: patch.name, price: patch.price });
      return resp(200, { success: true, action, applied: patch, status: r.status });
    }

    let patchBody;
    if (action === 'ship-now')        patchBody = { next_transaction_date: tomorrow() };
    else if (action === 'resume')     patchBody = { next_transaction_date: tomorrow() };
    else if (action === 'restart') {
      /* Un-cancel: clear the end_date and reactivate. Keep the existing next
       * charge date if it's still in the future (preserve the normal cadence);
       * otherwise fall back to tomorrow so a stale/past date doesn't strand it. */
      const t = tomorrow();
      const next = (sub.next_transaction_date || '').slice(0, 10);
      patchBody = { end_date: '', is_active: true, next_transaction_date: (next && next >= t) ? next : t };
    }
    else if (action === 'pause')      patchBody = { next_transaction_date: farFuture() };
    else if (action === 'set-frequency') patchBody = { frequency };
    else if (action === 'skip')       patchBody = { next_transaction_date: addFrequency(sub.next_transaction_date, sub.frequency) };

    const r = await patchOrThrow(adminSubUrl, patchHeaders, patchBody, action);
    await finishWithEvent(action, adminSubUrl, authHeaders, idMatch[1], patchBody);
    return resp(200, { success: true, action, applied: patchBody, status: r.status });

  } catch (err) {
    console.error('[manage] ERROR:', err.message);
    return resp(500, { error: err.message });
  }
};

/* ─── HELPERS ───────────────────────────────────────────────────────────────── */

/* Build a COMPLETE shipping_* + billing_* address patch.
 *
 * The subscription's transaction_template has a linked customer_uri, so Foxy
 * re-populates any shipping_ or billing_ field left out of the PATCH from the
 * customer's address book — which silently reverted our partial edits (only
 * the changed type, missing company/phone). Per Foxy's transaction_template
 * docs we must set ALL shipping_* and billing_* fields in the same request.
 *
 * We therefore start from the template's CURRENT values (so the untouched
 * address type and fields like company/phone are preserved verbatim) and
 * override only the fields the customer actually edited on the requested type. */
function buildAddressPatch(a, type, currentTemplate) {
  const tt = currentTemplate || {};
  const FIELDS = ['first_name', 'last_name', 'company', 'address1', 'address2',
                  'city', 'state', 'postal_code', 'country', 'phone'];
  // Our form field name → Foxy suffix (only `region` differs → `state`).
  const FROM = {
    first_name: 'first_name', last_name: 'last_name', company: 'company',
    address1: 'address1', address2: 'address2', city: 'city',
    region: 'state', postal_code: 'postal_code', country: 'country', phone: 'phone',
  };

  const out = {};
  // Seed BOTH addresses from the template's current values so a linked
  // customer_uri can't overwrite anything we don't explicitly send.
  ['shipping_', 'billing_'].forEach((p) => {
    FIELDS.forEach((f) => { out[p + f] = (tt[p + f] != null) ? String(tt[p + f]) : ''; });
  });

  // Override the requested type with the supplied (edited) values.
  const prefix = (type === 'billing') ? 'billing_' : 'shipping_';
  let any = false;
  Object.keys(FROM).forEach((k) => {
    if (a[k] !== undefined && a[k] !== null) { out[prefix + FROM[k]] = String(a[k]); any = true; }
  });
  if (!any) throw new Error('No recognized address fields supplied');
  return out;
}

async function patchOrThrow(url, headers, bodyObj, label) {
  console.log(`[manage] PATCH (${label}):`, url, '| body:', JSON.stringify(bodyObj));
  const r = await httpsReq(url, { method: 'PATCH', headers }, bodyObj);
  console.log(`[manage] PATCH (${label}) status:`, r.status, (r.text || '').slice(0, 500));
  if (!r.ok) {
    // Prefer Foxy's human-readable validation messages if present.
    let detail = (r.text || '').slice(0, 500);
    try {
      const j = JSON.parse(r.text);
      const msgs = j && j._embedded && j._embedded['fx:errors'];
      if (Array.isArray(msgs) && msgs.length) {
        detail = msgs.map((e) => e.message || e).join('; ');
      } else if (j && j.message) {
        detail = j.message;
      }
    } catch (_) { /* keep raw slice */ }
    throw new Error(`PATCH ${label} failed (${r.status}): ${detail}`);
  }
  return r;
}

/* ─── OMNISEND CUSTOMER-EMAIL EVENTS ────────────────────────────────────────
 * After a successful change we fire a custom Omnisend event so an automation can
 * email the customer: `subscription cancelled` on cancel, `subscription updated`
 * on every other mutating action (ship-now, skip, frequency, quantity, variant,
 * address, resume, restart). Best-effort — a missing key, missing email, or a
 * failed call is logged and swallowed so the subscription change still succeeds.
 * Requires OMNISEND_API_KEY (events.write) on this Netlify site. */

function customerEmailFrom(sub) {
  const cust = (sub && sub._embedded && sub._embedded['fx:customer']) || {};
  const tt = (sub && sub._embedded && sub._embedded['fx:transaction_template']) || {};
  return cust.email || tt.customer_email || '';
}

/* Snapshot of the subscription's details for the email template. */
function subDetails(sub, subId) {
  const s = sub || {};
  const tt = (s._embedded && s._embedded['fx:transaction_template']) || {};
  const cust = (s._embedded && s._embedded['fx:customer']) || {};
  const items = (tt._embedded && tt._embedded['fx:items']) || [];
  const first = items[0] || {};
  const addr = (pfx) => ({
    name: ((tt[pfx + 'first_name'] || '') + ' ' + (tt[pfx + 'last_name'] || '')).trim(),
    address1: tt[pfx + 'address1'] || '',
    address2: tt[pfx + 'address2'] || '',
    city: tt[pfx + 'city'] || '',
    state: tt[pfx + 'state'] || '',
    postalCode: tt[pfx + 'postal_code'] || '',
    country: tt[pfx + 'country'] || '',
  });
  return {
    subscriptionID: String(subId),
    productName: first.name || 'your subscription',
    quantity: (first.quantity != null) ? first.quantity : '',
    price: (first.price != null) ? first.price : '',
    frequency: s.frequency || '',
    nextChargeDate: String(s.next_transaction_date || '').slice(0, 10),
    endDate: String(s.end_date || '').slice(0, 10),
    isActive: s.is_active !== false,
    firstName: cust.first_name || '',
    lastName: cust.last_name || '',
    lineItems: items.map((it) => ({
      productID: String(it.code || it.id || ''),
      productTitle: it.name,
      quantity: it.quantity,
      price: Number(it.price) || 0,
      image: it.image || undefined,
    })),
    shippingAddress: addr('shipping_'),
    billingAddress: addr('billing_'),
  };
}

/* POST a custom event to Omnisend. Throws only on network error (callers wrap). */
async function fireOmnisendEvent(eventName, email, properties) {
  const apiKey = process.env.OMNISEND_API_KEY;
  if (!apiKey) { console.warn(`[manage] OMNISEND_API_KEY not set — skipping "${eventName}" event`); return; }
  if (!email) { console.warn(`[manage] no customer email — skipping "${eventName}" event`); return; }
  const res = await httpsReq(OMNISEND_BASE + '/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Omnisend-API-Key ' + apiKey,
      'Omnisend-Version': OMNISEND_VERSION,
    },
  }, {
    eventName,
    origin: 'api',
    eventTime: new Date().toISOString(),
    contact: { email },
    properties: properties || {},
  });
  if (!res.ok) console.error(`[manage] Omnisend "${eventName}" failed`, res.status, (res.text || '').slice(0, 300));
  else console.log(`[manage] Omnisend "${eventName}" sent for`, email);
}

/* Re-fetch the subscription fresh (so the event reflects the POST-update state)
 * and fire the matching Omnisend event. Never throws. */
async function finishWithEvent(action, adminSubUrl, authHeaders, subId, applied) {
  try {
    const eventName = (action === 'cancel') ? CANCEL_EVENT_NAME : UPDATE_EVENT_NAME;
    let fresh = null;
    try {
      const r = await httpsReq(adminSubUrl + '?zoom=transaction_template:items,customer', { headers: authHeaders });
      fresh = r.json;
    } catch (_) { /* fire with whatever we have */ }
    const props = subDetails(fresh, subId);
    props.action = action;
    if (applied) props.applied = applied;
    await fireOmnisendEvent(eventName, customerEmailFrom(fresh), props);
  } catch (e) {
    console.error('[manage] finishWithEvent error:', e.message);
  }
}

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
