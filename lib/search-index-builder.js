/**
 * SEARCH INDEX BUILDER — WEBFLOW × AIRTABLE JOIN (shared module)
 * ────────────────────────────────────────────────────────────────────────────
 * Builds the site-search index and stores it in Netlify Blobs. `search-index.js`
 * serves it to the browser; a footer script does the actual matching client-side.
 *
 * WHY A JOIN, NOT ONE SOURCE
 *   Webflow and Airtable are not interchangeable:
 *     • WEBFLOW is the authority for what has a live, linkable URL. Airtable holds
 *       more product records than the site publishes (Distro Only / In-Store Only /
 *       Discontinued), so indexing from Airtable alone would invent dead links.
 *     • AIRTABLE is the authority for ranking signals (Number of Sales, Inventory,
 *       prices, descriptions) AND for the product→variant / product→FAQ graph.
 *   JOIN KEY IS `Slug`, NOT `Webflow Item ID`. The Airtable Products table has a
 *   `Webflow Item ID` field and it looks like the obvious key, but it is populated
 *   on only 42 of 566 products (7.4%) with stale 2022-2023 values — Whalesync
 *   handles the sync through its own internal mapping and never filled it in.
 *   Joining on it produced a 100% join failure that still LOOKED like a
 *   successful build: 715 docs, correct URLs, and every ranking signal null.
 *   `Slug` is populated on both sides and is what determines the URL anyway, so a
 *   slug mismatch would mean a broken link regardless. Item ID is kept only as a
 *   fallback for the few records that have it.
 *
 * WHY THE FOLDS MATTER
 *   Neither the Webflow `Product Variants` nor `FAQs` collection has a reference
 *   field pointing back to Products — that relationship exists ONLY in Airtable
 *   (`Products.Variants`, `Products.FAQs`). So folding must be driven from the
 *   Airtable side, walking outward from each product. Variants and FAQs are never
 *   standalone results; their text is folded into the parent product document.
 *   Measured payoff: variant flavor/strain/strength is what customers actually
 *   type ("blue raspberry", "1000mg", "indica").
 *
 * COMPLIANCE — 7-OH: MATCH IDENTITY, NOT EDUCATIONAL TEXT
 *   7-OH (7-hydroxymitragynine) is illegal and is not sold on this site. It is
 *   also one of the highest-volume historical search terms (~5.3k views/yr across
 *   276 spellings), so it must be excluded DELIBERATELY rather than by accident.
 *
 *   The patterns are matched against IDENTITY text only — product name, brand and
 *   variant names. They are deliberately NOT matched against folded FAQ text or
 *   descriptions. An earlier version did, and dropped 8 perfectly legal products
 *   (OPiA, Rave Kratom, Kraken Kratom, Buzzers, Script Botanicals) because kratom
 *   educational FAQs naturally mention 7-hydroxymitragynine — it is the active
 *   alkaloid in kratom. OPiA alone is the third most-searched brand on the site,
 *   so that false positive was expensive.
 *
 *   Body-text matches are not ignored, they are REPORTED: anything whose FAQ or
 *   description mentions 7-OH is still indexed but listed in stats.flaggedForReview
 *   so a human can judge it. Silent deletion and silent inclusion are both wrong;
 *   dropping on identity and flagging on discussion is the defensible middle.
 *
 *   If a genuine 7-OH product is ever added whose NAME does not say so, the review
 *   list is where it will show up. Check it.
 *
 * FAILURE POLICY — DEGRADE, DO NOT DIE
 *   Sources are split into required and optional. Webflow products and Airtable
 *   products are REQUIRED: an index with no products is not worth serving, so a
 *   failure there aborts and leaves the previous index in place. Everything else
 *   (variants, FAQs, brands, categories, static pages) is OPTIONAL — a failure is
 *   recorded in stats.sourceErrors and the build continues without it.
 *
 *   This matters because the sources have different permissions. The Webflow
 *   token needs `pages:read` for static pages but only `cms:read` for
 *   collections, so a token missing one scope should cost us landing pages, not
 *   the entire index. Any degradation is reported loudly rather than silently:
 *   check stats.sourceErrors before trusting a build.
 *
 * COST DISCIPLINE
 *   The Airtable workspace was at 1.77M/100k monthly API calls before the
 *   crossell-config cache fix, so this runs on a 6-hourly schedule (~5k calls/mo,
 *   ~5% of quota) rather than hourly (~30k, 30%). Airtable is rate-limited to
 *   5 req/s per base, so all Airtable reads are throttled (see THROTTLE_MS).
 *
 * SECURITY — FIELD ALLOWLIST, NEVER A DENYLIST
 *   The served index is PUBLICLY READABLE. The Airtable Products table has 174
 *   fields including Cost, Wholesale Cost (Tier 1-3), Base Unit Cost, MSRP. A
 *   denylist would silently leak the next cost field somebody adds. So every
 *   output field is explicitly constructed, and assertNoLeaks() fails the build
 *   if any key or value smells like margin data.
 *
 * THIS IS A SHARED MODULE, NOT A FUNCTION. It lives in lib/ because every file at
 * the top level of functions/ is deployed as its own function. Two thin wrappers
 * use it:
 *   • functions/search-index-build.js    — scheduled, 6-hourly (scheduler-only;
 *     Netlify does NOT expose scheduled functions over HTTP, so it cannot be
 *     curl'd for testing — that is what the rebuild endpoint is for).
 *   • functions/search-index-rebuild.js  — HTTP, key-protected, supports ?dry=1.
 *
 * Env: WEBFLOW_SEARCH_TOKEN (needs cms:read + pages:read; falls back to the
 *      shared WEBFLOW_API_TOKEN, which lacks pages:read), AIRTABLE_API_KEY (or
 *      AIRTABLE_TOKEN),
 *      optional AIRTABLE_BASE_ID / AIRTABLE_PRODUCTS_TABLE / AIRTABLE_VARIANTS_TABLE.
 */
