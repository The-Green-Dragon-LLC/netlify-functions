/**
 * SUBSCRIPTION EMAILS → REJOINER conversion tests
 *
 * manage-subscription.js now starts a Rejoiner webhook journey instead of firing
 * an Omnisend event. Because Rejoiner's template engine can only SUBSTITUTE (no
 * filters, conditionals, or loops — see the file header), the correctness that
 * used to live in the email template now lives in the sender. These tests pin
 * that down.
 *
 * Run: node test/subscription-rejoiner.test.js
 */

const https = require('https');
const { EventEmitter } = require('events');
const path = require('path');

/* ─── Fake HTTPS layer (intercepts Foxy + Rejoiner alike) ─────────────────── */
const captured = [];
let routes = [];
const route = (matcher, status, bodyObj) => routes.push({ matcher, status, bodyObj });

const realRequest = https.request;
https.request = function fakeRequest(options, cb) {
  const url = `https://${options.hostname}${options.path}`;
  const req = new EventEmitter();
  let sent = '';
  req.write = (c) => { sent += c; };
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

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
const reset = () => { captured.length = 0; routes = []; };
const trig = (u) => u.includes('/webhook_trigger/');

process.env.FOXY_CLIENT_ID = 'x';
process.env.FOXY_CLIENT_SECRET = 'x';
process.env.FOXY_REFRESH_TOKEN = 'x';
process.env.REJOINER_API_KEY = 'fake-rj-key';
process.env.REJOINER_SITE_ID = 'ZLZZEJL';
process.env.REJOINER_SUB_CANCEL_JOURNEY = 'CANCELJ';
process.env.REJOINER_SUB_UPDATED_JOURNEY = 'UPDATEDJ';

const FN = path.join(__dirname, '..', 'functions', 'manage-subscription.js');

/* A realistic post-update subscription, as the admin API returns it. */
const TT_HREF = 'https://api.foxycart.com/transaction_templates/999';
const ITEMS = [
  {
    code: 'v1', name: 'Chapo Extrax Blanco Gummies - Blue Razz', quantity: 1, price: 39.99,
    image: 'https://cdn/a.jpg', url: 'products/chapo',
    _links: { self: { href: 'https://api.foxycart.com/items/111' } },
  },
  {
    code: 'v2', name: 'Ghost Emerald Blend & Co', quantity: 2, price: 15.5, image: '',
    url: 'products/ghost',
    _links: { self: { href: 'https://api.foxycart.com/items/222' } },
  },
];
const TT = {
  total_item_price: 39.99, total_tax: 3.3, total_shipping: 0, total_order: 43.29,
  shipping_first_name: 'Sarah', shipping_last_name: 'T',
  shipping_address1: '123 Main St', shipping_address2: '',
  shipping_city: 'Austin', shipping_state: 'TX',
  shipping_postal_code: '78701', shipping_country: 'US',
  billing_first_name: 'Sarah', billing_last_name: 'T',
  billing_address1: '123 Main St', billing_address2: '',
  billing_city: 'Austin', billing_state: 'TX',
  billing_postal_code: '78701', billing_country: 'US',
  _links: { self: { href: TT_HREF } },
  _embedded: { 'fx:items': ITEMS },
};
const SUB = {
  frequency: '2w',
  next_transaction_date: '2026-08-20',
  end_date: '',
  is_active: true,
  _links: {
    self: { href: 'https://api.foxycart.com/subscriptions/726352' },
    // change-address PATCHes the TEMPLATE, not the subscription, so this link
    // must exist or that action bails before any email is sent.
    'fx:transaction_template': { href: TT_HREF },
  },
  _embedded: {
    'fx:customer': { email: 'shopper@example.com', first_name: 'Sarah', last_name: 'T' },
    'fx:transaction_template': TT,
  },
};

/* Drive the handler the way the browser panel does. `action` is what we vary. */
async function invoke(action, extra) {
  reset();
  // Foxy OAuth + every Foxy GET/PATCH → the sub above; Rejoiner → 200.
  route((u) => u.includes('foxycart.com/token'), 200, { access_token: 'tok' });
  route((u) => u.includes('rj2.rejoiner.com'), 200, {});
  // The template must answer as a TEMPLATE (buildAddressPatch seeds from its
  // current shipping_/billing_ values), not as the subscription.
  route((u) => u.includes('/transaction_templates/'), 200, TT);
  route((u) => u.includes('foxycart.com'), 200, SUB);
  const { handler } = require(FN);
  return handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify(Object.assign({
      action,
      subscription_uri: 'https://api.foxycart.com/subscriptions/726352',
      sub_token: 'tok123',
    }, extra || {})),
  });
}
/* The sub_token ownership check needs the token to match; patch it in. */
SUB._links['fx:sub_token_url'] = { href: 'https://api.foxycart.com/s/customer?sub_token=tok123' };

