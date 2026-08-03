/**
 * Stock validation tests for functions/pre-payment-webhook.js — the last gate
 * before a card is charged.
 *
 * Airtable is stubbed (via require.cache) so this stays a zero-dependency `node`
 * run like the rest of the suite. Fixtures use record ids as Website Product
 * Codes, which is what this base actually does.
 *
 * The two regressions these guard against, both of which sold goods that did not
 * exist:
 *
 *   1. CROSS-SELL LINES SKIPPED INVENTORY. The per-item chain sent CROSSELL_PROMO
 *      items down a branch that validated price and quantity but never stock, so a
 *      sold-out cross-sell was discounted, accepted and charged.
 *
 *   2. STOCK WAS CHECKED PER LINE, NOT PER CODE. The cross-sell popup splits an
 *      over-limit add into a discounted promo line plus a full-price DEFAULT line
 *      with the SAME code. Checked separately, both passed while together
 *      overselling.
 */
'use strict';

const path = require('path');

let fails = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '   <<< ' + JSON.stringify(extra)));
  if (!cond) fails++;
};

/* ─── fixtures ────────────────────────────────────────────────────────────────── */

const PRODUCTS_TABLE  = 'tblkLl9qqg654fWi7';
const VARIANTS_TABLE  = 'tblEtb1aIH5Xk4Nh9';
const PRIMARY_CATS    = 'tbliSkVUbug2MYAW7';
const GENERIC_TABLE   = 'tblwkNLyvaTJaGgpD';

/** Website Product Code === record id on this base. */
const product = (id, name, price, inventory) => ({
  id,
  fields: {
    'Name': name,
    'Website Product Code': id,
    'Price': price,
    'Inventory': inventory,
    'Inventory (Chesterfield)': 0,
    'Inventory (St Peters)': 0,
    'Inventory (Warehouse)': 0,
    'In-Store Only': false,
    'Variants': [],
  },
});

const ROWS = {
  [PRODUCTS_TABLE]: [
    product('recSOLDOUT', 'Sold Out Crosssell', 20, 0),
    product('recINSTOCK', 'In Stock Crosssell', 20, 10),
    product('recLIMITED', 'Limited Crosssell',  20, 3),
    product('recREGULAR', 'Regular Product',    50, 5),
    product('recDELAYED', 'Delayed Product',    50, 0),
  ],
  [VARIANTS_TABLE]: [],
  [PRIMARY_CATS]: [{
    id: 'recCat1',
    fields: {
      'Cross-sell Product': ['recSOLDOUT', 'recINSTOCK', 'recLIMITED'],
      'Cross-sell Discount': 0.4,   // Airtable percent fields are fractions
      'Cross-sell Max Qty': 3,
    },
  }],
  [GENERIC_TABLE]: [],
};

/* ─── Airtable stub ───────────────────────────────────────────────────────────── */

const wrap = (row) => ({
  id: row.id,
  get(field) { return row.fields[field]; },
});

