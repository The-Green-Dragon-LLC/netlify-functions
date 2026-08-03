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

const path = require('path');

/* ─── FIXTURES ───────────────────────────────────────────────────────────────── */

const wfProducts = {
  items: [
    { id: 'wf1', isDraft: false, isArchived: false, fieldData: { name: 'Blue Dream Gummies', slug: 'blue-dream-gummies' } },
    { id: 'wf2', isDraft: true,  isArchived: false, fieldData: { name: 'Draft Product', slug: 'draft-product' } },
    { id: 'wf3', isDraft: false, isArchived: false, fieldData: { name: '7-OH Tablets', slug: '7oh-tablets' } },
    { id: 'wf4', isDraft: false, isArchived: false, fieldData: { name: 'Discontinued Thing', slug: 'disc-thing' } },
    { id: 'wf5', isDraft: false, isArchived: false, fieldData: { name: 'Orphan No Airtable', slug: 'orphan' } },
    { id: 'wf6', isDraft: false, isArchived: false, fieldData: { name: 'TRE House Carts', slug: 'tre-house-carts' } },
    { id: 'wf7', isDraft: false, isArchived: false, fieldData: { name: 'Renamed Product', slug: 'new-slug-in-webflow' } },
    // Legal kratom product. Its FAQ mentions 7-hydroxymitragynine because that is
    // the active alkaloid in kratom — it must stay indexed, only flagged.
    { id: 'wf8', isDraft: false, isArchived: false, fieldData: { name: 'OPiA - Kratom Extract Tablets', slug: 'opia-kratom-tablets' } },
    // Description DISCLAIMS 7-OH, in raw markdown exactly as production does.
    { id: 'wf9', isDraft: false, isArchived: false, fieldData: { name: 'Buzzers - Botanical Tablets', slug: 'buzzers-botanical-tablets' } },
  ],
  pagination: { total: 8 },
};

const wfBrands = {
  items: [
    { id: 'b1', isDraft: false, isArchived: false, fieldData: { name: 'TRĒ House', slug: 'tre-house', 'short-description-2': '<p>Great brand</p>', logo: { url: 'https://img/tre.png' } } },
    { id: 'b2', isDraft: false, isArchived: false, fieldData: { name: 'Hidden Brand', slug: 'hidden', "don-t-display": true } },
  ],
  pagination: { total: 2 },
};

/* Blog posts. 307 published articles were unreachable by search: the box filters the
 * product list, and the index had no blog documents either. The draft below must not be
 * indexed, and the body must NOT be folded in — only title and summary. */
const wfBlog = {
  items: [
    { id: 'bl1', isDraft: false, isArchived: false, fieldData: {
      name: 'How To Store Your Gummies', slug: 'how-to-store-gummies',
      'post-summary': 'Keep them cool and dry so they last.',
      'post-body': '<p>A very long article body that must never reach the index because it would multiply the payload for prose nobody searches.</p>',
      'thumbnail-image': { url: 'https://img/gummies-thumb.png' } } },
    { id: 'bl2', isDraft: true, isArchived: false, fieldData: {
      name: 'Unpublished Draft Article', slug: 'draft-article', 'post-summary': 'Not live yet.' } },
    // Educational article that DISCUSSES 7-OH: flagged for review, not dropped.
    { id: 'bl3', isDraft: false, isArchived: false, fieldData: {
      name: 'Understanding Kratom Alkaloids', slug: 'kratom-alkaloids',
      'post-summary': 'A look at mitragynine and 7-hydroxymitragynine in kratom leaf.' } },
  ],
  pagination: { total: 3 },
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
    // Title is clean; the SEO description carries a disclaimer. Must NOT be dropped
    // — matching page descriptions is what removed /simple-brands in production.
    { slug: 'simple-brands', publishedPath: '/simple-brands', draft: false, title: 'Simple Brands', seo: { title: 'Simple Brands', description: 'Our tablets do not contain 7OH or MGM.' } },
    { slug: 'search', publishedPath: '/search', draft: false, title: 'Search Results' },
  ],
  pagination: { total: 7 },
};

