/**
 * SEARCH INDEX BUILDER — OFFLINE TESTS
 * ────────────────────────────────────────────────────────────────────────────
 * Runs the real handler against stubbed HTTP fixtures, so no tokens, no network
 * and no Airtable quota are needed. Run with `npm test`.
 *
 * WHY THIS EXISTS
 *   Two of the builder's guards are the kind that fail silently and expensively:
 *     • the 7-OH compliance exclusion — 7-OH is illegal and must never be
 *       surfaced, and a regression here is a legal problem, not a UX one;
 *     • the cost/wholesale leak guard — the index is a PUBLIC endpoint and the
 *       Airtable tables carry Cost, MSRP and Base Unit Cost (Tier 1-3).
 *   Neither would show up in casual manual testing. Both are asserted here.
 *
 *   It also pins the Airtable FIELD NAMES. Airtable silently omits unknown
 *   fields rather than erroring, so a typo'd field name (e.g. the Webflow slug
 *   `Answer Plain` instead of the Airtable name `Answer`) produces empty text
 *   with no error anywhere. The fixtures use the real field names; if someone
 *   renames a field in the builder, the fold assertions fail.
 *
 * No test framework — plain node, so it runs anywhere with zero install.
 */
'use strict';

const https = require('https');
const path = require('path');
const { EventEmitter } = require('events');

/* ─── FIXTURES ───────────────────────────────────────────────────────────────── */

const wfProducts = {
  items: [
    { id: 'wf1', isDraft: false, isArchived: false, fieldData: { name: 'Blue Dream Gummies', slug: 'blue-dream-gummies' } },
    { id: 'wf2', isDraft: true,  isArchived: false, fieldData: { name: 'Draft Product', slug: 'draft-product' } },
    { id: 'wf3', isDraft: false, isArchived: false, fieldData: { name: '7-OH Tablets', slug: '7oh-tablets' } },
    { id: 'wf4', isDraft: false, isArchived: false, fieldData: { name: 'Discontinued Thing', slug: 'disc-thing' } },
    { id: 'wf5', isDraft: false, isArchived: false, fieldData: { name: 'Orphan No Airtable', slug: 'orphan' } },
    { id: 'wf6', isDraft: false, isArchived: false, fieldData: { name: 'TRE House Carts', slug: 'tre-house-carts' } },
  ],
  pagination: { total: 6 },
};

const wfBrands = {
  items: [
    { id: 'b1', isDraft: false, isArchived: false, fieldData: { name: 'TRĒ House', slug: 'tre-house', 'short-description-2': '<p>Great brand</p>', logo: { url: 'https://img/tre.png' } } },
    { id: 'b2', isDraft: false, isArchived: false, fieldData: { name: 'Hidden Brand', slug: 'hidden', "don-t-display": true } },
  ],
  pagination: { total: 2 },
};

const wfCats = (name, slug) => ({
  items: [{ id: 'c-' + slug, isDraft: false, isArchived: false, fieldData: { name, slug, 'meta-description': 'Shop ' + name } }],
  pagination: { total: 1 },
});

const wfPages = {
  pages: [
    { slug: 'delta-8-gummies-edibles', publishedPath: '/delta-8-gummies-edibles', draft: false, title: 'Delta 8 Gummies', seo: { title: 'Delta 8 Gummies & Edibles', description: 'Shop delta 8' } },
    { slug: 'careers-staging', publishedPath: '/careers-staging', draft: true, title: 'Careers [Staging]' },
    { slug: 'addresses', publishedPath: '/portal/addresses', draft: false, title: 'Addresses' },
    { slug: 'detail_product', publishedPath: '/product', draft: false, collectionId: 'X', title: 'Products Template' },
    { slug: 'faq', publishedPath: '/faq', draft: false, title: 'FAQ', seo: { title: 'FAQs' } },
    { slug: '7oh-info', publishedPath: '/7oh-info', draft: false, title: '7-OH Information' },
    { slug: 'search', publishedPath: '/search', draft: false, title: 'Search Results' },
  ],
  pagination: { total: 7 },
};