'use strict';

const https = require('https');

/* ─── IDS ────────────────────────────────────────────────────────────────────── */

const WEBFLOW_API = 'https://api.webflow.com/v2';
const WF_SITE_ID  = process.env.WEBFLOW_SITE_ID || '627d284eb79828f894d0a981';

// Webflow collections. Only these become searchable documents.
const WF = {
  products:      '62a16d0c459d465de7ebf815',
  brands:        '62b8d929c89f59d002dff343',
  catPrimary:    '62f17faae806deec81029076',
  catParent:     '62a16fe92a02f92cb0875359',
  catSub:        '630d7bfa22283f5107c694e2',
};

// Published URL prefix per collection (from the Webflow template `publishedPath`).
const WF_PATH = {
  products:   '/product/',
  brands:     '/brand/',
  catPrimary: '/product-primary-categories/',
  catParent:  '/product-parent-categories/',
  catSub:     '/product-subcategories/',
};

const AIRTABLE_API   = 'https://api.airtable.com/v0';
const AT_BASE        = process.env.AIRTABLE_BASE_ID || 'appWUsGD3byrYcN3l';
const AT_PRODUCTS    = process.env.AIRTABLE_PRODUCTS_TABLE || 'tblkLl9qqg654fWi7';
const AT_VARIANTS    = process.env.AIRTABLE_VARIANTS_TABLE || 'tblEtb1aIH5Xk4Nh9';
const AT_FAQS        = process.env.AIRTABLE_FAQS_TABLE     || 'tblMadzmtWLZpBlWm';

const BLOB_STORE = 'search';
const BLOB_KEY   = 'index.json';
const INDEX_VERSION = 1;

/* Airtable allows 5 req/s per base. 250ms between calls keeps us at ~4/s with
 * headroom, which matters because this base is shared with every other function. */
const THROTTLE_MS = 250;

/* How much of each FAQ answer to index, in characters. 0 = questions only.
 *
 * Answers dominate the payload: with ~3.5 FAQs folded per product, indexing 200
 * characters of each pushed the index to 595KB uncompressed. Questions alone are
 * ~140 characters per product versus ~840 with answers. The question carries
 * nearly all of the matchable signal ("will this show on a drug test" is itself
 * phrased as a question), so answers are off by default. Raise this if search
 * recall on long natural-language queries proves weak. */
const FAQ_ANSWER_CHARS = 0;

/* Only these Airtable fields are ever read. Adding a field here is a deliberate
 * act; nothing arrives in the index by default. NO cost/wholesale fields. */
