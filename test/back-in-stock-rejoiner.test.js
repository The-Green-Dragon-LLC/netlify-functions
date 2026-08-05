/**
 * BACK-IN-STOCK → REJOINER conversion tests
 *
 * Verifies the two BIS functions talk to Rejoiner with the shapes confirmed
 * against the live API, without touching Airtable, Rejoiner, or Foxy.
 *
 * The Rejoiner contract under test (all verified live, Aug 2026):
 *   - journey trigger: POST /api/v2/{site}/journeys/{id}/webhook_trigger/
 *   - body is { email, session_data }              — NOT { metadata }
 *   - Authorization: Rejoiner {key}
 *   - unknown address → 404 "No customer was found with email ..." so the
 *     customer profile must be created first, then the trigger retried
 *
 * Run: node test/back-in-stock-rejoiner.test.js
 */

const https = require('https');
const { EventEmitter } = require('events');
const path = require('path');

/* ─── Fake HTTPS layer ────────────────────────────────────────────────────── */
// lib/rejoiner.js and the BIS functions both use https.request, so intercepting
// it captures every outbound call regardless of which module made it.
const captured = [];
let routes = [];

function route(matcher, status, bodyObj) {
  routes.push({ matcher, status, bodyObj });
}

const realRequest = https.request;
https.request = function fakeRequest(options, cb) {
  const url = `https://${options.hostname}${options.path}`;
  const req = new EventEmitter();
  let sent = '';
  req.write = (chunk) => { sent += chunk; };
  req.end = () => {
    const entry = { url, method: options.method || 'GET', headers: options.headers || {}, body: null };
    try { entry.body = sent ? JSON.parse(sent) : null; } catch (_) { entry.body = sent; }
    captured.push(entry);

    const hit = routes.find((r) => r.matcher(url, entry)) || { status: 200, bodyObj: {} };
    const res = new EventEmitter();
    res.statusCode = hit.status;
    process.nextTick(() => {
      res.emit('data', Buffer.from(JSON.stringify(hit.bodyObj ?? {})));
      res.emit('end');
    });
    cb(res);
  };
  return req;
};