/* Cost/wholesale fields are present in this RESPONSE on purpose: the allowlist
 * should never request them, and the leak guard must keep them out of output
 * even if Airtable returns them anyway. */
const atProducts = {
  records: [
    { id: 'a1', fields: {
      Name: 'Blue Dream Gummies', 'Webflow Item ID': 'wf1', Price: 29.99, 'Sale Price': 19.99, 'On Sale': true,
      'Lowest Price': 19.99, 'Highest Price': 39.99, 'Number of Sales': 812, Inventory: 0,
      'Variants Total Inventory': 14, 'Primary Image Webflow URL': 'https://img/bd.png',
      Summary: '<p>A <strong>tasty</strong> gummy.</p>', 'Name (from Brand)': ['TRĒ House'],
      'Name (from Parent Categories)': ['Gummies & Edibles', 'Delta 9'],
      Variants: ['v1', 'v2', 'v3'], FAQs: ['q1', 'q2'],
      Cost: 4.20, 'Wholesale Cost (Tier 1)': 9.99, MSRP: 49.99,
    } },
    { id: 'a3', fields: { Name: '7-OH Tablets', 'Webflow Item ID': 'wf3', Price: 19.99, Inventory: 5, 'Number of Sales': 3000 } },
    { id: 'a4', fields: { Name: 'Discontinued Thing', 'Webflow Item ID': 'wf4', Discontinued: true, Inventory: 9 } },
    { id: 'a6', fields: { Name: 'TRE House Carts', 'Webflow Item ID': 'wf6', Price: 24.99, Inventory: 0, 'Allow Backorders': true, 'Number of Sales': 55 } },
    { id: 'a7', fields: { Name: 'In Store Only Item', 'Webflow Item ID': 'wf-none', 'In-Store Only': true } },
  ],
};

const atVariants = {
  records: [
    { id: 'v1', fields: { Name: 'BD - Blue Raspberry', Flavor: 'Blue Raspberry', Strength: '1000mg', Strain: 'Indica', Inventory: 4 } },
    { id: 'v2', fields: { Name: 'BD - Watermelon', Flavor: 'Watermelon', Strength: '1000mg', Strain: 'Indica', Inventory: 10 } },
    { id: 'v3', fields: { Name: 'BD - dupe', Flavor: 'Blue Raspberry', Strength: '1000mg' } },
  ],
};

/* `Answer` is the Airtable field name. `Answer Plain` is the WEBFLOW slug and
 * would silently yield no text — that bug is what these fixtures pin. */
const atFaqs = {
  records: [
    { id: 'q1', fields: { Question: 'Will this show on a drug test?', Answer: 'Possibly. ' + 'x'.repeat(400) } },
    { id: 'q2', fields: { Question: 'How many mg per gummy?', Answer: 'Ten.' } },
    { id: 'q3', fields: { Question: 'What is your shipping policy?', Answer: 'Fast.', 'Display on FAQ Page': true } },
    { id: 'q4', fields: { Question: 'Truly orphaned question', Answer: 'Nobody links me.' } },
  ],
};

/* ─── HTTP STUB ──────────────────────────────────────────────────────────────── */

function route(p) {
  if (p.includes('/collections/62a16d0c459d465de7ebf815/items')) return wfProducts;
  if (p.includes('/collections/62b8d929c89f59d002dff343/items')) return wfBrands;
  if (p.includes('/collections/62f17faae806deec81029076/items')) return wfCats('THC', 'thc');
  if (p.includes('/collections/62a16fe92a02f92cb0875359/items')) return wfCats('Vape Pens', 'vape-pens');
  if (p.includes('/collections/630d7bfa22283f5107c694e2/items')) return wfCats('THC Vape Pens & Carts', 'thc-vape-pens-carts');
  if (p.includes('/pages')) return wfPages;
  if (p.includes('tblkLl9qqg654fWi7')) return atProducts;
  if (p.includes('tblEtb1aIH5Xk4Nh9')) return atVariants;
  if (p.includes('tblMadzmtWLZpBlWm')) return atFaqs;
  throw new Error('unrouted fixture path: ' + p);
}

