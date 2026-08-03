/**
 * crossell-stock.js  —  Netlify Function
 * Live inventory for cross-sell candidates.
 *
 * WHY THIS ISN'T PART OF crossell-config.js
 * ─────────────────────────────────────────
 * crossell-config is embedded site-wide and therefore hit on every page view,
 * which is why it carries a 6-hour durable CDN cache — see the long comment on
 * its cache headers, where an uncached version once drove 1.77M Airtable calls
 * against a 100k/month quota. Inventory cannot ride along on a 6-hour cache: a
 * product that sells out at noon would keep being offered at a discount all
 * afternoon.
 *
 * So stock lives here instead, on a 60-second cache, and the front end only
 * requests it when a cross-sell is actually about to render — an add-to-cart
 * event, not a page view. That's a couple of Airtable reads per cart event
 * rather than per page view, so keeping stock effectively live costs very
 * little quota.
 *
 * REQUEST
 * ───────
 *   GET /.netlify/functions/crossell-stock?codes=<code>,<code>,...
 *
 * Codes are Foxy product codes, i.e. the Airtable "Website Product Code" of
 * either a product or a variant. Callers should sort the list so the request URL
 * is stable and the CDN cache actually hits.
 *
 * RESPONSE
 * ────────
 * {
 *   stock: {
 *     "<code>": { inv: 12, varInv: 0, backorder: false }
 *   }
 * }
 *
 *   inv        the record's own Inventory
 *   varInv     Variants Total Inventory — the real signal for a variant PARENT,
 *              whose own Inventory formula reads 0. Always 0 for variants.
 *   backorder  Allow Backorders. Products only; the Variants table has no such
 *              field, so the front end applies the parent's flag to its variants
 *              using the parent→variant graph it already has from the config.
 *
 * A code absent from the response was found in neither table. Callers must treat
 * an unknown code as AVAILABLE rather than hide a live product over a lookup
 * miss — the pre-payment webhook is the authoritative stock gate, so failing
 * open here cannot result in a sold-out item being charged.
 */
'use strict';

const Airtable = require('airtable');

const BASE_ID        = 'appWUsGD3byrYcN3l';
const PRODUCTS_TABLE = 'tblkLl9qqg654fWi7';
const VARIANTS_TABLE = 'tblEtb1aIH5Xk4Nh9';
const CODE_FIELD     = 'Website Product Code';

/** Hard cap so a malformed request can't build an unbounded Airtable formula. */
const MAX_CODES = 200;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/** Airtable number fields can arrive as strings; blank arrives as undefined. */
const toInt   = (v) => (typeof v === 'number' ? v : parseInt(v, 10)) || 0;
const truthy  = (v) => v === true || v === 'true';

function codeFormula(codes) {
  const clauses = codes.map(
    (c) => `{${CODE_FIELD}}="${String(c).replace(/"/g, '\\"')}"`
  );
  return clauses.length === 1 ? clauses[0] : `OR(${clauses.join(',')})`;
}

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      {},
      CORS,
      { 'Content-Type': 'application/json' },
      extraHeaders || {}
    ),
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const raw = (event.queryStringParameters && event.queryStringParameters.codes) || '';
  const codes = [...new Set(raw.split(',').map((c) => c.trim()).filter(Boolean))]
    .slice(0, MAX_CODES);

  if (!codes.length) return json(200, { stock: {} });

  const base    = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(BASE_ID);
  const formula = codeFormula(codes);
  const stock   = {};

  try {
    // Two Airtable requests total, however many codes were asked for. A code may
    // name a product or a variant, so both tables are queried with the same
    // formula; codes found in neither are simply omitted from the response.
    await Promise.all([
      base(PRODUCTS_TABLE)
        .select({
          fields: [CODE_FIELD, 'Inventory', 'Variants Total Inventory', 'Allow Backorders'],
          filterByFormula: formula,
        })
        .eachPage((records, next) => {
          records.forEach((r) => {
            const code = r.get(CODE_FIELD);
            if (!code) return;
            stock[code] = {
              inv:       toInt(r.get('Inventory')),
              varInv:    toInt(r.get('Variants Total Inventory')),
              backorder: truthy(r.get('Allow Backorders')),
            };
          });
          next();
        }),

      base(VARIANTS_TABLE)
        .select({
          fields: [CODE_FIELD, 'Inventory'],
          filterByFormula: formula,
        })
        .eachPage((records, next) => {
          records.forEach((r) => {
            const code = r.get(CODE_FIELD);
            if (!code) return;
            stock[code] = {
              inv:       toInt(r.get('Inventory')),
              varInv:    0,
              backorder: false, // inherited from the parent product, client-side
            };
          });
          next();
        }),
    ]);

    return json(200, { stock }, {
      // Short shared cache: every cart render in the same minute, across all
      // visitors, collapses to one Airtable read while stock stays effectively
      // live. 'durable' keeps all edge nodes on one cached copy rather than
      // letting each POP miss separately.
      'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=60, stale-while-revalidate=120',
      'Cache-Control': 'public, max-age=30',
    });
  } catch (err) {
    console.error('[crossell-stock]', err.message || err);
    // Fail OPEN. An empty map reads as "no stock data", and callers treat unknown
    // codes as available. Hiding every cross-sell on a transient Airtable error
    // would cost real sales, and the pre-payment webhook still refuses to charge
    // a sold-out item.
    return json(200, { stock: {} });
  }
};