const AT_PRODUCT_FIELDS = [
  'Name', 'Slug', 'Webflow Item ID', 'Website Product Code',
  'Price', 'Sale Price', 'Lowest Price', 'Highest Price', 'On Sale',
  'Primary Image Webflow URL', 'Summary', 'Meta Description',
  'Number of Sales', 'Inventory', 'Variants Total Inventory',
  'Discontinued', 'Allow Backorders', 'In-Store Only', 'Distro Only', 'To Be Deleted',
  'Website Status', 'Variants', 'FAQs',
  'Name (from Brand)', 'Name (from Parent Categories)',
];
const AT_VARIANT_FIELDS = ['Name', 'Flavor', 'Strain', 'Strength', 'Size', 'Type', 'Website Product Code', 'Inventory'];
/* NB: the Airtable field is `Answer` (richText) — NOT `Answer Plain`, which is the
 * WEBFLOW field slug. Getting this wrong returns no answer text at all, silently,
 * because Airtable just omits unknown fields rather than erroring. */
const AT_FAQ_FIELDS     = ['Question', 'Answer', 'Display on FAQ Page'];

/* 7-OH. Deliberately specific phrases — NOT a bare "7", which would nuke
 * legitimate products ("7 pack", "Delta 7"). Matched against name + body text. */
const PROHIBITED_PATTERNS = [
  /\b7\s*-?\s*oh\b/i,
  /\b7\s*-?\s*hydroxy/i,
  /hydroxymitragynine/i,
];

/* Fail-closed guard: no output key or string value may look like margin data. */
const LEAK_RE = /cost|wholesale|tier|msrp|margin/i;

/* Static pages worth searching are everything published that is NOT a collection
 * template and NOT in these operational areas. */
const PAGE_EXCLUDE_RE = /^\/(templates|pending-removal|account|portal|wholesale-account)\//;
const PAGE_EXCLUDE_SLUGS = new Set([
  '404', '401', 'style-guide', 'sso', 'search', 'checkout', 'cart-design',
  'components-test', 'sitewide-popup', 'special-code', 'subcat-page',
  'reset-password-redirect', 'portal-login', 'login',
]);

/* ─── HTTP ───────────────────────────────────────────────────────────────────── */

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function airtableToken() {
  return process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN || '';
}

let airtableCalls = 0;

/* Paged Airtable read, throttled, restricted to an explicit field list. */
async function atFetchAll(table, fields, label) {
  const token = airtableToken();
  if (!token) throw new Error('AIRTABLE_API_KEY not set');
  const out = [];
  let offset = '';
  do {
    const qs = fields.map((f) => 'fields%5B%5D=' + encodeURIComponent(f)).join('&');
    const url = `${AIRTABLE_API}/${AT_BASE}/${table}?pageSize=100&${qs}`
      + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
    const res = await httpsReq(url, {
      headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
    });
    airtableCalls++;
    if (!res.ok || !res.json) {
      throw new Error(`Airtable ${label} ${res.status}: ${(res.text || '').slice(0, 200)}`);
    }
    for (const rec of (res.json.records || [])) out.push({ id: rec.id, f: rec.fields || {} });
    offset = res.json.offset || '';
    if (offset) await sleep(THROTTLE_MS);
  } while (offset);
  return out;
}

let webflowCalls = 0;

async function wfGet(path) {
  /* Prefer the search-specific token. It exists because search needs `pages:read`
   * on top of `cms:read`, while WEBFLOW_API_TOKEN is shared with
   * manage-subscription.js — a separate token means widening or rotating scopes
   * for search can never break subscription variant lookups. Falls back to the
   * shared token so the indexer still runs on an environment that lacks the new
   * one, just without static pages. */
  const token = process.env.WEBFLOW_SEARCH_TOKEN || process.env.WEBFLOW_API_TOKEN || '';
  if (!token) throw new Error('Neither WEBFLOW_SEARCH_TOKEN nor WEBFLOW_API_TOKEN is set');
  const res = await httpsReq(WEBFLOW_API + path, {
    headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
  });
  webflowCalls++;
  if (!res.ok) throw new Error(`Webflow GET ${path} (${res.status}): ${(res.text || '').slice(0, 150)}`);
  return res.json || {};
}