const seenPaths = [];
/* Flipped by the degradation scenario to simulate WEBFLOW_API_TOKEN lacking the
 * `pages:read` scope — the real 403 that this policy exists to survive. */
let failPages = false;
https.request = function (options, cb) {
  const p = options.path || '';
  seenPaths.push(p);
  if (failPages && p.includes('/pages')) {
    const res = new EventEmitter();
    res.statusCode = 403;
    const body = JSON.stringify({ message: "OAuthForbidden: You are missing the following scopes - 'pages:read'", code: 'missing_scopes' });
    process.nextTick(() => {
      cb(res);
      process.nextTick(() => { res.emit('data', Buffer.from(body)); res.emit('end'); });
    });
    const rq = new EventEmitter(); rq.write = () => {}; rq.end = () => {};
    return rq;
  }
  const payload = JSON.stringify(route(p));
  const res = new EventEmitter();
  res.statusCode = 200;
  // Hand the response over BEFORE emitting, so the caller can attach listeners.
  process.nextTick(() => {
    cb(res);
    process.nextTick(() => { res.emit('data', Buffer.from(payload)); res.emit('end'); });
  });
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {};
  return req;
};

/* ─── RUN ────────────────────────────────────────────────────────────────────── */

process.env.WEBFLOW_API_TOKEN = 'test';
process.env.AIRTABLE_API_KEY = 'test';
process.env.SEARCH_INDEX_KEY = 'test-key';

// Test through the HTTP wrapper: it exercises the shared builder AND the key check.
const fn = require(path.join(__dirname, '..', 'functions', 'search-index-rebuild.js'));

let fails = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '   <<< got: ' + JSON.stringify(extra)));
  if (!cond) fails++;
}