/* Records join on SLUG, mirroring production: `Webflow Item ID` is populated on
 * only 7% of real records, so most fixtures deliberately omit it. Casing differs
 * from the Webflow slug on purpose — the join normalises, and a case-only
 * difference silently costing a product its entire ranking signal is exactly the
 * bug this pins.
 *
 * Cost/wholesale fields are present in this RESPONSE on purpose: the allowlist
 * should never request them, and the leak guard must keep them out of output
 * even if Airtable returns them anyway. */
const atProducts = {
  records: [
    { id: 'a1', fields: {
      Name: 'Blue Dream Gummies', Slug: 'Blue-Dream-Gummies', Price: 29.99, 'Sale Price': 19.99, 'On Sale': true,
      'Lowest Price': 19.99, 'Highest Price': 39.99, 'Number of Sales': 812, Inventory: 0,
      'Variants Total Inventory': 14, 'Primary Image Webflow URL': 'https://img/bd.png',
      Summary: '<p>A <strong>tasty</strong> gummy.</p>', 'Name (from Brand)': ['TRĒ House'],
      'Name (from Parent Categories)': ['Gummies & Edibles', 'Delta 9'],
      Variants: ['v1', 'v2', 'v3'], FAQs: ['q1', 'q2'],
      Cost: 4.20, 'Wholesale Cost (Tier 1)': 9.99, MSRP: 49.99,
    } },
    // Duplicate slug — one of these must be discarded and counted, not silently dropped.
    { id: 'a1b', fields: { Name: 'Blue Dream Gummies DUPE', Slug: 'blue-dream-gummies', 'Number of Sales': 1 } },
    { id: 'a3', fields: { Name: '7-OH Tablets', Slug: '7oh-tablets', Price: 19.99, Inventory: 5, 'Number of Sales': 3000 } },
    // Discontinued but IN STOCK — must stay searchable, flagged not filtered.
    { id: 'a4', fields: { Name: 'Discontinued Thing', Slug: 'disc-thing', Discontinued: true, Inventory: 9, Price: 5.55, 'Number of Sales': 20 } },
    // Variant parent: no own Price, so the Lowest Price rollup must be used.
    { id: 'a6', fields: { Name: 'TRE House Carts', Slug: 'tre-house-carts', 'Lowest Price': 24.99, 'Highest Price': 34.99, Inventory: 0, 'Allow Backorders': true, 'Number of Sales': 55 } },
    // Slug was changed in Webflow but not Airtable — must fall back to item id.
    { id: 'a8', fields: { Name: 'Renamed Product', Slug: 'old-slug-in-airtable', 'Webflow Item ID': 'wf7', Price: 12.34, 'Number of Sales': 7, Inventory: 3 } },
    { id: 'a7', fields: { Name: 'In Store Only Item', Slug: 'in-store-only', 'In-Store Only': true } },
    { id: 'a9', fields: { Name: 'OPiA - Kratom Extract Tablets', Slug: 'opia-kratom-tablets', Price: 9.99, 'Number of Sales': 2281, Inventory: 12, FAQs: ['q5'] } },
    { id: 'a10', fields: { Name: 'Buzzers - Botanical Tablets', Slug: 'buzzers-botanical-tablets', Price: 34.99, 'Number of Sales': 282, Inventory: 7,
      Summary: '75mg per tablet. **_Does not contain 7OH or MGM._**' } },
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
    { id: 'q5', fields: { Question: 'What is 7-hydroxymitragynine?', Answer: 'An alkaloid found in kratom.' } },
  ],
};

/* ─── HTTP STUB ──────────────────────────────────────────────────────────────── */

