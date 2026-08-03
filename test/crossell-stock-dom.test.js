/**
 * Behaviour tests for the out-of-stock filtering in public/crossell-popup.js.
 *
 * Uses a hand-rolled minimal DOM rather than a headless browser, so this stays a
 * zero-dependency `node` run like the rest of the suite.
 *
 * The regression these guard against: the cross-sell popup and the in-cart widget
 * used to be built purely from crossell-config, which reads no inventory fields at
 * all, so sold-out products were offered at a discount and could be bought. The
 * properties that must hold now:
 *
 *   • a sold-out simple product is not offered
 *   • a sold-out VARIANT disappears from the dropdown while its in-stock siblings stay
 *   • a product whose every variant is sold out is dropped entirely, rather than
 *     rendering a dropdown with nothing selectable
 *   • "Allow Backorders" on the parent still counts as available, matching how site
 *     search computes its in-stock flag (see lib/search-index-builder.js)
 *   • an unknown code FAILS OPEN — we never hide a live product over a lookup miss,
 *     because the pre-payment webhook is the authoritative stock gate
 *   • when nothing is purchasable, no popup shows AND the session is not marked as
 *     shown, so a restock can still surface the offer later
 *   • stock is fetched ONCE per session window, not once per cart render — the 1s
 *     poll re-renders the in-cart widget constantly
 */
'use strict';

const path = require('path');
const fs   = require('fs');

const SRC = path.join(__dirname, '..', 'public', 'crossell-popup.js');
const src = fs.readFileSync(SRC, 'utf8');

let fails = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '   <<< ' + JSON.stringify(extra)));
  if (!cond) fails++;
};

/* ─── fixtures ────────────────────────────────────────────────────────────────── */

const prod = (name, code, variants) => ({
  name, code,
  regularPrice: 20,
  image: '', url: '',
  variantsLabel: variants && variants.length ? 'Flavor' : '',
  variants: variants || [],
});
const vnt = (name, code) => ({ name, code, price: 20, image: '', label: '', displayName: name });

const CONFIG = {
  categoryCrossSells: [{
    primaryCategory:  'THC',
    parentCategories: ['THC', 'Delta 8'],
    discountPct: 40,
    maxQty: 3,
    products: [
      prod('Alpha In Stock Simple',      'P_IN'),
      prod('Beta Sold Out Simple',       'P_OUT'),
      prod('Gamma Mixed Variants',       'P_VAR',    [vnt('Gamma Good', 'V_IN'), vnt('Gamma Gone', 'V_OUT')]),
      prod('Delta All Variants Gone',    'P_ALLOUT', [vnt('Delta X', 'V_X')]),
      prod('Epsilon Backorder Parent',   'P_BO',     [vnt('Epsilon Late', 'V_BO_OUT')]),
      prod('Zeta Unknown Code',          'P_UNKNOWN'),
    ],
  }],
  genericCrossSells: [{
    name: 'Generic', trigger: 'Any item', discountPct: 25, maxQty: 2,
    products: [
      prod('Theta Generic In Stock', 'G_IN'),
      prod('Iota Generic Sold Out',  'G_OUT'),
    ],
  }],
};

/** inv = own Inventory, varInv = Variants Total Inventory, backorder = Allow Backorders */
const STOCK = {
  P_IN:     { inv: 5, varInv: 0, backorder: false },
  P_OUT:    { inv: 0, varInv: 0, backorder: false },
  P_VAR:    { inv: 0, varInv: 4, backorder: false },   // variant parent: own Inventory reads 0
  V_IN:     { inv: 4, varInv: 0, backorder: false },
  V_OUT:    { inv: 0, varInv: 0, backorder: false },
  P_ALLOUT: { inv: 0, varInv: 0, backorder: false },
  V_X:      { inv: 0, varInv: 0, backorder: false },
  P_BO:     { inv: 0, varInv: 0, backorder: true },    // sold out but backorderable
  V_BO_OUT: { inv: 0, varInv: 0, backorder: false },   // inherits the parent's flag
  G_IN:     { inv: 3, varInv: 0, backorder: false },
  G_OUT:    { inv: 0, varInv: 0, backorder: false },
  // P_UNKNOWN deliberately absent — must fail open
};