(async () => {
  const r = await fn.handler({ httpMethod: 'GET', queryStringParameters: { key: 'test-key', dry: '1' } });
  const s = JSON.parse(r.body);
  if (r.statusCode !== 200) {
    console.error('handler failed:', JSON.stringify(s, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('\nsearch-index-build\n');

  console.log(' auth');
  const unauth = await fn.handler({ httpMethod: 'GET', queryStringParameters: {} });
  ok(unauth.statusCode === 401, 'rejects manual calls without the key', unauth.statusCode);
  const wrongKey = await fn.handler({ httpMethod: 'GET', queryStringParameters: { key: 'nope' } });
  ok(wrongKey.statusCode === 401, 'rejects a wrong key', wrongKey.statusCode);

  console.log(' compliance (7-OH must never be indexed)');
  ok(s.prohibitedDropped.some((x) => /7-OH Tablets/.test(x)), 'drops the 7-OH product', s.prohibitedDropped);
  ok(s.prohibitedDropped.some((x) => /7oh-info/.test(x)), 'drops a 7-OH static page', s.prohibitedDropped);

  console.log(' security (public index must carry no margin data)');
  const flat = JSON.stringify(s.sample || []);
  ok(!/cost|wholesale|tier|msrp|margin/i.test(flat), 'no cost/wholesale/msrp in output docs');
  const atCall = seenPaths.find((p) => p.includes('tblkLl9qqg654fWi7')) || '';
  ok(/fields%5B%5D=/.test(atCall), 'Airtable read is restricted to an allowlist');
  ok(!/Cost|Wholesale|MSRP/i.test(decodeURIComponent(atCall)), 'allowlist requests no cost fields');

  console.log(' exclusions');
  ok(s.byType.product === 3, '3 products indexed (draft + 7-OH + discontinued excluded)', s.byType);
  ok((s.excluded['product:discontinued'] || 0) === 1, 'discontinued product excluded', s.excluded);
  ok((s.excluded['brand:don-t-display'] || 0) === 1, "brand flagged don't-display excluded", s.excluded);
  ok((s.excluded['page:draft/archived'] || 0) === 1, 'draft page excluded', s.excluded);
  ok((s.excluded['page:operational'] || 0) === 1, 'operational /portal/ page excluded', s.excluded);
  ok((s.excluded['page:excluded slug'] || 0) === 1, 'legacy /search page excluded', s.excluded);
  ok(s.unjoinedProducts === 1, 'product with no Airtable row still indexed, and counted', s.unjoinedProducts);

  console.log(' folds');
  ok(s.variantsFolded === 3, '3 variants folded into their parent', s.variantsFolded);
  ok(s.faqsFolded === 2, '2 product FAQs folded', s.faqsFolded);
  ok(s.faqsToFaqPage === 1, 'general FAQ routed to /faq instead of its own doc', s.faqsToFaqPage);
  ok(s.faqsOrphanedDropped === 1, 'unattached FAQ dropped', s.faqsOrphanedDropped);

  console.log(' product document shape');
  const bd = (s.sample || []).find((d) => d.n === 'Blue Dream Gummies');
  ok(!!bd, 'product present in sample', (s.sample || []).map((d) => d.n));
  if (bd) {
    ok(bd.u === '/product/blue-dream-gummies', 'URL built from the Webflow slug', bd.u);
    ok(bd.s === 812, 'Number of Sales carried through as the ranking signal', bd.s);
    ok(bd.st === 1, 'in stock via variant rollup though own Inventory is 0', bd.st);
    ok(bd.sp === 19.99, 'sale price used when On Sale is set', bd.sp);
    ok(/Blue Raspberry/.test(bd.x || '') && /Watermelon/.test(bd.x || ''), 'variant flavours searchable', bd.x);
    ok((String(bd.x).match(/Blue Raspberry/g) || []).length === 1, 'repeated variant text deduped', bd.x);
    ok(/drug test/.test(bd.q || ''), 'FAQ question searchable', String(bd.q).slice(0, 60));
    ok(String(bd.q).length < 500, 'FAQ answer truncated, not indexed whole', String(bd.q).length);
    ok(!/<strong>/.test(bd.d || ''), 'HTML stripped from the description', bd.d);
  }

  console.log(' coverage');
  ok(s.byType.brand === 1, 'brands indexed', s.byType);
  ok(s.byType.category === 3, 'all three category levels indexed', s.byType);
  ok(s.byType.page === 2, 'landing + info pages indexed', s.byType);

  console.log(' degradation (an optional source failing must not kill the build)');
  failPages = true;
  const d = await fn.handler({ httpMethod: 'GET', queryStringParameters: { key: 'test-key', dry: '1' } });
  const ds = JSON.parse(d.body);
  ok(d.statusCode === 200, 'build still succeeds when pages:read is missing', d.statusCode);
  ok(ds.ok === true, 'reports ok', ds.ok);
  ok(ds.degraded === true, 'flags itself as degraded', ds.degraded);
  ok((ds.sourceErrors || []).some((e) => e.source === 'webflow:pages'), 'names the failed source', ds.sourceErrors);
  ok(/pages:read/.test(JSON.stringify(ds.sourceErrors || [])), 'preserves the underlying scope error', ds.sourceErrors);
  ok(ds.byType.product === 3, 'products still indexed', ds.byType);
  ok(ds.byType.brand === 1 && ds.byType.category === 3, 'brands and categories still indexed', ds.byType);
  ok(!ds.byType.page, 'no page docs, since that source was unavailable', ds.byType);
  failPages = false;

  console.log('\n' + (fails ? fails + ' failing' : 'all assertions passed') + '\n');
  process.exitCode = fails ? 1 : 0;
})().catch((e) => {
  console.error('test harness error', e);
  process.exitCode = 1;
});