function route(p) {
  if (p.includes('/collections/62a16d0c459d465de7ebf815/items')) return wfProducts;
  if (p.includes('/collections/62b8d929c89f59d002dff343/items')) return wfBrands;
  if (p.includes('/collections/62f17faae806deec81029076/items')) return wfCats('THC', 'thc');
  if (p.includes('/collections/62a16fe92a02f92cb0875359/items')) return wfCats('Vape Pens', 'vape-pens');
  if (p.includes('/collections/630d7bfa22283f5107c694e2/items')) return wfCats('THC Vape Pens & Carts', 'thc-vape-pens-carts');
  if (p.includes('/collections/6282946248e4a660f233ed15/items')) return wfBlog;
  if (p.includes('/pages')) return wfPages;
  if (p.includes('tblkLl9qqg654fWi7')) return atProducts;
  if (p.includes('tblEtb1aIH5Xk4Nh9')) return atVariants;
  if (p.includes('tblMadzmtWLZpBlWm')) return atFaqs;
  throw new Error('unrouted fixture path: ' + p);
}

const seenPaths = [];
/* Flipped by the degradation scenario to simulate WEBFLOW_SEARCH_TOKEN lacking the
 * `pages:read` scope — the real 403 that policy exists to survive. */
let failPages = false;

/* The builder uses global fetch, not node:https — it must stay import-free so it
 * can be bundled into an ESM v2 function. So the stub replaces fetch. */
globalThis.fetch = async (url) => {
  const p = String(url);
  seenPaths.push(p);
  if (failPages && p.includes('/pages')) {
    return new Response(
      JSON.stringify({ message: "OAuthForbidden: You are missing the following scopes - 'pages:read'", code: 'missing_scopes' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify(route(p)), { status: 200, headers: { 'content-type': 'application/json' } });
};

/* ─── RUN ────────────────────────────────────────────────────────────────────── */

process.env.WEBFLOW_SEARCH_TOKEN = 'test';
process.env.AIRTABLE_API_KEY = 'test';
process.env.SEARCH_INDEX_KEY = 'test-key';

/* Test the shared builder directly. The HTTP wrappers are v2 (.mts) functions —
 * required because @netlify/blobs only auto-configures on the v2 runtime — and a
 * CommonJS test cannot require those. The auth check therefore lives in the lib as
 * keyMatches() so it stays covered here. */
const { build, keyMatches } = require(path.join(__dirname, '..', 'lib', 'search-index-builder.js'));

let fails = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '   <<< got: ' + JSON.stringify(extra)));
  if (!cond) fails++;
}