const ALL_OUT = Object.keys(STOCK).reduce((m, k) => {
  m[k] = { inv: 0, varInv: 0, backorder: false };
  return m;
}, { P_UNKNOWN: { inv: 0, varInv: 0, backorder: false } });

/* ─── minimal DOM ─────────────────────────────────────────────────────────────── */

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], attrs: {}, style: {}, _html: '', textContent: '',
    id: '', className: '', value: '', disabled: false, options: [], selectedIndex: -1,
    parentNode: null, nextSibling: null,
    appendChild(c) { c.parentNode = el; el.children.push(c); if (c.id) byId[c.id] = c; return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c.parentNode = null;
      if (c.id && byId[c.id] === c) delete byId[c.id];
      return c;
    },
    insertBefore(c) { return el.appendChild(c); },
    insertAdjacentHTML(pos, html) { el._html += html; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    addEventListener() {}, removeEventListener() {}, click() {},
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; },
  });
  return el;
}

let byId = {};

/* ─── one full run of the script under a given stock response ─────────────────── */

const flush = async (turns) => {
  for (let i = 0; i < (turns || 12); i++) await new Promise((r) => setImmediate(r));
};

/**
 * Load a fresh copy of crossell-popup.js, let its config load, then simulate a
 * customer adding a qualifying THC item so the popup fires.
 *
 * @param stockResponse  the map crossell-stock would return, or the string
 *                       'reject' to simulate the endpoint failing
 */
async function run(stockResponse) {
  byId = {};
  const fetchLog = [];
  const store    = {};
  const timers   = [];
  let pollFn     = null;

  const head       = makeEl('head');
  const body       = makeEl('body');
  const cartParent = makeEl('div');
  const cartItems  = makeEl('div');
  cartParent.appendChild(cartItems);

  body.insertAdjacentHTML = function (pos, html) {
    body._html += html;
    if (html.indexOf('id="tgd-crossell"') !== -1) {
      const popup = makeEl('div');
      popup.id = 'tgd-crossell';
      popup._html = html;
      byId['tgd-crossell'] = popup;
    }
  };

  global.document = {
    readyState: 'complete',
    currentScript: null,
    head, body,
    createElement: makeEl,
    getElementById(id) { return byId[id] || null; },
    getElementsByTagName() { return []; },
    querySelector(sel) { return sel === '.fc-cart__items' ? cartItems : null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };

  const FC = {
    json: {
      items: {},
      config: { store_domain: 'thegreendragoncbd.foxycart.com' },
      session_name: 'fcsid', session_id: 'abc',
    },
    client: { on() {}, request() { return Promise.resolve(); } },
  };
  global.FC = FC;
  global.window = {
    FC,
    location: {
      hostname: 'www.thegreendragoncbd.com',
      pathname: '/products/some-thc-thing',
      href: '',
    },
    addEventListener() {},
  };

  global.sessionStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };

  global.fetch = function (url) {
    fetchLog.push(url);
    if (url.indexOf('crossell-config') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(CONFIG) });
    }
    if (url.indexOf('crossell-stock') !== -1) {
      if (stockResponse === 'reject') return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ stock: stockResponse }) });
    }
    return Promise.reject(new Error('unexpected fetch ' + url));
  };

  // Controllable timers: the script leans on setTimeout(…, 300) for cart renders
  // and setInterval(…, 1000) for its add-detection poll.
  global.setTimeout   = (fn) => { timers.push(fn); return timers.length; };
  global.clearTimeout = () => {};
  global.setInterval  = (fn) => { pollFn = fn; return 1; };
  global.clearInterval = () => {};
  const runTimers = () => { timers.splice(0).forEach((fn) => fn()); };

  delete require.cache[require.resolve(SRC)];
  require(SRC);

  await flush();          // config fetch resolves
  runTimers();            // drain the renders it queued
  await flush();          // …and their stock lookups

  pollFn();               // establish the empty-cart baseline
  runTimers();
  await flush();

  // Customer adds a THC item — this is what triggers the popup.
  FC.json.items = {
    1: { id: 1, code: 'SOMETHC', name: 'Some THC Thing', category: 'THC', quantity: 1, options: [] },
  };
  pollFn();
  await flush();
  runTimers();
  await flush();

  // A few more poll ticks, as would happen while the customer reads the offer.
  for (let i = 0; i < 3; i++) { pollFn(); runTimers(); await flush(); }

  return {
    popupHTML:  (byId['tgd-crossell'] && byId['tgd-crossell']._html) || '',
    widgetHTML: (byId['tgd-cart-crossell'] && byId['tgd-cart-crossell']._html) || '',
    shownTHC:   store['tgd_crossell_shown_thc'] || null,
    stockFetches: fetchLog.filter((u) => u.indexOf('crossell-stock') !== -1).length,
  };
}