/* ─── Harness ─────────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
function reset() { captured.length = 0; routes = []; }
const rj = (u) => u.includes('rj2.rejoiner.com');
const trig = (u) => u.includes('/webhook_trigger/');
const cust = (u) => u.includes('/customers/');

process.env.AIRTABLE_API_KEY = 'fake-airtable';
process.env.REJOINER_API_KEY = 'fake-rj-key';
process.env.REJOINER_SITE_ID = 'ZLZZEJL';
process.env.REJOINER_BIS_SIGNUP_JOURNEY = 'SIGNUPJ';
process.env.REJOINER_BIS_ALERT_JOURNEY = 'ALERTJ';

const P = (f) => path.join(__dirname, '..', 'functions', f);
const subscribe = require(P('back-in-stock-subscribe.js')).handler;
const notify = require(P('back-in-stock-notify.js')).handler;

const SIGNUP_BODY = {
  email: 'Shopper@Example.COM',
  code: 'recABCDEFGHIJKLMN',
  name: 'Chapo Extrax Blanco Gummies',
  variantLabel: 'Blue Razz',
  url: 'https://thegreendragoncbd.com/product/chapo',
  image: 'https://cdn/img.jpg',
  price: 39.99,
  itemType: 'Variant',
};

(async () => {
  /* ── 1. Signup triggers the Rejoiner confirmation journey ─────────────── */
  console.log('\n[1] Signup → Rejoiner confirmation journey');
  reset();
  route((u) => u.includes('api.airtable.com') && !u.includes('filterByFormula'), 200, { id: 'recNEW' });
  route((u) => u.includes('filterByFormula'), 200, { records: [] }); // no dupe
  route(rj, 200, {});

  let r = await subscribe({ httpMethod: 'POST', headers: {}, body: JSON.stringify(SIGNUP_BODY) });
  const t = captured.find((c) => trig(c.url));
  check('200 OK', r.statusCode === 200, JSON.stringify(r));
  check('journey trigger called', !!t, captured.map((c) => c.url).join(' | '));
  check('correct signup journey id', t?.url.includes('/journeys/SIGNUPJ/webhook_trigger/'), t?.url);
  check('uses /api/v2/{site}/', t?.url.includes('/api/v2/ZLZZEJL/'), t?.url);
  check('Authorization: Rejoiner <key>', t?.headers.Authorization === 'Rejoiner fake-rj-key');
  check('body has email (lowercased)', t?.body.email === 'shopper@example.com', JSON.stringify(t?.body));
  check('body uses session_data, NOT metadata',
    !!t?.body.session_data && !('metadata' in (t?.body || {})), JSON.stringify(t?.body));
  check('no Omnisend call anywhere', !captured.some((c) => c.url.includes('omnisend')));

  const sd = t?.body.session_data || {};
  check('session_data.product_code', sd.product_code === 'recABCDEFGHIJKLMN');
  check('session_data.product_name', sd.product_name === 'Chapo Extrax Blanco Gummies');
  check('session_data.variant_label', sd.variant_label === 'Blue Razz');
  check('session_data.product_title joins name + variant',
    sd.product_title === 'Chapo Extrax Blanco Gummies — Blue Razz', sd.product_title);
  check('session_data.price is a number in dollars', sd.price === 39.99, String(sd.price));
  check('session_data.price_formatted is display-ready', sd.price_formatted === '$39.99', sd.price_formatted);

  /* ── 2. Unknown address: create profile, then retry the trigger ────────── */
  console.log('\n[2] Unknown customer → upsert profile, retry trigger');
  reset();
  route((u) => u.includes('filterByFormula'), 200, { records: [] });
  route((u) => u.includes('api.airtable.com'), 200, { id: 'recNEW' });
  let triggerCalls = 0;
  route(trig, undefined, undefined); // placeholder replaced below
  routes = routes.filter((x) => x.matcher !== trig);
  routes.push({
    matcher: (u) => trig(u),
    get status() { return ++triggerCalls === 1 ? 404 : 200; },
    get bodyObj() {
      return triggerCalls === 1
        ? { error: 'No customer was found with email shopper@example.com' }
        : {};
    },
  });
  route(cust, 200, { id: 'cust1' });

  r = await subscribe({ httpMethod: 'POST', headers: {}, body: JSON.stringify(SIGNUP_BODY) });
  const trigs = captured.filter((c) => trig(c.url));
  const custs = captured.filter((c) => cust(c.url));
  check('signup still returns 200', r.statusCode === 200, JSON.stringify(r));
  check('customer profile was created', custs.length === 1, `saw ${custs.length}`);
  check('profile POST carries the email', custs[0]?.body.email === 'shopper@example.com');
  check('trigger retried exactly once after the 404', trigs.length === 2, `saw ${trigs.length}`);

  /* ── 3. Rejoiner failure must NOT fail the signup ──────────────────────── */
  console.log('\n[3] Rejoiner down → signup still succeeds (Airtable is the record)');
  reset();
  route((u) => u.includes('filterByFormula'), 200, { records: [] });
  route((u) => u.includes('api.airtable.com'), 200, { id: 'recNEW' });
  route(rj, 500, { error: 'boom' });
  r = await subscribe({ httpMethod: 'POST', headers: {}, body: JSON.stringify(SIGNUP_BODY) });
  check('200 despite Rejoiner 500', r.statusCode === 200, JSON.stringify(r));

  /* ── 4. Opt-in gating ─────────────────────────────────────────────────── */
  console.log('\n[4] Marketing opt-in is gated on the checkbox');
  reset();
  route((u) => u.includes('filterByFormula'), 200, { records: [] });
  route((u) => u.includes('api.airtable.com'), 200, { id: 'recNEW' });
  route(rj, 200, {});
  await subscribe({ httpMethod: 'POST', headers: {}, body: JSON.stringify(SIGNUP_BODY) });
  check('no opt_in call when unchecked', !captured.some((c) => c.url.includes('/opt_in/')));
  check('no list add when unchecked', !captured.some((c) => c.url.includes('/contacts/')));

  reset();
  route((u) => u.includes('filterByFormula'), 200, { records: [] });
  route((u) => u.includes('api.airtable.com'), 200, { id: 'recNEW' });
  route(rj, 200, {});
  process.env.REJOINER_BIS_LIST_ID = 'LIST123';
  delete require.cache[require.resolve(P('back-in-stock-subscribe.js'))];
  const subscribe2 = require(P('back-in-stock-subscribe.js')).handler;
  await subscribe2({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ ...SIGNUP_BODY, optIn: true }) });
  check('opt_in recorded when checked', captured.some((c) => c.url.includes('/customer/opt_in/')));
  check('added to configured list', captured.some((c) => c.url.includes('/lists/LIST123/contacts/')));
  const add = captured.find((c) => c.url.includes('/lists/LIST123/contacts/'));
  check('list add nests under customer{}', add?.body?.customer?.email === 'shopper@example.com',
    JSON.stringify(add?.body));

  /* ── 5. Notifier: restocked item alerts + marks Notified ──────────────── */
  console.log('\n[5] Notifier → alert journey for restocked item');
  reset();
  const pendingRow = {
    id: 'recROW1',
    fields: {
      Email: 'shopper@example.com', 'Product Code': 'recABCDEFGHIJKLMN',
      'Product Name': 'Chapo Extrax Blanco Gummies', 'Variant Label': 'Blue Razz',
      'Product URL': 'https://x/y', 'Image URL': 'https://cdn/i.jpg',
      Price: 39.99, 'Requested At': '2026-07-01T12:00:00.000Z', Status: 'Pending',
    },
  };
  route((u) => u.includes('filterByFormula') && u.includes('Pending'), 200, { records: [pendingRow] });
  route((u) => u.includes(`/${'tblEtb1aIH5Xk4Nh9'}/recABCDEFGHIJKLMN`), 200,
    { fields: { Inventory: 12 } });                       // back in stock
  route((u) => u.includes('api.airtable.com'), 200, { id: 'recROW1' }); // PATCH mark
  route(rj, 200, {});

  r = await notify({ httpMethod: 'GET', queryStringParameters: {} });
  const at = captured.find((c) => trig(c.url));
  const patch = captured.find((c) => c.method === 'PATCH');
  check('sweep ok', r.statusCode === 200, r.body);
  check('notified 1', JSON.parse(r.body).notified === 1, r.body);
  check('correct alert journey id', at?.url.includes('/journeys/ALERTJ/webhook_trigger/'), at?.url);
  check('body uses session_data', !!at?.body.session_data && !('metadata' in (at?.body || {})));
  check('session_data.inventory passed through', at?.body.session_data.inventory === 12);
  check('session_data.requested_at passed through',
    at?.body.session_data.requested_at === '2026-07-01T12:00:00.000Z');
  check('session_data.requested_date is human-readable',
    at?.body.session_data.requested_date === 'July 1, 2026', at?.body.session_data.requested_date);
  check('session_data.price_formatted on the alert too',
    at?.body.session_data.price_formatted === '$39.99', at?.body.session_data.price_formatted);
  check('row marked Notified', patch?.body?.fields?.Status === 'Notified', JSON.stringify(patch?.body));

  /* ── 6. Notifier: alert fails → row stays Pending ─────────────────────── */
  console.log('\n[6] Alert fails → row must stay Pending for the next sweep');
  reset();
  route((u) => u.includes('filterByFormula') && u.includes('Pending'), 200, { records: [pendingRow] });
  route((u) => u.includes('/tblEtb1aIH5Xk4Nh9/recABCDEFGHIJKLMN'), 200, { fields: { Inventory: 12 } });
  route(rj, 500, { error: 'nope' });
  route((u) => u.includes('api.airtable.com'), 200, {});
  r = await notify({ httpMethod: 'GET', queryStringParameters: {} });
  const body6 = JSON.parse(r.body);
  check('nothing marked notified', body6.notified === 0, r.body);
  check('counted as an error', body6.errors === 1, r.body);
  check('NO PATCH issued (stays Pending)', !captured.some((c) => c.method === 'PATCH'));

  /* ── 7. Notifier: still out of stock → no alert ───────────────────────── */
  console.log('\n[7] Still out of stock → no alert, no mark');
  reset();
  route((u) => u.includes('filterByFormula') && u.includes('Pending'), 200, { records: [pendingRow] });
  route((u) => u.includes('/tblEtb1aIH5Xk4Nh9/recABCDEFGHIJKLMN'), 200, { fields: { Inventory: 0 } });
  route((u) => u.includes('api.airtable.com'), 200, {});
  r = await notify({ httpMethod: 'GET', queryStringParameters: {} });
  check('stillOut 1, notified 0', JSON.parse(r.body).stillOut === 1 && JSON.parse(r.body).notified === 0, r.body);
  check('no journey trigger', !captured.some((c) => trig(c.url)));

  /* ── 8. Discontinued item never alerts ────────────────────────────────── */
  console.log('\n[8] Discontinued item never alerts even when in stock');
  reset();
  route((u) => u.includes('filterByFormula') && u.includes('Pending'), 200, { records: [pendingRow] });
  route((u) => u.includes('/tblEtb1aIH5Xk4Nh9/recABCDEFGHIJKLMN'), 200,
    { fields: { Inventory: 50, Discontinued: true } });
  route((u) => u.includes('api.airtable.com'), 200, {});
  r = await notify({ httpMethod: 'GET', queryStringParameters: {} });
  check('counted discontinued', JSON.parse(r.body).discontinued === 1, r.body);
  check('no journey trigger', !captured.some((c) => trig(c.url)));

  /* ── 9. Missing journey config degrades safely ────────────────────────── */
  console.log('\n[9] Unconfigured journey id → no send, row stays Pending');
  reset();
  delete process.env.REJOINER_BIS_ALERT_JOURNEY;
  delete require.cache[require.resolve(P('back-in-stock-notify.js'))];
  const notify2 = require(P('back-in-stock-notify.js')).handler;
  route((u) => u.includes('filterByFormula') && u.includes('Pending'), 200, { records: [pendingRow] });
  route((u) => u.includes('/tblEtb1aIH5Xk4Nh9/recABCDEFGHIJKLMN'), 200, { fields: { Inventory: 12 } });
  route((u) => u.includes('api.airtable.com'), 200, {});
  r = await notify2({ httpMethod: 'GET', queryStringParameters: {} });
  check('no crash', r.statusCode === 200, r.body);
  check('nothing notified', JSON.parse(r.body).notified === 0, r.body);
  check('no PATCH (stays Pending)', !captured.some((c) => c.method === 'PATCH'));

  https.request = realRequest;
  console.log(`\n──────────────\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