(async () => {
  const built = await build();
  // Shape the stats the way the wrapper reports them, so assertions read the same.
  const s = { ...built.stats, sample: built.index.docs.slice(0, 8) };
  // `sample` is only the first 8 docs; the blog assertions below need the full set.
  const docs = built.index.docs;

  console.log('\nsearch-index-build\n');

  console.log(' auth');
  ok(keyMatches('test-key', 'test-key') === true, 'accepts the correct key');
  ok(keyMatches(null, 'test-key') === false, 'rejects a missing key');
  ok(keyMatches('nope', 'test-key') === false, 'rejects a wrong key');
  ok(keyMatches('test-ke', 'test-key') === false, 'rejects a truncated key');
  ok(keyMatches('anything', '') === false, 'rejects everything when no key is configured');

  console.log(' compliance (7-OH must never be indexed)');
  ok(s.prohibitedDropped.some((x) => /7-OH Tablets/.test(x)), 'drops a product named for 7-OH', s.prohibitedDropped);
  // Page/brand/category drops are prefixed; bare entries are products.
  const droppedProducts = s.prohibitedDropped.filter((x) => !/^(page|brand|cat)/.test(x));
  ok(droppedProducts.length === 1, 'drops ONLY that one product — no false positives', droppedProducts);
  /* The expensive false positive: kratom FAQs legitimately discuss
   * 7-hydroxymitragynine. Matching body text dropped 8 legal products including
   * OPiA, the third most-searched brand on the site. */
  const opia = (s.sample || []).find((d) => /OPiA/.test(d.n || ''));
  ok(!s.prohibitedDropped.some((x) => /OPiA/.test(x)), 'does NOT drop legal kratom whose FAQ mentions the compound', s.prohibitedDropped);
  ok((s.flaggedForReview || []).some((x) => /OPiA/.test(x)), 'flags it for human review instead', s.flaggedForReview);
  /* NEGATIONS ARE NOT MENTIONS. Several real descriptions read "Does not contain
   * 7OH or MGM" — a compliance statement. Treating those as risks flagged 8 clean
   * products and dropped the /simple-brands page, and a review list that is all
   * false alarms does not get read. */
  ok(!(s.flaggedForReview || []).some((x) => /Buzzers/.test(x)), '"Does not contain 7OH" is a disclaimer, not a mention', s.flaggedForReview);
  ok(!s.prohibitedDropped.some((x) => /simple-brands/.test(x)), 'page with a disclaimer in its SEO description survives', s.prohibitedDropped);
  ok(!(s.flaggedForReview || []).some((x) => /simple-brands/.test(x)), 'and is not flagged either', s.flaggedForReview);
  const buzz = (s.sample || []).find((d) => /Buzzers/.test(d.n || ''));
  ok(buzz && !/[*_]{2}/.test(String(buzz.d || '')), 'markdown emphasis stripped from descriptions', buzz && buzz.d);
  ok(!!opia && opia.s === 2281, 'and keeps it indexed with its signals', opia && [opia.n, opia.s]);
  ok(s.prohibitedDropped.some((x) => /7oh-info/.test(x)), 'drops a 7-OH static page', s.prohibitedDropped);

  console.log(' security (public index must carry no margin data)');
  const flat = JSON.stringify(s.sample || []);
  ok(!/cost|wholesale|tier|msrp|margin/i.test(flat), 'no cost/wholesale/msrp in output docs');
  const atCall = seenPaths.find((p) => p.includes('tblkLl9qqg654fWi7')) || '';
  ok(/fields%5B%5D=/.test(atCall), 'Airtable read is restricted to an allowlist');
  ok(!/Cost|Wholesale|MSRP/i.test(decodeURIComponent(atCall)), 'allowlist requests no cost fields');

  console.log(' exclusions');
  ok(s.byType.product === 7, '7 products indexed (draft + 7-OH excluded; discontinued KEPT)', s.byType);
  /* Discontinued means "not reordering", NOT unavailable. Excluding it removed
   * 114 live, sellable products from search. */
  ok(!s.excluded['product:discontinued'], 'discontinued is NOT an exclusion reason', s.excluded);
  ok(s.discontinuedIndexed === 1, 'discontinued product counted as indexed', s.discontinuedIndexed);
  const disc = (s.sample || []).find((d) => d.n === 'Discontinued Thing');
  ok(!!disc, 'discontinued product IS in the index', (s.sample || []).map((d) => d.n));
  ok(disc && disc.dc === 1, 'carries the dc flag so the UI can badge it', disc && disc.dc);
  ok(disc && disc.st === 1, 'and is in stock, since it still has inventory', disc && disc.st);
  ok((s.excluded['brand:don-t-display'] || 0) === 1, "brand flagged don't-display excluded", s.excluded);
  ok((s.excluded['page:draft/archived'] || 0) === 1, 'draft page excluded', s.excluded);
  ok((s.excluded['page:operational'] || 0) === 1, 'operational /portal/ page excluded', s.excluded);
  ok((s.excluded['page:excluded slug'] || 0) === 1, 'legacy /search page excluded', s.excluded);
  ok(s.unjoinedProducts === 1, 'product with no Airtable row still indexed, and counted', s.unjoinedProducts);

  /* THE REGRESSION GUARD. Joining on `Webflow Item ID` failed for 100% of real
   * products while still producing a plausible-looking index: right doc count,
   * right URLs, every ranking signal null. Counting docs would not have caught
   * it; asserting that joined products actually CARRY signals does. */
  console.log(' join (slug primary, item id fallback)');
  // Counted before exclusions, so the 7-OH and discontinued rows join then drop.
  ok(s.joinedBySlug === 6, 'joins on slug, case-insensitively', s.joinedBySlug);
  ok(s.joinedByItemId === 1, 'falls back to Webflow Item ID when the slug moved', s.joinedByItemId);
  ok(s.slugCollisions === 1, 'duplicate Airtable slug counted, not silently dropped', s.slugCollisions);
  ok(s.joinedBySlug + s.joinedByItemId === 7, 'all Airtable-backed products joined by some key', [s.joinedBySlug, s.joinedByItemId]);
  const byName = (n) => (s.sample || []).find((d) => d.n === n);
  const renamed = byName('Renamed Product');
  ok(renamed && renamed.s === 7 && renamed.p === 12.34, 'item-id fallback still carries signals', renamed);
  const tre = byName('TRE House Carts');
  ok(tre && tre.p === 24.99, 'variant parent falls back to Lowest Price for display', tre && tre.p);
  const orph = byName('Orphan No Airtable');
  ok(orph && orph.s === 0 && orph.p == null, 'unjoined product indexed but flagged by zero signals', orph);

  console.log(' folds');
  ok(s.variantsFolded === 3, '3 variants folded into their parent', s.variantsFolded);
  ok(s.faqsFolded === 3, 'product FAQs folded', s.faqsFolded);
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
    ok(!/Possibly\./.test(String(bd.q)), 'FAQ answers omitted by default to control payload size', String(bd.q));
    ok(!/<strong>/.test(bd.d || ''), 'HTML stripped from the description', bd.d);
  }

  console.log(' coverage');
  ok(s.byType.brand === 1, 'brands indexed', s.byType);

  /* Blog posts — 307 published articles that search could not reach at all. */
  ok(s.byType.blog === 2, 'published blog posts indexed, the draft excluded', s.byType);
  const post = docs.find((d) => d.t === 'blog' && /Store Your Gummies/.test(d.n));
  ok(!!post, 'a blog document is produced');
  ok(post && post.u === '/blog/how-to-store-gummies', 'blog URL uses the /blog/ prefix', post && post.u);
  ok(post && post.d === 'Keep them cool and dry so they last.', 'summary is indexed', post && post.d);
  ok(post && /gummies-thumb/.test(post.img || ''), 'thumbnail carried for the card', post && post.img);
  ok(!docs.some((d) => d.t === 'blog' && /very long article body/.test(JSON.stringify(d))),
    'post-body is NOT folded in — it would multiply the payload for prose nobody types');
  ok(!docs.some((d) => d.u === '/blog/draft-article'), 'a draft article cannot be linked to');
  ok((s.flaggedForReview || []).some((x) => /Kratom Alkaloids/.test(x)),
    'an article discussing 7-OH is flagged for review, not dropped', s.flaggedForReview);
  ok(!s.prohibitedDropped.some((x) => /Kratom Alkaloids/.test(x)),
    'and stays in the index — educational text is not a compliance failure');
  ok(s.byType.category === 3, 'all three category levels indexed', s.byType);
  ok(s.byType.page === 3, 'landing + info pages indexed', s.byType);

  console.log(' degradation (an optional source failing must not kill the build)');
  failPages = true;
  const dbuilt = await build();
  const ds = { ...dbuilt.stats, sample: dbuilt.index.docs.slice(0, 8) };
  ok(!!dbuilt.index, 'build still succeeds when pages:read is missing', !!dbuilt.index);
  ok(Array.isArray(dbuilt.index.docs) && dbuilt.index.docs.length > 0, 'still returns documents', dbuilt.index.docs.length);
  ok(ds.degraded === true, 'flags itself as degraded', ds.degraded);
  ok((ds.sourceErrors || []).some((e) => e.source === 'webflow:pages'), 'names the failed source', ds.sourceErrors);
  ok(/pages:read/.test(JSON.stringify(ds.sourceErrors || [])), 'preserves the underlying scope error', ds.sourceErrors);
  ok(ds.byType.product === 7, 'products still indexed', ds.byType);
  ok(ds.byType.brand === 1 && ds.byType.category === 3, 'brands and categories still indexed', ds.byType);
  ok(!ds.byType.page, 'no page docs, since that source was unavailable', ds.byType);
  failPages = false;

  console.log('\n' + (fails ? fails + ' failing' : 'all assertions passed') + '\n');
  process.exitCode = fails ? 1 : 0;
})().catch((e) => {
  console.error('test harness error', e);
  process.exitCode = 1;
});