/* ─── tests ───────────────────────────────────────────────────────────────────── */

(async function main() {
  console.log('\ncross-sell out-of-stock filtering (DOM)\n');

  const mixed = await run(STOCK);

  console.log(' popup — products');
  ok(mixed.popupHTML.length > 0, 'the popup renders at all once stock is known');
  ok(mixed.popupHTML.indexOf('Alpha In Stock Simple') !== -1,
    'an in-stock simple product is offered');
  ok(mixed.popupHTML.indexOf('Beta Sold Out Simple') === -1,
    'a sold-out simple product is NOT offered');
  ok(mixed.popupHTML.indexOf('Gamma Mixed Variants') !== -1,
    'a variant parent with stock in the rollup is offered (its own Inventory reads 0)');
  ok(mixed.popupHTML.indexOf('Delta All Variants Gone') === -1,
    'a product whose every variant is sold out is dropped entirely');

  console.log(' popup — variants');
  ok(mixed.popupHTML.indexOf('value="V_IN"') !== -1,
    'an in-stock variant stays in the dropdown');
  ok(mixed.popupHTML.indexOf('value="V_OUT"') === -1,
    'a sold-out variant is removed from the dropdown');

  console.log(' backorders and unknown codes');
  ok(mixed.popupHTML.indexOf('Epsilon Backorder Parent') !== -1,
    'zero inventory + Allow Backorders still counts as available');
  ok(mixed.popupHTML.indexOf('value="V_BO_OUT"') !== -1,
    'and its variants inherit that flag, since the Variants table has no such field');
  ok(mixed.popupHTML.indexOf('Zeta Unknown Code') !== -1,
    'a code missing from the stock response fails OPEN rather than hiding a live product');

  console.log(' in-cart widget');
  ok(mixed.widgetHTML.indexOf('Theta Generic In Stock') !== -1,
    'the in-cart widget offers an in-stock generic cross-sell');
  ok(mixed.widgetHTML.indexOf('Iota Generic Sold Out') === -1,
    'and never a sold-out one');

  console.log(' quota — the 1s poll must not hammer the endpoint');
  ok(mixed.stockFetches === 1,
    'stock is fetched once across the popup and repeated cart renders', mixed.stockFetches);

  console.log(' nothing purchasable');
  const empty = await run(ALL_OUT);
  ok(empty.popupHTML === '', 'no popup at all when every product is sold out');
  ok(empty.shownTHC === null,
    'and the session is NOT marked shown, so a restock can still surface the offer');
  ok(empty.widgetHTML === '', 'no in-cart widget either');

  console.log(' endpoint failure');
  const failed = await run('reject');
  ok(failed.popupHTML.indexOf('Alpha In Stock Simple') !== -1,
    'a failed stock lookup still shows the offer (fail open)');
  ok(failed.popupHTML.indexOf('Beta Sold Out Simple') !== -1,
    'including items we could not verify — the pre-payment webhook is the real gate');

  console.log(' source properties');
  ok(/crossell-stock/.test(src),
    'stock comes from its own endpoint, not the 6-hour-cached config');
  ok(/loadStock\(\)\.then\(injectCartCrossSell\)/.test(src),
    'the in-cart widget resolves stock before touching the DOM, so remove+inject stays atomic');
  ok(/filterCsByStock/.test(src) && (src.match(/filterCsByStock\(/g) || []).length >= 3,
    'both the popup and the widget go through the same filter');
  ok(/if \(!s\) return true/.test(src),
    'unknown codes fail open in both stock helpers');

  console.log('\n' + (fails ? fails + ' failing' : 'all assertions passed') + '\n');
  process.exitCode = fails ? 1 : 0;
})();