/** Serve only the two formula shapes this module builds. */
function matches(row, formula) {
  if (!formula) return true;
  const byCode = formula.match(/\{Website Product Code\}\s*=\s*"([^"]+)"/);
  if (byCode) return row.fields['Website Product Code'] === byCode[1];
  const ids = [...formula.matchAll(/RECORD_ID\(\)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (ids.length) return ids.indexOf(row.id) !== -1;
  return true; // COUNTA(...) / {Active} = TRUE() — fixtures are already the live set
}

let lookupLog = [];

function FakeAirtable() {}
FakeAirtable.prototype.base = function () {
  return function (tableId) {
    return {
      select(opts) {
        return {
          async eachPage(cb) {
            const rows = (ROWS[tableId] || []).filter((r) => matches(r, opts.filterByFormula));
            if (tableId === PRODUCTS_TABLE && /Website Product Code/.test(opts.filterByFormula || '')) {
              lookupLog.push(opts.filterByFormula);
            }
            cb(rows.map(wrap), () => {});
          },
        };
      },
    };
  };
};

const SRC = path.join(__dirname, '..', 'functions', 'pre-payment-webhook.js');
require.cache[require.resolve('airtable')] = { id: 'airtable', filename: 'airtable', loaded: true, exports: FakeAirtable };
const { handler } = require(SRC);

/* ─── payload helpers ─────────────────────────────────────────────────────────── */

const line = (o) => ({
  code: o.code,
  name: o.name,
  price: o.price,
  quantity: o.qty,
  subscription_end_date: null,
  subscription_frequency: null,
  _embedded: {
    'fx:item_category': { code: o.category || 'DEFAULT' },
    'fx:item_options': o.options || [],
  },
});

async function check(items, shippingId) {
  lookupLog = [];
  const res = await handler({
    body: JSON.stringify({
      _embedded: {
        'fx:items': items,
        'fx:shipment': { shipping_service_id: shippingId || '10010' },
        'fx:customer': { id: '0' },
      },
    }),
  });
  return JSON.parse(res.body);
}

/* 40% off $20 → $12.00, so a legitimate promo line is priced 12. */
const PROMO = 'CROSSELL_PROMO';

/* ─── tests ───────────────────────────────────────────────────────────────────── */

(async function main() {
  console.log('\npre-payment webhook — cross-sell stock\n');

  console.log(' the headline bug: a sold-out cross-sell must not be charged');
  const soldOut = await check([
    line({ code: 'recSOLDOUT', name: 'Sold Out Crosssell', price: 12, qty: 1, category: PROMO }),
  ]);
  ok(soldOut.ok === false, 'a sold-out CROSSELL_PROMO item is rejected', soldOut);
  ok(/Insufficient stock/.test(soldOut.details || ''),
    'and the reason given is stock, not price', soldOut.details);

  console.log(' a legitimate cross-sell still goes through');
  const good = await check([
    line({ code: 'recINSTOCK', name: 'In Stock Crosssell', price: 12, qty: 2, category: PROMO }),
  ]);
  ok(good.ok === true, 'an in-stock cross-sell at the right price is accepted', good);

  console.log(' price tampering is still caught (unchanged behaviour)');
  const cheap = await check([
    line({ code: 'recINSTOCK', name: 'In Stock Crosssell', price: 1, qty: 1, category: PROMO }),
  ]);
  ok(cheap.ok === false && /could not be validated/.test(cheap.details || ''),
    'an under-priced promo line is rejected', cheap.details);

  console.log(' the split-line oversell: promo + full-price overflow share one code');
  /* This is exactly what the popup builds when someone asks for 5 of a product
   * capped at 3: a promo line of 3 plus a DEFAULT line of 2. Only 3 exist. */
  const split = await check([
    line({ code: 'recLIMITED', name: 'Limited Crosssell', price: 12, qty: 3, category: PROMO }),
    line({ code: 'recLIMITED', name: 'Limited Crosssell', price: 20, qty: 2 }),
  ]);
  ok(split.ok === false, '5 units across two lines with 3 in stock is rejected', split);
  ok(/Insufficient stock/.test(split.details || ''), 'reported as insufficient stock', split.details);

  const exact = await check([
    line({ code: 'recLIMITED', name: 'Limited Crosssell', price: 12, qty: 3, category: PROMO }),
  ]);
  ok(exact.ok === true, 'but taking exactly the 3 that exist is still allowed', exact);

  console.log(' string quantities (Foxy sends these) must add, not concatenate');
  const strQty = await check([
    line({ code: 'recLIMITED', name: 'Limited Crosssell', price: 12, qty: '2', category: PROMO }),
    line({ code: 'recLIMITED', name: 'Limited Crosssell', price: 20, qty: '2' }),
  ]);
  ok(strQty.ok === false, '"2" + "2" is treated as 4, not 22 or "22"', strQty.details);

  console.log(' regular items — unchanged behaviour');
  ok((await check([line({ code: 'recREGULAR', name: 'Regular Product', price: 50, qty: 5 })])).ok === true,
    'a regular item within stock passes');
  ok((await check([line({ code: 'recREGULAR', name: 'Regular Product', price: 50, qty: 6 })])).ok === false,
    'a regular item over stock is rejected');

  console.log(' exemptions');
  const delayed = await check([
    line({
      code: 'recDELAYED', name: 'Delayed Product', price: 50, qty: 2,
      options: [{ name: 'Delayed_shipping', value: 'yes' }],
    }),
  ]);
  ok(delayed.ok === true, 'a Delayed_shipping item skips the stock check despite 0 inventory', delayed);

  console.log(' unknown codes');
  const bogus = await check([
    line({ code: 'recNOPE', name: 'Fabricated', price: 1, qty: 1, category: PROMO }),
  ]);
  ok(bogus.ok === false, 'a fabricated CROSSELL_PROMO code is rejected', bogus);
  ok((bogus.details.match(/recNOPE/g) || []).length === 1,
    'and is named once, not twice, though two checks both miss it', bogus.details);

  console.log(' efficiency');
  await check([
    line({ code: 'recLIMITED', name: 'Limited Crosssell', price: 12, qty: 1, category: PROMO }),
    line({ code: 'recLIMITED', name: 'Limited Crosssell', price: 20, qty: 1 }),
    line({ code: 'recREGULAR', name: 'Regular Product', price: 50, qty: 1 }),
  ]);
  ok(lookupLog.length === 2,
    'one inventory lookup per unique code, not per line', lookupLog);

  console.log('\n' + (fails ? fails + ' failing' : 'all assertions passed') + '\n');
  process.exitCode = fails ? 1 : 0;
})();