/* Paged Webflow collection read. Live items only: Webflow is our URL authority,
 * so a draft/archived item must never produce a search result. */
async function wfCollectionItems(collectionId, label) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 60; page++) {
    const data = await wfGet(`/collections/${collectionId}/items?limit=100&offset=${offset}`);
    const items = data.items || [];
    for (const it of items) {
      if (it.isDraft || it.isArchived) continue;
      out.push({ id: it.id, f: it.fieldData || {}, lastPublished: it.lastPublished || null });
    }
    const total = (data.pagination && data.pagination.total) || items.length;
    offset += items.length;
    if (!items.length || offset >= total) break;
    await sleep(60); // Webflow v2 is 60 req/min; 60ms spacing is well inside it.
  }
  if (!out.length) console.warn(`[search-index] ${label}: 0 live items`);
  return out;
}

/* ─── HELPERS ────────────────────────────────────────────────────────────────── */

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

function stripHtml(v) {
  return clean(String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' '));
}

function truncate(v, n) {
  const s = clean(v);
  return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

/* Identity match → exclude. Body-text match → flag for review but keep. */
function isProhibited(text) {
  return PROHIBITED_PATTERNS.some((re) => re.test(text));
}

/* Dedupe + drop empties, so folded text does not repeat the same flavour 40x. */
function uniqJoin(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = clean(v);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.join(' · ');
}

/* Fail the build rather than ship margin data to a public endpoint. */
function assertNoLeaks(docs) {
  for (const d of docs) {
    for (const k of Object.keys(d)) {
      if (LEAK_RE.test(k)) {
        throw new Error(`Leak guard: output key "${k}" on doc ${d.u || d.n}`);
      }
    }
  }
}

/* ─── BUILD ──────────────────────────────────────────────────────────────────── */

async function build() {
  const stats = {
    prohibitedDropped: [], flaggedForReview: [], unjoined: 0, excluded: {},
    variantsFolded: 0, faqsFolded: 0, faqsOrphaned: 0,
    sourceErrors: [],
  };

  /* Run an OPTIONAL source. On failure, record it and carry on with `fallback`
   * so one missing permission or flaky call cannot cost us the whole index.
   * Required sources are awaited directly and are allowed to throw. */
  async function optional(label, fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err && err.message) || err);
      console.error(`[search-index] optional source "${label}" failed:`, msg);
      stats.sourceErrors.push({ source: label, error: msg.slice(0, 300) });
      return fallback;
    }
  }
  const bump = (k) => { stats.excluded[k] = (stats.excluded[k] || 0) + 1; };

  /* 1 ── Webflow: what actually has a live URL. Products are required; the rest
   * degrade to empty so a partial outage costs coverage, not the whole index. */
  const wfProducts = await wfCollectionItems(WF.products, 'products');      // REQUIRED
  const wfBrands  = await optional('webflow:brands',     () => wfCollectionItems(WF.brands,     'brands'), []);
  const wfPrimary = await optional('webflow:categories:primary', () => wfCollectionItems(WF.catPrimary, 'primary-categories'), []);
  const wfParent  = await optional('webflow:categories:parent',  () => wfCollectionItems(WF.catParent,  'parent-categories'), []);
  const wfSub     = await optional('webflow:categories:sub',     () => wfCollectionItems(WF.catSub,     'subcategories'), []);

  /* 2 ── Airtable: ranking signals + the variant/FAQ graph. Products are
   * required — without them we would have URLs but no relevance signals, which
   * is the entire point of the join. Variants and FAQs only cost us folded text. */
  const atProducts = await atFetchAll(AT_PRODUCTS, AT_PRODUCT_FIELDS, 'products');  // REQUIRED
  await sleep(THROTTLE_MS);
  const atVariants = await optional('airtable:variants', () => atFetchAll(AT_VARIANTS, AT_VARIANT_FIELDS, 'variants'), []);
  await sleep(THROTTLE_MS);
  const atFaqs = await optional('airtable:faqs', () => atFetchAll(AT_FAQS, AT_FAQ_FIELDS, 'faqs'), []);

  const variantById = new Map(atVariants.map((v) => [v.id, v.f]));
  const faqById     = new Map(atFaqs.map((q) => [q.id, q.f]));

  /* Join maps. Slug is the primary key (see the header note); Webflow Item ID is
   * a fallback for the ~7% of records that carry one, which covers the case where
   * a slug was edited on one side but not the other.
   *
   * Slugs are normalised (trim + lowercase) because a difference in case alone
   * would silently drop a product's entire ranking signal. Collisions are counted
   * rather than ignored: two Airtable rows claiming one slug means one of them is
   * being discarded, and that is worth seeing in the report. */
  const atBySlug = new Map();
  const atByWfId = new Map();
  let slugCollisions = 0;
  for (const p of atProducts) {
    const slug = clean(p.f.Slug).toLowerCase();
    if (slug) {
      if (atBySlug.has(slug)) slugCollisions++;
      else atBySlug.set(slug, p);
    }
    const wfId = clean(p.f['Webflow Item ID']);
    if (wfId) atByWfId.set(wfId, p);
  }

  const docs = [];

  /* 3 ── PRODUCTS: Webflow URL + Airtable signals + folded variants/FAQs. */
  const faqUsed = new Set();
  let joinedBySlug = 0;
  let joinedByItemId = 0;
  let discontinuedIndexed = 0;
  for (const item of wfProducts) {
    const wf = item.f;
    const slug = clean(wf.slug);
    let at = slug ? atBySlug.get(slug.toLowerCase()) : undefined;
    if (at) {
      joinedBySlug++;
    } else {
      at = atByWfId.get(item.id);
      if (at) joinedByItemId++;
    }
    const name = clean(wf.name || (at && at.f.Name));
    if (!name || !slug) { bump('product:no name/slug'); continue; }

    // No Airtable match → we have a URL but no ranking signals. Index it anyway
    // (a live page should be findable) but flag it: a persistent count here means
    // `Webflow Item ID` is going stale in Airtable.
    if (!at) stats.unjoined++;
    const a = at ? at.f : {};

    /* `Discontinued` deliberately does NOT exclude. It means "we will not be
     * reordering this", NOT unavailable — discontinued items often still have
     * stock and are still sold. Treating it as an availability flag removed 114
     * live, sellable products from search.
     *
     * The governing rule: Webflow presence decides what exists on the site;
     * Airtable flags describe purchasing intent, not availability. Real
     * availability comes from Inventory / Variants Total Inventory / Allow
     * Backorders, which feed the `st` flag below. Discontinued is carried as
     * `dc` so the front end can badge "while supplies last" or demote once stock
     * runs low — a merchandising signal, never a filter.
     *
     * The three below matched ZERO live products in the 2026-07-30 build, so they
     * are harmless safety nets rather than active filters. Their exact semantics
     * are unconfirmed — ask before relying on them. */
    if (truthy(a['In-Store Only'])) { bump('product:in-store only'); continue; }
    if (truthy(a['Distro Only']))   { bump('product:distro only');   continue; }
    if (truthy(a['To Be Deleted'])) { bump('product:to be deleted'); continue; }

    // Fold variants: the differentiators customers type.
    const variantIds = Array.isArray(a.Variants) ? a.Variants : [];
    const variantText = [];
    for (const vid of variantIds) {
      const v = variantById.get(vid);
      if (!v) continue;
      stats.variantsFolded++;
      variantText.push(v.Flavor, v.Strain, v.Strength, v.Size, v.Type);
    }

    // Fold FAQ questions (high signal) + truncated answers (low signal).
    const faqIds = Array.isArray(a.FAQs) ? a.FAQs : [];
    const faqText = [];
    for (const qid of faqIds) {
      const q = faqById.get(qid);
      if (!q) continue;
      faqUsed.add(qid);
      stats.faqsFolded++;
      faqText.push(clean(q.Question));
      if (FAQ_ANSWER_CHARS > 0) faqText.push(truncate(stripHtml(q.Answer), FAQ_ANSWER_CHARS));
    }

    const folded = uniqJoin(variantText);
    const faqs   = uniqJoin(faqText);
    const desc   = truncate(stripHtml(a.Summary || a['Meta Description'] || ''), 180);
    const brand  = clean([].concat(a['Name (from Brand)'] || [])[0]);
    const cats   = [].concat(a['Name (from Parent Categories)'] || []).map(clean).filter(Boolean);

    /* Compliance guard. IDENTITY only — name, brand, variant names. Descriptions
     * and folded FAQ text are excluded on purpose: kratom FAQs legitimately
     * discuss 7-hydroxymitragynine, and matching them dropped 8 legal products
     * including a top-3 searched brand. See the header note. */
    const identity = [name, brand, folded].join(' ');
    if (isProhibited(identity)) {
      stats.prohibitedDropped.push(name);
      continue;
    }
    // Mentioned only in body text → keep it, but surface it for a human to judge.
    if (isProhibited([faqs, desc].join(' '))) {
      stats.flaggedForReview.push(name);
    }

    // In stock = own inventory, or any variant's (a variant parent's own
    // Inventory formula reads 0, so the rollup is the real signal).
    if (truthy(a.Discontinued)) discontinuedIndexed++;

    const inv = num(a.Inventory) || 0;
    const varInv = num(a['Variants Total Inventory']) || 0;
    const inStock = (inv > 0 || varInv > 0 || truthy(a['Allow Backorders'])) ? 1 : 0;

    docs.push({
      t: 'product',
      n: name,
      u: WF_PATH.products + slug,
      b: brand || undefined,
      c: cats.length ? cats : undefined,
      img: clean(a['Primary Image Webflow URL']) || undefined,
      // Variant parents have no own Price — the rollups carry it. Fall back so a
      // product with variants still shows a price rather than nothing.
      p: num(a.Price) != null ? num(a.Price) : num(a['Lowest Price']),
      sp: truthy(a['On Sale']) ? num(a['Sale Price']) : null,
      lo: num(a['Lowest Price']),
      hi: num(a['Highest Price']),
      s: num(a['Number of Sales']) || 0,   // popularity — the main ranking signal
      st: inStock,
      // Not being reordered. Still sellable while stock lasts — badge or demote,
      // do not hide. See the note above.
      dc: truthy(a.Discontinued) ? 1 : undefined,
      x: folded || undefined,              // variant flavours/strains/strengths
      q: faqs || undefined,                // folded FAQ text
      d: desc || undefined,
    });
  }

  /* Orphan FAQs: not attached to any product. Those flagged for the FAQ page get
   * folded into /faq; the rest are genuinely orphaned content and are dropped. */
  const faqPageText = [];
  for (const q of atFaqs) {
    if (faqUsed.has(q.id)) continue;
    if (truthy(q.f['Display on FAQ Page'])) {
      faqPageText.push(clean(q.f.Question));
    } else {
      stats.faqsOrphaned++;
    }
  }

  /* 4 ── BRANDS. ~18% of measured searches are brand-seeking, and today a brand
   * query substring-matches product names in merchandising order instead of
   * surfacing the brand page. These docs are what let us fix that. */
  for (const item of wfBrands) {
    const wf = item.f;
    const name = clean(wf.name);
    const slug = clean(wf.slug);
    if (!name || !slug) { bump('brand:no name/slug'); continue; }
    if (truthy(wf['don-t-display'])) { bump('brand:don-t-display'); continue; }
    const desc = truncate(stripHtml(wf['short-description-2'] || wf['meta-description'] || ''), 180);
    if (isProhibited([name, desc].join(' '))) { stats.prohibitedDropped.push('brand:' + name); continue; }
    docs.push({
      t: 'brand',
      n: name,
      u: WF_PATH.brands + slug,
      img: (wf.logo && clean(wf.logo.url)) || undefined,
      d: desc || undefined,
    });
  }

  /* 5 ── CATEGORIES (3 levels). The top measured query "vape pens" (13k views)
   * is category intent, not a product name — these need to be findable. */
  for (const [key, items] of [['catPrimary', wfPrimary], ['catParent', wfParent], ['catSub', wfSub]]) {
    for (const item of items) {
      const wf = item.f;
      const name = clean(wf.name);
      const slug = clean(wf.slug);
      if (!name || !slug) { bump(key + ':no name/slug'); continue; }
      const desc = truncate(stripHtml(wf['meta-description'] || ''), 180);
      if (isProhibited([name, desc].join(' '))) { stats.prohibitedDropped.push(key + ':' + name); continue; }
      docs.push({ t: 'category', n: name, u: WF_PATH[key] + slug, d: desc || undefined });
    }
  }

  /* 6 ── STATIC PAGES: ~50 hand-built commercial landing pages (delta-8-gummies-
   * edibles, thc-vape-pens-carts …) plus info/policy pages. High-intent targets.
   * Drafts are ~half of all pages here, so the draft filter is load-bearing. */
  /* Needs the `pages:read` scope, which collection reads do not. This is why
   * WEBFLOW_SEARCH_TOKEN exists separately from the shared WEBFLOW_API_TOKEN.
   * A token missing the scope costs us landing pages only — hence optional. */
  const pages = await optional('webflow:pages', async () => {
    let pageOffset = 0;
    const acc = [];
    for (let i = 0; i < 10; i++) {
      const data = await wfGet(`/sites/${WF_SITE_ID}/pages?limit=100&offset=${pageOffset}`);
      const batch = data.pages || [];
      acc.push(...batch);
      const total = (data.pagination && data.pagination.total) || batch.length;
      pageOffset += batch.length;
      if (!batch.length || pageOffset >= total) break;
      await sleep(60);
    }
    return acc;
  }, []);
  for (const pg of pages) {
    if (pg.draft || pg.archived) { bump('page:draft/archived'); continue; }
    if (pg.collectionId) continue;                       // collection template, not a page
    const path = clean(pg.publishedPath || (pg.slug ? '/' + pg.slug : ''));
    if (!path || path === '/') continue;                 // home needs no search result
    if (PAGE_EXCLUDE_RE.test(path)) { bump('page:operational'); continue; }
    if (PAGE_EXCLUDE_SLUGS.has(clean(pg.slug))) { bump('page:excluded slug'); continue; }
    const name = clean((pg.seo && pg.seo.title) || pg.title);
    if (!name) { bump('page:no title'); continue; }
    const desc = truncate(stripHtml((pg.seo && pg.seo.description) || ''), 180);
    if (isProhibited([name, desc, path].join(' '))) { stats.prohibitedDropped.push('page:' + path); continue; }
    const isFaqPage = path === '/faq';
    docs.push({
      t: 'page',
      n: name,
      u: path,
      d: desc || undefined,
      // General site FAQs fold into /faq rather than becoming 1,143 thin results.
      q: isFaqPage && faqPageText.length ? uniqJoin(faqPageText) : undefined,
    });
  }

  assertNoLeaks(docs);

  return {
    index: { v: INDEX_VERSION, builtAt: new Date().toISOString(), docs },
    stats: {
      docs: docs.length,
      byType: docs.reduce((m, d) => (m[d.t] = (m[d.t] || 0) + 1, m), {}),
      webflowLive: {
        products: wfProducts.length, brands: wfBrands.length,
        primary: wfPrimary.length, parent: wfParent.length, sub: wfSub.length,
        pages: pages.length,
      },
      airtable: { products: atProducts.length, variants: atVariants.length, faqs: atFaqs.length },
      variantsFolded: stats.variantsFolded,
      faqsFolded: stats.faqsFolded,
      faqsToFaqPage: faqPageText.length,
      faqsOrphanedDropped: stats.faqsOrphaned,
      joinedBySlug,
      joinedByItemId,
      discontinuedIndexed,
      slugCollisions,
      unjoinedProducts: stats.unjoined,
      degraded: stats.sourceErrors.length > 0,
      sourceErrors: stats.sourceErrors,
      prohibitedDropped: stats.prohibitedDropped,
      flaggedForReview: stats.flaggedForReview,
      excluded: stats.excluded,
      apiCalls: { airtable: airtableCalls, webflow: webflowCalls },
    },
  };
}

/* ─── EXPORTS ─────────────────────────────────────────────────────────────── */

/* Persist a freshly built index. Kept here so both wrappers write identically.
 * Returns a short diagnostic string describing what happened, because Blobs
 * initialisation is the most likely thing to fail on a new deploy. */
async function writeIndex(index) {
  const { getStore } = require('@netlify/blobs');
  const store = getStore(BLOB_STORE);
  await store.setJSON(BLOB_KEY, index);
  return `wrote ${BLOB_KEY} to store "${BLOB_STORE}"`;
}

module.exports = { build, writeIndex, BLOB_STORE, BLOB_KEY, INDEX_VERSION };