(async () => {
  console.log('\n[1] Cancel → Cancelled journey, correct shapes');
  await invoke('cancel');
  let t = captured.find((c) => trig(c.url));
  check('journey triggered', !!t, captured.map((c) => c.url).join(' | '));
  check('uses the CANCEL journey id', t?.url.includes('/journeys/CANCELJ/webhook_trigger/'), t?.url);
  check('Authorization: Rejoiner <key>', t?.headers.Authorization === 'Rejoiner fake-rj-key');
  check('body is { email, session_data }',
    t?.body.email === 'shopper@example.com' && !!t?.body.session_data && !('metadata' in (t?.body || {})),
    JSON.stringify(t?.body));
  check('no Omnisend call', !captured.some((c) => c.url.includes('omnisend')));

  console.log('\n[2] Every value the template needs is a finished string');
  let sd = t.body.session_data;
  check('first_name', sd.first_name === 'Sarah', sd.first_name);
  check('frequency_label maps 2w → "every 2 weeks"', sd.frequency_label === 'every 2 weeks', sd.frequency_label);
  check('next_charge_date is human-readable', sd.next_charge_date === 'August 20, 2026', sd.next_charge_date);
  check('subtotal_formatted', sd.subtotal_formatted === '$39.99', sd.subtotal_formatted);
  check('total_formatted', sd.total_formatted === '$43.29', sd.total_formatted);
  check('shipping_formatted renders $0.00 not ""', sd.shipping_formatted === '$0.00', sd.shipping_formatted);
  check('shipping_line joined without empty commas',
    sd.shipping_line === '123 Main St, Austin, TX 78701', sd.shipping_line);
  check('manage_url points at the LIVE domain (not the "drafon" typo)',
    sd.manage_url === 'https://www.thegreendragoncbd.com/account/memberships', sd.manage_url);
  check('no template-logic left for Rejoiner to do',
    !JSON.stringify(sd).includes('[%') && !JSON.stringify(sd).includes('|default'));

  console.log('\n[3] items_html renders EVERY item and escapes HTML');
  check('one top-level row per line item (2)',
    (sd.items_html.match(/^<tr>|<\/td><\/tr><tr>/g) || []).length === 2,
    String((sd.items_html.match(/^<tr>|<\/td><\/tr><tr>/g) || []).length));
  check('first item name present', sd.items_html.includes('Chapo Extrax Blanco Gummies - Blue Razz'));
  check('ampersand ESCAPED (would corrupt the email otherwise)',
    sd.items_html.includes('Ghost Emerald Blend &amp; Co'), sd.items_html);
  check('quantity x price rendered', sd.items_html.includes('2 &times; $15.50'), sd.items_html);
  check('image omitted cleanly when absent', !sd.items_html.includes('src=""'));

  console.log('\n[3b] Layout: rows must NOT add columns to the template table');
  // A multi-column top-level row joins the surrounding template's column grid and
  // squeezes every other row in the email into the image column's width.
  const topCells = sd.items_html
    .split(/<\/td><\/tr>/)                       // one chunk per top-level row
    .filter((s) => s.includes('<tr>'))
    .map((s) => {
      const outer = s.slice(0, s.indexOf('<table'));  // before the nested table
      return (outer.match(/<td/g) || []).length;
    });
  check('exactly one top-level <td> per item row', topCells.every((n) => n === 1),
    JSON.stringify(topCells));
  check('three-part layout is NESTED, not top-level',
    (sd.items_html.match(/<table/g) || []).length === 2, sd.items_html.slice(0, 200));
  check('no fixed-width cell at the top level (would set the parent column width)',
    !/^<tr><td width=/.test(sd.items_html), sd.items_html.slice(0, 80));
  check('item WITH an image renders a 100px image cell inside the nested table',
    sd.items_html.includes('width="100"'));

  console.log('\n[4] Date formatting must not shift a day across timezones');
  // '2026-08-01' via new Date() is UTC midnight → Jul 31 in US zones. Regression guard.
  process.env.TZ = 'America/Chicago';
  await invoke('skip');
  t = captured.find((c) => trig(c.url));
  check('2026-08-20 stays August 20 (no UTC-midnight off-by-one)',
    t.body.session_data.next_charge_date === 'August 20, 2026', t.body.session_data.next_charge_date);

  console.log('\n[5] Per-action headline/intro replace the old template case block');
  const expected = {
    'skip': 'Your next shipment is skipped',
    'ship-now': 'Your Green Dragon order is on the way',
    'set-frequency': 'Your delivery schedule is updated',
    'change-address': 'Your shipping details are updated',
    'restart': 'Welcome back — your subscription is active',
  };
  for (const [action, headline] of Object.entries(expected)) {
    await invoke(action, action === 'set-frequency' ? { frequency: '1m' }
      : action === 'change-address' ? { address_type: 'shipping', address: { address1: '1 New Rd' } } : null);
    const tt = captured.find((c) => trig(c.url));
    check(`${action} → "${headline}"`, tt?.body.session_data.headline === headline,
      tt?.body.session_data.headline);
    check(`${action} uses the UPDATED journey`, tt?.url.includes('/journeys/UPDATEDJ/'), tt?.url);
  }

  console.log('\n[6] An unknown action still gets sane copy, never blank');
  await invoke('some-future-action');
  t = captured.find((c) => trig(c.url));
  if (t) {
    check('falls back to a generic headline',
      t.body.session_data.headline === 'Your subscription has been updated', t.body.session_data.headline);
    check('intro_line is never empty', !!t.body.session_data.intro_line);
  } else {
    check('unknown action rejected before any email (also acceptable)', true);
  }

  console.log('\n[7] Rejoiner failure must NOT fail the subscription change');
  reset();
  route((u) => u.includes('foxycart.com/token'), 200, { access_token: 'tok' });
  route((u) => u.includes('rj2.rejoiner.com'), 500, { error: 'boom' });
  route((u) => u.includes('foxycart.com'), 200, SUB);
  let r = await require(FN).handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({ action: 'skip', subscription_uri: 'https://api.foxycart.com/subscriptions/726352', sub_token: 'tok123' }),
  });
  check('handler still returns success', r.statusCode === 200, JSON.stringify(r).slice(0, 200));

  console.log('\n[8] Unconfigured journey id → no send, no crash');
  delete process.env.REJOINER_SUB_UPDATED_JOURNEY;
  delete require.cache[require.resolve(FN)];
  reset();
  route((u) => u.includes('foxycart.com/token'), 200, { access_token: 'tok' });
  route((u) => u.includes('rj2.rejoiner.com'), 200, {});
  // The template must answer as a TEMPLATE (buildAddressPatch seeds from its
  // current shipping_/billing_ values), not as the subscription.
  route((u) => u.includes('/transaction_templates/'), 200, TT);
  route((u) => u.includes('foxycart.com'), 200, SUB);
  r = await require(FN).handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({ action: 'skip', subscription_uri: 'https://api.foxycart.com/subscriptions/726352', sub_token: 'tok123' }),
  });
  check('still succeeds', r.statusCode === 200, JSON.stringify(r).slice(0, 200));
  check('no journey trigger attempted', !captured.some((c) => trig(c.url)));

  https.request = realRequest;
  console.log(`\n──────────────\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
