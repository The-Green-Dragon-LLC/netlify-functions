/**
 * TGD INSTANT SEARCH — header dropdown
 * ────────────────────────────────────────────────────────────────────────────
 * Attaches typo-tolerant instant search to the existing header search box and
 * ranks results by real signals instead of CMS order.
 *
 * WHAT IT REPLACES
 *   Today the box submits to /shop-all-products?*=<term>, where Finsweet CMS Filter
 *   does a SUBSTRING match over the rendered product list and returns hits in the
 *   list's existing sort order. That means no typo tolerance, no synonyms, no
 *   relevance ranking, and products only — brands, categories, landing pages, blog
 *   posts and FAQs are unreachable.
 *
 * EVERY RANKING DECISION HERE COMES FROM MEASURED DEMAND
 *   From 12 months of GA4 (175,871 typed searches, 22,046 distinct):
 *     • 18% of searches are brand-seeking — so an exact brand match pins the brand
 *       page above products (BRAND_PIN_BOOST).
 *     • "vape pens" is the single top query at 13,363 views, which is category /
 *       landing-page intent, not a product name — categories and landing pages are
 *       first-class results, not an afterthought.
 *     • 3,592 views land on brand MISSPELLINGS. "tre house" cannot substring-match
 *       "TRĒ House" because of the macron, so text is diacritic-folded (fold()).
 *     • Concepts are spelled many ways — 276 for 7-OH, 99 for vape pens, 205 for
 *       gummies — hence SYNONYMS.
 *     • Variant flavours are what people type ("blue raspberry"), so the folded
 *       variant field is weighted like a name, not like body text.
 *
 * COMPLIANCE — 7-OH
 *   7-OH is illegal and not sold. It is also one of the highest-volume historical
 *   queries (~5.3k views/yr). The index contains no 7-OH products, so a search would
 *   return an empty dropdown that reads like a site fault. RETIRED answers those
 *   queries with a plain statement instead, and deliberately offers NO substitutes —
 *   suggesting alternatives for a banned substance is not a UX win.
 *
 * PROGRESSIVE ENHANCEMENT
 *   If the index cannot load, or JS fails, the form still submits exactly as it does
 *   now and Finsweet still filters. Nothing here removes existing behaviour.
 */
(function () {
  'use strict';

  /* The `v` is the index SCHEMA version, and it is a cache key, not decoration.
   *
   * The index response is held in Netlify's durable cache, which a new deploy does NOT
   * invalidate — measured: a cached copy kept serving with age=6852s straight through a
   * production deploy. So when the builder starts emitting new fields, every client
   * keeps getting the old shape until the TTL happens to lapse. Changing this URL
   * changes the cache key, which is the only way to guarantee a client sees the new
   * shape immediately.
   *
   * BUMP THIS whenever the builder adds or renames an index field, or adds a document
   * type. v2 = `r`/`rc` (Yotpo aggregate) and `br` (brands per category). v3 = `blog`
   * documents. */
  var INDEX_URL = 'https://wondrous-bublanina-d440ec.netlify.app/.netlify/functions/search-index?v=3';

  /* ─── TEXT NORMALISATION ──────────────────────────────────────────────────── */

  /* Fold to a comparable form: lowercase, strip diacritics, collapse punctuation.
   * The diacritic strip is not cosmetic — "TRĒ House" is a real brand and
   * "tre house" / "trehouse" drew 549 views a year that could never match it. */
  function fold(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function tokens(s) {
    var f = fold(s);
    return f ? f.split(' ') : [];
  }

  /* Spaces removed. Users concatenate brand names constantly — "trehouse" (111
   * views), "spacegods" (189), "domewrecker" (137) — and a space-splitting tokeniser
   * can never match those against "TRĒ House". Comparing against a squashed form
   * costs one extra string per field and recovers all three. */
  function squash(s) {
    return fold(s).replace(/ /g, '');
  }

  /* ─── SYNONYMS ────────────────────────────────────────────────────────────── */

  /* Seeded from the measured spelling clusters. Each key expands to extra tokens
   * that are ALSO searched, so "vapes" finds "vape pens" without the query having
   * to match literally. Kept small and hand-picked: a long auto-generated list
   * makes everything match everything, which is worse than a few misses. */
  var SYNONYMS = {
    vape: ['vapes', 'pen', 'pens', 'disposable', 'cart', 'carts', 'cartridge'],
    vapes: ['vape', 'pen', 'pens'],
    pen: ['vape', 'pens'],
    pens: ['vape', 'pen'],
    cart: ['carts', 'cartridge', 'vape'],
    carts: ['cart', 'cartridge', 'vape'],
    cartridge: ['cart', 'carts'],
    disposable: ['vape', 'pen'],
    gummy: ['gummies', 'edible', 'edibles'],
    gummies: ['gummy', 'edible', 'edibles'],
    gummie: ['gummies'],
    gummi: ['gummies'],
    edible: ['edibles', 'gummies'],
    edibles: ['edible', 'gummies'],
    preroll: ['prerolls', 'pre', 'roll', 'rolls', 'joint'],
    prerolls: ['preroll', 'pre', 'roll', 'rolls'],
    joint: ['preroll', 'prerolls'],
    joints: ['preroll', 'prerolls'],
    tincture: ['tinctures', 'oil', 'oils'],
    tinctures: ['tincture', 'oil', 'oils'],
    oil: ['tincture', 'tinctures'],
    oils: ['tincture', 'tinctures'],
    d8: ['delta', '8'],
    d9: ['delta', '9'],
    weed: ['thc', 'cannabis'],
    shroom: ['mushroom', 'mushrooms'],
    shrooms: ['mushroom', 'mushrooms'],
    flower: ['bud', 'buds'],
    drink: ['drinks', 'beverage', 'beverages'],
    drinks: ['drink', 'beverage', 'beverages'],
  };

  /* Words that carry no matching signal. They are NOT stripped from the query — they
   * still contribute score if they happen to match — they are excluded from the
   * COVERAGE test below, where counting them does real damage: "cbd oil for dogs" is
   * four tokens, so requiring 60% meant three had to land, and "for" almost never
   * lands anywhere useful. That dropped the CBD Oils / Tinctures category from a query
   * plainly asking for it. Judging coverage on the words that carry meaning keeps a
   * two-word brand query strict without punishing a sentence. */
  var STOPWORDS = {
    a: 1, an: 1, and: 1, are: 1, as: 1, at: 1, be: 1, best: 1, but: 1, by: 1, can: 1,
    do: 1, does: 1, for: 1, from: 1, get: 1, good: 1, in: 1, is: 1, it: 1, me: 1, my: 1,
    of: 1, on: 1, or: 1, our: 1, s: 1, that: 1, the: 1, their: 1, to: 1, top: 1, use: 1,
    what: 1, which: 1, with: 1, you: 1, your: 1,
  };

  function contentTokens(qTokens) {
    var out = [];
    for (var i = 0; i < qTokens.length; i++) {
      if (!STOPWORDS[qTokens[i]]) out.push(qTokens[i]);
    }
    // An all-stopword query ("the best") has nothing to judge, so fall back to all.
    return out.length ? out : qTokens;
  }

  function expand(qTokens) {
    var out = qTokens.slice();
    var seen = {};
    for (var i = 0; i < qTokens.length; i++) seen[qTokens[i]] = true;
    for (var j = 0; j < qTokens.length; j++) {
      var extra = SYNONYMS[qTokens[j]];
      if (!extra) continue;
      for (var k = 0; k < extra.length; k++) {
        if (!seen[extra[k]]) { seen[extra[k]] = true; out.push(extra[k]); }
      }
    }
    return out;
  }

  /* ─── RETIRED / PROHIBITED TERMS ──────────────────────────────────────────── */

  /* Matched on the folded query, so "7-oh", "7 oh", "7oh" and "7 hydroxy" all land
   * here. NOT a bare "7", which would swallow "7 pack" and similar. */
  var RETIRED = [
    {
      test: /\b7\s?oh\b|\b7\s?hydroxy|hydroxymitragynine/,
      message: 'We no longer carry 7-OH (7-hydroxymitragynine) products.',
    },
  ];

  function retiredFor(query) {
    var f = fold(query);
    for (var i = 0; i < RETIRED.length; i++) {
      if (RETIRED[i].test.test(f)) return RETIRED[i].message;
    }
    return null;
  }

  /* ─── FUZZY MATCHING ──────────────────────────────────────────────────────── */

  /* Bounded Levenshtein: gives up as soon as the distance exceeds `max`, so this
   * stays cheap even across every token of 800 documents. */
  function within(a, b, max) {
    if (a === b) return 0;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return -1;
    var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var best = cur[0];
      for (j = 1; j <= lb; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return -1;           // whole row already too far
      for (j = 0; j <= lb; j++) prev[j] = cur[j];
    }
    return prev[lb] <= max ? prev[lb] : -1;
  }

  /* How much typo tolerance a token earns. Short tokens get none: at 3 characters,
   * edit distance 1 makes "cbd" match "cba" and "abd", which is noise not recall. */
  function tolerance(t) {
    if (t.length <= 3) return 0;
    if (t.length <= 6) return 1;
    return 2;
  }

  /* Score one query token against one field's token list.
   * Exact > prefix > fuzzy, because an exact hit is evidence and a fuzzy hit is a
   * guess; collapsing them would let misspellings outrank real matches. */
  function tokenScore(qt, fieldTokens) {
    var best = 0;
    for (var i = 0; i < fieldTokens.length; i++) {
      var ft = fieldTokens[i];
      if (ft === qt) return 1;
      /* Prefix matching, with a length rule.
       *
       * At 3 characters an unrestricted prefix matches far too much ordinary body copy:
       * "tre" is a prefix of "treats", which is why searching "tre house" returned
       * Daily Pet Co., Gigli and The Functional Chocolate Company — not one of them a
       * brand the query names, all three matched on marketing text.
       *
       * But requiring 4 outright broke inflections on short words: "oil" stopped
       * matching "oils", which lost the CBD Oils / Tinctures category from "cbd oil for
       * dogs". So a 3-character token may still prefix-match a word at most ONE
       * character longer, which is a plural or a simple inflection and nothing else —
       * "oil"→"oils" and "pen"→"pens" pass, "tre"→"treats" does not. */
      if (ft.length > qt.length && ft.indexOf(qt) === 0
          && (qt.length >= 4 || ft.length - qt.length <= 1)) {
        if (best < 0.8) best = 0.8;                       // prefix: "gumm" → "gummies"
        continue;
      }
      var tol = tolerance(qt);
      if (tol > 0) {
        var d = within(qt, ft, tol);
        if (d >= 0) {
          var s = 0.6 - (d - 1) * 0.15;                   // d=1 → 0.6, d=2 → 0.45
          if (s > best) best = s;
        }
      }
    }
    return best;
  }

  /* Same exact > prefix > fuzzy ladder, against a squashed field string. Only worth
   * trying for longer tokens: a 3-character query against a squashed name matches
   * far too much. */
  function squashScore(qt, sq) {
    if (!sq || qt.length < 5) return 0;
    if (qt === sq) return 1;
    if (sq.indexOf(qt) === 0) return 0.8;
    var tol = tolerance(qt);
    if (tol > 0) {
      var d = within(qt, sq, tol);
      if (d >= 0) return 0.6 - (d - 1) * 0.15;
    }
    return 0;
  }

  /* ─── SCORING ─────────────────────────────────────────────────────────────── */

  /* Field weights. `x` (folded variant flavours/strains/strengths) sits close to the
   * name on purpose — measurement says people type "blue raspberry", and that text
   * lives nowhere else. `q` (FAQ questions) and `d` (description) stay low so a
   * passing mention cannot outrank a product actually named for the term. */
  /* `br` is the list of brands sold inside a category, and it is weighted BELOW a
   * product's own brand field (6) on purpose. A brand query should return the brand
   * page, then its products, then the categories it sells into — not the other way
   * round. It only needs to be strong enough to bring the category into its own
   * section at all, which is where the results page shows it. */
  var WEIGHTS = { n: 10, b: 6, c: 4, x: 7, q: 2, d: 1.5, br: 3.5 };

  /* An exact brand-name query jumps the brand page above its own products. 18% of
   * searches are brand-seeking, and someone typing "flying horse" wants the brand,
   * not whichever of its products happens to sort first. */
  var BRAND_PIN_BOOST = 26;

  var TYPE_BASE = { product: 0, brand: 1.5, category: 1.2, page: 1.0, blog: 0.6 };

  /* RATING AS A RANKING SIGNAL — DELIBERATELY SMALL.
   *
   * Review counts on this catalogue are tiny: the twelve best-sellers carry 1, 1, 1,
   * 2, 3, 5, 8, 8 and 14 reviews, and three have none at all. A raw average would be
   * mostly noise — a single 5.0 review would outrank a 4.9 backed by eight, and a
   * quarter of top products would be penalised for having no reviews yet rather than
   * for being worse.
   *
   * So the score is shrunk toward the catalogue mean in proportion to how few reviews
   * back it (Bayesian shrinkage). With PRIOR_WEIGHT = 8, a lone 5.0 barely moves while
   * a 4.9 with 14 reviews moves most of the way. RATING_WEIGHT is then kept low so
   * rating breaks ties rather than deciding them: text relevance and actual sales
   * remain the primary signals.
   *
   * Revisit PRIOR_WEIGHT if review volume grows by an order of magnitude. */
  var PRIOR_MEAN = 4.6;
  var PRIOR_WEIGHT = 8;
  var RATING_WEIGHT = 2.5;
  /* Scale the deviation against ONE STAR, not against the 0.4 of headroom between the
   * mean and 5.0. Dividing by that headroom made the scale wildly asymmetric: a 4.0
   * rated product lost 2.4 points while a perfect score could only gain 0.4 worth —
   * punishing a perfectly good product harder than it rewarded an excellent one.
   * Clamped so no rating can dominate text relevance. */
  var RATING_SPAN = 1;

  function ratingBoost(d) {
    var r = Number(d.r), c = Number(d.rc);
    if (!isFinite(r) || r <= 0) return 0;              // unrated is neutral, not penalised
    if (!isFinite(c) || c < 0) c = 0;
    var adjusted = (c * r + PRIOR_WEIGHT * PRIOR_MEAN) / (c + PRIOR_WEIGHT);
    // Centre on the prior so an average product gets no advantage either way.
    var delta = (adjusted - PRIOR_MEAN) / RATING_SPAN;
    if (delta > 1) delta = 1;
    if (delta < -1) delta = -1;
    return RATING_WEIGHT * delta;
  }

  function prepare(index) {
    var docs = index && index.docs ? index.docs : [];
    var prepared = new Array(docs.length);
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      prepared[i] = {
        doc: d,
        f: {
          n: tokens(d.n),
          b: tokens(d.b),
          c: tokens((d.c || []).join(' ')),
          x: tokens(d.x),
          q: tokens(d.q),
          d: tokens(d.d),
          br: tokens((d.br || []).join(' ')),
        },
        nameFolded: fold(d.n),
        // Only the identity-ish fields; squashing a description is meaningless.
        sq: { n: squash(d.n), b: squash(d.b), x: squash(d.x) },
        /* Each brand squashed SEPARATELY. Joining them first would concatenate
         * neighbours into strings that match nothing real — "trehousespacegods" — and
         * could produce matches spanning two different brand names. */
        sqbr: (d.br || []).map(squash),
        maxSales: 0,
      };
    }
    // Popularity is compared against the catalogue, so normalise once up front.
    var top = 1;
    for (var j = 0; j < docs.length; j++) top = Math.max(top, Number(docs[j].s) || 0);
    for (var k = 0; k < prepared.length; k++) prepared[k].maxSales = top;
    return prepared;
  }

  function scoreDoc(entry, qTokens, expanded, foldedQuery) {
    var d = entry.doc, f = entry.f, total = 0, matchedAny = false;

    /* A category's brand list only counts when the query actually NAMES one of its
     * brands — every token of that brand present, or the squashed form contained.
     *
     * Deliberately NO fuzzy tolerance here, unlike every other field. Typo tolerance is
     * right when matching the thing itself, but this is an INDIRECT association, and
     * compounding a guessed match with a derived link produces confident nonsense:
     * "house" and "horse" are one edit apart, so "tre house" matched Flying Horse and
     * inherited its Kratom categories, while "flying horse" pulled in all nine of TRĒ
     * House's. Both looked authoritative and both were wrong.
     *
     * Nothing is lost by being strict: a misspelled brand still matches the brand page
     * and its products through their own fields, which is where the typo tolerance
     * belongs. Only the category link requires certainty. */
    var brandNamed = (d.br && d.br.length) ? !!matchedBrand(d, foldedQuery) : false;

    for (var i = 0; i < expanded.length; i++) {
      var qt = expanded[i];
      // Expanded synonyms count for less than what the user actually typed.
      var isOriginal = qTokens.indexOf(qt) !== -1;
      var weightScale = isOriginal ? 1 : 0.5;
      var bestForToken = 0;
      for (var key in WEIGHTS) {
        if (!f[key] || !f[key].length) continue;
        if (key === 'br' && !brandNamed) continue;
        var s = tokenScore(qt, f[key]) * WEIGHTS[key];
        if (s > bestForToken) bestForToken = s;
      }
      // Joined-word forms: "trehouse" against "tre house".
      for (var sk in entry.sq) {
        var ss = squashScore(qt, entry.sq[sk]) * WEIGHTS[sk];
        if (ss > bestForToken) bestForToken = ss;
      }
      // Same, for the brands inside a category: "trehouse" should find Delta 8.
      if (brandNamed) {
        for (var bi = 0; bi < entry.sqbr.length; bi++) {
          var bss = squashScore(qt, entry.sqbr[bi]) * WEIGHTS.br;
          if (bss > bestForToken) bestForToken = bss;
        }
      }
      if (bestForToken > 0) { matchedAny = true; total += bestForToken * weightScale; }
    }
    if (!matchedAny) return 0;

    /* Require most of a multi-word query to land somewhere. Without this, "flying
     * horse gummies" matches every gummy on the strength of one token.
     *
     * Judged on the MEANINGFUL tokens only — see contentTokens(). */
    var content = contentTokens(qTokens);
    if (content.length > 1) {
      var hits = 0;
      for (var t = 0; t < content.length; t++) {
        var landed = false;
        for (var key2 in WEIGHTS) {
          if (key2 === 'br' && !brandNamed) continue;
          if (f[key2] && f[key2].length && tokenScore(content[t], f[key2]) > 0) { landed = true; break; }
        }
        if (!landed) {
          for (var sk2 in entry.sq) {
            if (squashScore(content[t], entry.sq[sk2]) > 0) { landed = true; break; }
          }
        }
        if (landed) hits++;
      }
      /* Was ceil(n/2), which for a two-word query is ONE — so half a query landing
       * anywhere was enough to return a document. "tre house" came back with brands
       * where only "tre" matched, inside a description, and "house" matched nothing.
       * 60% means a two-word query needs both words, while longer queries can still
       * tolerate a stray term: 3 tokens need 2, 4 need 3, 5 need 3. */
      if (hits < Math.ceil(content.length * 0.6)) return 0;
    }

    /* Whole-query exactness beats an accumulation of partial hits. The squashed
     * comparison means "trehouse" is treated as exactly as "tre house" — otherwise
     * the concatenated spelling would match but never pin. */
    var squashedQuery = foldedQuery.replace(/ /g, '');
    var exactName = entry.nameFolded === foldedQuery || entry.sq.n === squashedQuery;
    if (exactName) total += 20;
    else if (entry.nameFolded.indexOf(foldedQuery) === 0) total += 8;

    if (d.t === 'brand' && exactName) total += BRAND_PIN_BOOST;
    total += TYPE_BASE[d.t] || 0;

    /* Popularity: real sales, compressed by log so a 3,000-sale product does not
     * bury a well-matched 50-sale one. This is the signal the current search has no
     * access to at all. */
    var sales = Number(d.s) || 0;
    if (sales > 0) total += 6 * (Math.log1p(sales) / Math.log1p(entry.maxSales));

    /* Out of stock is demoted, never hidden. Discontinued items are NOT demoted for
     * being discontinued — that flag means "not reordering", and they still sell. */
    if (d.t === 'product' && !d.st) total *= 0.55;

    if (d.t === 'product') total += ratingBoost(d);

    return total;
  }

  function search(prepared, query, limit) {
    var qTokens = tokens(query);
    if (!qTokens.length) return [];
    var expanded = expand(qTokens);
    var foldedQuery = fold(query);
    var out = [];
    for (var i = 0; i < prepared.length; i++) {
      var s = scoreDoc(prepared[i], qTokens, expanded, foldedQuery);
      if (s > 0) out.push({ doc: prepared[i].doc, score: s });
    }
    out.sort(function (a, b) {
      return b.score - a.score || String(a.doc.n).localeCompare(String(b.doc.n));
    });
    return out.slice(0, limit || 40);
  }

  /* ─── UI ──────────────────────────────────────────────────────────────────── */

  /* The visible header input lives inside the Header Searchbar component (120
   * instances). #field-3, the Finsweet sidebar filter, is deliberately LEFT ALONE:
   * it filters the product list in place and works. Hooking it would mean fighting
   * Finsweet for control of the same list. */
  var INPUT_SELECTOR = '#search-bar, input.search-input.navbar';

  /* The full results page. /search is reused deliberately: it already exists, and it
   * drew 1 pageview in twelve months, so there is no traffic or ranking to protect.
   * The page needs one Embed element containing <div id="tgd-search-results"></div>;
   * everything else is rendered here. */
  var RESULTS_PATH = '/search';
  var RESULTS_SELECTOR = '#tgd-search-results';
  var RESULTS_PAGE_SIZE = 24;
  var GROUPS = [
    { t: 'product',  label: 'Products',   max: 6 },
    { t: 'brand',    label: 'Brands',     max: 3 },
    { t: 'category', label: 'Categories', max: 3 },
    { t: 'page',     label: 'Pages',      max: 3 },
    /* Articles last and capped low. They are the largest content type by count (307)
     * and the lowest purchase intent, so they must not crowd out products — but they
     * were completely unreachable before, which is worse. */
    { t: 'blog',     label: 'Articles',   max: 3 }
  ];

  var prepared = null, loading = null, panel = null, active = -1, rows = [], lastQuery = '';

  function loadIndex() {
    /* Lazily, on first interaction. ~93KB gzipped is cheap, but there is no reason
     * to spend it on visitors who never search. */
    if (loading) return loading;
    loading = fetch(INDEX_URL, { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('index ' + r.status); return r.json(); })
      .then(function (json) { prepared = prepare(json); return prepared; })
      .catch(function (err) {
        /* Leave the form to submit as it always has. Search must never be BLOCKED by
         * this script failing — that would be a regression, not a feature. */
        console.warn('[tgd-search] index unavailable, falling back to filter page:', err.message);
        prepared = null;
        return null;
      });
    return loading;
  }

  function fmt(v) { return '$' + Number(v).toFixed(2); }

  function money(d) {
    var base = d.p != null ? d.p : (d.lo != null ? d.lo : null);
    if (base == null) return '';
    if (d.sp != null && d.sp < base) return '<s>' + fmt(base) + '</s> ' + fmt(d.sp);
    /* A range only when the ends genuinely differ. "$11.11 - $11.11" is a real bug on
     * the current results page and there is no reason to reproduce it. */
    if (d.lo != null && d.hi != null && d.hi > d.lo) return fmt(d.lo) + ' \u2013 ' + fmt(d.hi);
    return fmt(base);
  }

  /* Stars as text rather than SVG or an icon font: no extra requests, no font
   * dependency, and it survives the CMS having no rating at all (renders nothing). */
  function stars(d) {
    var r = Number(d.r), c = Number(d.rc);
    if (!isFinite(r) || r <= 0) return '';
    var full = Math.floor(r + 0.001);
    var half = r - full >= 0.25 && r - full < 0.75;
    var body = '';
    for (var i = 0; i < 5; i++) {
      body += i < full ? '\u2605' : (i === full && half ? '\u00bd' : '\u2606');
    }
    var count = isFinite(c) && c > 0 ? ' <span class="tgd-rc">(' + c + ')</span>' : '';
    return '<span class="tgd-stars" title="' + r.toFixed(1) + ' out of 5'
      + (isFinite(c) && c > 0 ? ' from ' + c + ' review' + (c === 1 ? '' : 's') : '')
      + '" aria-label="Rated ' + r.toFixed(1) + ' out of 5">' + body + '</span>' + count;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var CSS = [
    '.tgd-search-panel{position:absolute;z-index:99999;display:none;max-height:70vh;overflow-y:auto;',
    'background:#fff;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.18);',
    'font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a}',
    '.tgd-search-panel[data-open="1"]{display:block}',
    '.tgd-g{padding:6px 12px 2px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a7a7a}',
    '.tgd-r{display:flex;gap:10px;align-items:center;padding:8px 12px;cursor:pointer;text-decoration:none;color:inherit}',
    '.tgd-r:hover,.tgd-r[aria-selected="true"]{background:#f1f5f2}',
    '.tgd-r img{width:36px;height:36px;object-fit:contain;flex:0 0 36px;background:#fafafa;border-radius:4px}',
    '.tgd-t{flex:1;min-width:0}',
    '.tgd-n{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tgd-m{font-size:12px;color:#6b6b6b}',
    '.tgd-p{font-weight:600;white-space:nowrap}',
    '.tgd-p s{color:#9a9a9a;font-weight:400;margin-right:4px}',
    '.tgd-b{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;font-size:10px;vertical-align:1px}',
    '.tgd-oos{background:#f3e3e3;color:#8a2b2b}',
    '.tgd-stars{color:#e0a01a;letter-spacing:1px;font-size:12px}',
    '.tgd-rc{color:#8a8a8a;font-size:11px}',
    '.tgd-dc{background:#f1ecd8;color:#7a6320}',
    '.tgd-msg{padding:14px 12px;color:#5a5a5a}',
    '.tgd-all{display:block;padding:10px 12px;border-top:1px solid #eee;color:#276749;text-decoration:none;font-weight:600}'
  ].join('');

  function ensurePanel(input) {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.className = 'tgd-search-panel';
    panel.id = 'tgd-search-panel';
    panel.setAttribute('role', 'listbox');
    document.body.appendChild(panel);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', 'tgd-search-panel');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('autocomplete', 'off');

    var css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    return panel;
  }

  function place(input) {
    var r = input.getBoundingClientRect();
    panel.style.top = (r.bottom + window.scrollY + 6) + 'px';
    panel.style.left = (r.left + window.scrollX) + 'px';
    panel.style.width = Math.max(320, Math.min(r.width, 560)) + 'px';
  }

  function close() {
    if (!panel) return;
    panel.removeAttribute('data-open');
    var input = document.querySelector(INPUT_SELECTOR);
    if (input) input.setAttribute('aria-expanded', 'false');
    active = -1;
    rows = [];
  }

  /* The full results page, which can show every content type. */
  function resultsUrl(q) {
    return RESULTS_PATH + '?q=' + encodeURIComponent(q);
  }

  /* Exactly what the box does today. Used when the index could not load, so a bare
   * Enter and the fallback link still reach Finsweet's filter rather than a page that
   * cannot render anything. */
  function fallbackUrl(q) {
    return '/shop-all-products?*=' + encodeURIComponent(q);
  }

  /* Which URL "See all" should use depends on whether the index is usable: sending
   * someone to a JS-rendered results page that has no index would show them an empty
   * screen, whereas the filter page still works on its own. */
  function seeAllUrl(q) {
    return prepared ? resultsUrl(q) : fallbackUrl(q);
  }

  function rowHtml(d, i) {
    var badge = '';
    if (d.t === 'product' && !d.st) badge += '<span class="tgd-b tgd-oos">Out of stock</span>';
    /* "While supplies last" rather than hiding it: Discontinued means we are not
     * reordering, NOT that it is unavailable. */
    if (d.dc) badge += '<span class="tgd-b tgd-dc">While supplies last</span>';
    return '<a class="tgd-r" role="option" href="' + esc(d.u) + '" data-i="' + i + '">'
      + (d.img ? '<img src="' + esc(d.img) + '" alt="" loading="lazy">' : '')
      + '<span class="tgd-t"><span class="tgd-n">' + esc(d.n) + badge + '</span>'
      + (d.b && d.t === 'product' ? '<span class="tgd-m">' + esc(d.b) + ' ' + stars(d) + '</span>'
         : (d.t === 'product' && stars(d) ? '<span class="tgd-m">' + stars(d) + '</span>' : ''))
      + '</span>'
      + (d.t === 'product' ? '<span class="tgd-p">' + money(d) + '</span>' : '')
      + '</a>';
  }

  function render(input, query, results, retiredMessage) {
    ensurePanel(input);
    place(input);
    rows = [];
    var html = '';

    if (retiredMessage) {
      /* Deliberately no results and no suggestions. An empty dropdown reads as a site
       * fault; offering substitutes for a banned substance would be worse than that. */
      html += '<div class="tgd-msg">' + esc(retiredMessage) + '</div>';
    } else if (!results.length) {
      html += '<div class="tgd-msg">No matches for \u201c' + esc(query) + '\u201d.</div>';
      html += '<a class="tgd-all" href="' + esc(fallbackUrl(query)) + '">Browse all products</a>';
    } else {
      for (var gi = 0; gi < GROUPS.length; gi++) {
        var grp = GROUPS[gi];
        var hits = [];
        for (var ri = 0; ri < results.length && hits.length < grp.max; ri++) {
          if (results[ri].doc.t === grp.t) hits.push(results[ri].doc);
        }
        if (!hits.length) continue;
        /* Show the total for the type, not just how many fit here, so "Brands 4" tells
         * you more exists behind "See all". */
        var totalOfType = 0;
        for (var ci = 0; ci < results.length; ci++) if (results[ci].doc.t === grp.t) totalOfType++;
        html += '<div class="tgd-g">' + grp.label
          + (totalOfType > hits.length ? ' (' + totalOfType + ')' : '') + '</div>';
        for (var hi = 0; hi < hits.length; hi++) {
          rows.push(hits[hi]);
          html += rowHtml(hits[hi], rows.length - 1);
        }
      }
      html += '<a class="tgd-all" href="' + esc(seeAllUrl(query))
        + '">See all results for \u201c' + esc(query) + '\u201d</a>';
    }

    panel.innerHTML = html;
    panel.setAttribute('data-open', '1');
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  }

  /* GA4 through the existing GTM container (GTM-KPK8VKF). These two events are what
   * make zero-result and low-CTR queries visible; neither is measurable today. */
  function track(event, params) {
    try {
      window.dataLayer = window.dataLayer || [];
      var payload = { event: event };
      for (var k in params) payload[k] = params[k];
      window.dataLayer.push(payload);
    } catch (_) {}
  }

  function highlight(delta) {
    var els = panel.querySelectorAll('.tgd-r');
    if (!els.length) return;
    if (active >= 0 && els[active]) els[active].setAttribute('aria-selected', 'false');
    active += delta;
    if (active < 0) active = els.length - 1;
    if (active >= els.length) active = 0;
    els[active].setAttribute('aria-selected', 'true');
    if (els[active].scrollIntoView) els[active].scrollIntoView({ block: 'nearest' });
  }

  function attach(input) {
    if (input.getAttribute('data-tgd-search') === '1') return;
    input.setAttribute('data-tgd-search', '1');

    var timer = null;
    input.addEventListener('focus', function () { loadIndex(); });

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var q = input.value.trim();
        if (q.length < 2) { close(); return; }
        lastQuery = q;

        var retired = retiredFor(q);
        if (retired) {
          render(input, q, [], retired);
          track('search', { search_term: q, results_count: 0, retired: true });
          return;
        }

        loadIndex().then(function () {
          if (!prepared) return;                      // fall back to form submit
          if (input.value.trim() !== q) return;       // a newer keystroke already won
          var results = search(prepared, q, 40);
          render(input, q, results, null);
          track('search', { search_term: q, results_count: results.length });
        });
      }, 130);
    });

    input.addEventListener('keydown', function (e) {
      var open = panel && panel.getAttribute('data-open') === '1';
      if (e.key === 'ArrowDown' && open) { e.preventDefault(); highlight(1); }
      else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlight(-1); }
      else if (e.key === 'Escape') { close(); }
      else if (e.key === 'Enter') {
        if (open && active >= 0 && rows[active]) {
          // A highlighted row wins: go straight to that result.
          e.preventDefault();
          var d = rows[active];
          track('search_result_click', {
            search_term: input.value.trim(), position: active + 1,
            item_id: d.u, result_type: d.t
          });
          window.location.href = d.u;
          return;
        }
        var q = input.value.trim();
        if (prepared && q.length >= 2) {
          /* Nothing highlighted: go to the full results page, which can show brands,
           * categories and pages. Letting this fall through to the form would land on
           * Finsweet's substring-filtered product list - the very thing being
           * replaced. */
          e.preventDefault();
          window.location.href = resultsUrl(q);
          return;
        }
        /* No index (or too short): fall through to the form and let Finsweet filter.
         * A page that renders from an index we do not have would be blank, so the old
         * behaviour is genuinely the better outcome here. */
      }
    });
  }

  function onDocClick(e) {
    if (!panel || !e.target.closest) return;
    var row = e.target.closest('.tgd-r');
    if (row) {
      var d = rows[Number(row.getAttribute('data-i'))];
      if (d) {
        track('search_result_click', {
          search_term: lastQuery, position: Number(row.getAttribute('data-i')) + 1,
          item_id: d.u, result_type: d.t
        });
      }
      return;                                        // let the anchor navigate
    }
    if (!e.target.closest('.tgd-search-panel')) close();
  }

  /* ─── FULL RESULTS PAGE ───────────────────────────────────────────────────── */

  var RESULTS_CSS = [
    '.tgd-res{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a}',
    '.tgd-res h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#7a7a7a;margin:28px 0 10px}',
    '.tgd-res h2:first-child{margin-top:0}',
    '.tgd-res-sum{color:#5a5a5a;margin-bottom:8px}',
    '.tgd-res-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}',
    '.tgd-card{display:block;text-decoration:none;color:inherit;border:1px solid #e6e6e6;border-radius:8px;padding:12px;background:#fff}',
    '.tgd-card:hover{border-color:#276749;box-shadow:0 4px 14px rgba(0,0,0,.07)}',
    '.tgd-card img{width:100%;height:150px;object-fit:contain;background:#fafafa;border-radius:6px;margin-bottom:10px}',
    '.tgd-card-n{display:block;font-weight:600;margin-bottom:2px}',
    '.tgd-card-m{display:block;font-size:13px;color:#6b6b6b;margin-bottom:6px}',
    '.tgd-card-p{font-weight:700}',
    '.tgd-card-p s{color:#9a9a9a;font-weight:400;margin-right:5px}',
    '.tgd-card-brand img{height:96px;padding:10px;background:#fff;border:1px solid #f2f2f2}',
    '.tgd-card-init{display:flex;align-items:center;justify-content:center;height:96px;',
    'margin-bottom:10px;border-radius:6px;background:#f1f5f2;color:#276749;',
    'font-weight:700;font-size:26px;letter-spacing:1px}',
    '.tgd-card-d{display:block;font-size:12px;color:#6b6b6b;line-height:1.45}',
    '.tgd-list a{display:block;padding:9px 0;border-bottom:1px solid #eee;text-decoration:none;color:inherit}',
    '.tgd-list-m{color:#7a8a80;font-size:12px;margin-left:8px}',
    '.tgd-more{margin-top:14px;padding:9px 16px;border:1px solid #276749;background:#fff;color:#276749;',
    'border-radius:6px;font-weight:600;cursor:pointer}',
    '.tgd-res-empty{padding:24px 0;color:#5a5a5a}',
    '.tgd-res-note{padding:16px;background:#f7f4e8;border:1px solid #e4dcc0;border-radius:8px;color:#5d4f22}',
    '.tgd-jump{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 22px}',
    '.tgd-jump a{display:inline-block;padding:6px 12px;border:1px solid #d6ddd8;border-radius:999px;',
    'text-decoration:none;color:#276749;font-size:13px;font-weight:600;background:#fff}',
    '.tgd-jump a:hover{background:#f1f5f2;border-color:#276749}',
    '.tgd-jump a .tgd-jump-n{color:#7a8a80;font-weight:400;margin-left:4px}',
    /* Offset is MEASURED at runtime, not guessed — see stickyOffset(). The fallback
     * only applies before the measurement runs or if it fails. */
    '.tgd-res h2{scroll-margin-top:var(--tgd-sticky, 120px)}'
  ].join('');

  /* How much of the top of the viewport is covered by fixed or sticky chrome.
   *
   * This site stacks a fixed search bar and an announcement bar, and their combined
   * height differs between breakpoints and changes if the announcement bar is
   * dismissed — so a hardcoded offset is wrong somewhere by construction. A first
   * version used 110px and overshot, hiding the heading behind the header.
   *
   * Measures every fixed/sticky element that actually straddles y=0 and takes the
   * lowest bottom edge, which handles stacked bars without double-counting overlaps. */
  function stickyOffset() {
    /* Collect candidate top chrome once. */
    var bars = [];
    var els = document.querySelectorAll('body *');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.className && String(el.className).indexOf('tgd-') === 0) continue;  // our own UI
      var cs;
      try { cs = window.getComputedStyle(el); } catch (_) { continue; }
      if (!cs) continue;
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      var r = el.getBoundingClientRect();
      if (r.height <= 0 || r.height > 300) continue;   // not a bar; skip full-height overlays
      if (r.bottom <= 0) continue;                     // scrolled out above
      bars.push(r);
    }

    /* Grow the covered band. A second bar STACKED under the first has top > 0, so
     * requiring every bar to straddle y=0 misses it — that returned 56 instead of 100
     * for this site's search bar plus announcement bar. Extend the band while any bar
     * starts within it, which also ignores unrelated floating chrome further down. */
    var covered = 0;
    for (var pass = 0; pass < 5; pass++) {
      var grew = false;
      for (var b = 0; b < bars.length; b++) {
        if (bars[b].top <= covered + 4 && bars[b].bottom > covered) {
          covered = bars[b].bottom;
          grew = true;
        }
      }
      if (!grew) break;
    }
    return Math.round(covered);
  }

  var SCROLL_GAP = 16;                 // breathing room between header and heading

  /* What is ACTUALLY covering the top of the viewport — asked of the browser rather
   * than inferred from CSS.
   *
   * Two earlier attempts modelled the header, and both were wrong in the same
   * direction, because what they measured is not what ends up covering the heading:
   *
   *   1. A hardcoded 110px. Wrong at every breakpoint but one.
   *   2. Enumerating fixed/sticky elements — but it ran BEFORE the scroll, while the
   *      page was still at the top and a sticky bar had not yet stuck. At rest such a
   *      bar sits in normal flow below y=0, so nothing straddled the top edge and the
   *      offset came out ~0. It only reaches top: 0 once the page moves, which is
   *      exactly when it matters.
   *
   * And "which elements count as top chrome" is a guess however it is written:
   * announcement bars, promo strips and scroll-aware navs each break a different rule.
   *
   * So put the heading at y=0 FIRST, then hit-test straight down through whatever sits
   * on top of it. elementFromPoint answers "what would a click land on here", which is
   * the real question. Walking up to each hit's nearest pinned ancestor stops a
   * statically-positioned child inside a fixed bar from ending the walk early, and
   * stopping at unpinned content keeps it from wandering off into the page. */
  function chromeOver(el) {
    if (typeof document.elementFromPoint !== 'function') return stickyOffset();
    var r = el.getBoundingClientRect();
    var vw = window.innerWidth || 1024;
    var x = Math.round(Math.min(vw - 2, Math.max(2, r.left + r.width / 2)));
    var covered = 0;
    for (var i = 0; i < 8; i++) {
      var hit = document.elementFromPoint(x, covered + 1);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) break;  // heading is clear
      var bar = hit, pinned = null;
      while (bar && bar !== document.body) {
        var cs;
        try { cs = window.getComputedStyle(bar); } catch (_) { break; }
        if (cs && (cs.position === 'fixed' || cs.position === 'sticky')) { pinned = bar; break; }
        bar = bar.parentElement;
      }
      if (!pinned) break;                              // page content, not pinned chrome
      var hr = pinned.getBoundingClientRect();
      if (hr.bottom <= covered + 1 || hr.height > 300) break;  // no progress / full-height overlay
      covered = hr.bottom;
    }
    return Math.round(covered);
  }

  /* Instant even when the site sets `scroll-behavior: smooth` in CSS, which would
   * otherwise animate the measuring hops below and defeat them. */
  function instantScroll(y) {
    var de = document.documentElement;
    var prev = de.style.scrollBehavior;
    de.style.scrollBehavior = 'auto';
    window.scrollTo(0, Math.max(0, y));
    de.style.scrollBehavior = prev;
  }

  /* Run fn once the scroll has come to rest. */
  function settle(fn) {
    var done = false;
    var run = function () { if (done) return; done = true; try { fn(); } catch (_) {} };
    if ('onscrollend' in window) {
      window.addEventListener('scrollend', run, { once: true });
      setTimeout(run, 1200);                           // scrollend never fires if nothing moved
    } else {
      setTimeout(run, 450);
    }
  }

  function scrollToGroup(type) {
    var target = document.getElementById('tgd-g-' + type);
    if (!target) return;

    var startY = window.scrollY || window.pageYOffset || 0;
    var naive = target.getBoundingClientRect().top + startY;

    /* Hop to the target, measure the settled layout, hop back. All in one task, so the
     * browser only paints the final position — none of this is visible. */
    instantScroll(naive);
    var offset = chromeOver(target);
    instantScroll(startY);

    document.documentElement.style.setProperty('--tgd-sticky', (offset + SCROLL_GAP) + 'px');
    var finalY = Math.max(0, naive - offset - SCROLL_GAP);
    try { window.scrollTo({ top: finalY, behavior: 'smooth' }); }
    catch (_) { instantScroll(finalY); }

    /* Self-correcting, because some chrome cannot be measured in advance at all: a nav
     * that reveals itself on scroll-up, or a bar that animates in, does not exist until
     * the scroll has finished. Re-check then, and nudge if the heading is still under it. */
    settle(function () {
      var left = chromeOver(target);
      var top = target.getBoundingClientRect().top;
      if (left && top < left + 4) {
        instantScroll((window.scrollY || 0) - (left + SCROLL_GAP - top));
      }
    });

    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '#tgd-g-' + type);
    }
  }

  /* Fallback tile for a brand whose CMS record has no logo, so the grid does not show a
   * hole where a card should be. Two initials at most — three starts reading as an
   * acronym for something else. */
  function initials(name) {
    var words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
    var out = '';
    for (var i = 0; i < words.length && out.length < 2; i++) {
      if (words[i]) out += words[i].charAt(0).toUpperCase();
    }
    return out || '?';
  }

  /* Which brand in this category the query NAMES — used twice: to gate whether the
   * brand list scores at all (see scoreDoc), and to label the result so it explains
   * itself. "Delta 8" on its own looks like a stray hit for a brand search.
   *
   * Exact by design. A brand counts as named when every one of its tokens appears in
   * the query, or when the squashed forms contain one another ("trehouse"). One token
   * of a multi-word brand is not enough: "house" alone must not claim TRĒ House's
   * categories. */
  function matchedBrand(d, query) {
    if (!d.br || !d.br.length) return '';
    var qs = squash(query), qt = tokens(query);
    for (var i = 0; i < d.br.length; i++) {
      var bf = fold(d.br[i]), bs = squash(d.br[i]);
      /* The query must contain the WHOLE brand — not the brand containing the query.
       * The reverse direction let one common word inside a brand name claim that
       * brand's categories: "kratom" matched "Rave Kratom" and so returned Kanna and
       * Kava, and "cbd" matched "The Green Dragon CBD" and returned CBG for Pain. Both
       * are real brands in those categories, but neither is what the query meant. */
      if (qs && qs.indexOf(bs) !== -1 && bs.length >= 4) return d.br[i];
      /* EVERY token of the brand must appear in the query — not the other way round.
       * Checking that the query's tokens appear in the brand is the same trap in token
       * form: the single word "kratom" is present in "Rave Kratom", which handed the
       * query that brand's Kanna and Kava categories. */
      var bts = bf ? bf.split(' ') : [];
      var all = bts.length > 0 && qt.length > 0;
      for (var j = 0; j < bts.length; j++) {
        if (qt.indexOf(bts[j]) === -1) { all = false; break; }
      }
      if (all) return d.br[i];
    }
    return '';
  }

  function clip(text, n) {
    var t = String(text || '').trim();
    if (t.length <= n) return t;
    var cut = t.slice(0, n);
    var sp = cut.lastIndexOf(' ');
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '\u2026';
  }

  function cardHtml(d) {
    var badge = '';
    if (d.t === 'product' && !d.st) badge += '<span class="tgd-b tgd-oos">Out of stock</span>';
    if (d.dc) badge += '<span class="tgd-b tgd-dc">While supplies last</span>';

    /* Brands use the same card as products so the two grids line up, but a logo is not a
     * product shot: it wants a shorter, padded, white tile so wordmarks stay legible and
     * transparent PNGs do not disappear into the page. */
    var isBrand = d.t === 'brand';
    var media = d.img
      ? '<img src="' + esc(d.img) + '" alt="" loading="lazy">'
      : (isBrand ? '<span class="tgd-card-init" aria-hidden="true">' + esc(initials(d.n)) + '</span>' : '');

    return '<a class="tgd-card' + (isBrand ? ' tgd-card-brand' : '') + '" href="' + esc(d.u) + '">'
      + media
      + '<span class="tgd-card-n">' + esc(d.n) + badge + '</span>'
      + (d.b ? '<span class="tgd-card-m">' + esc(d.b) + '</span>' : '')
      + (d.t === 'product' && stars(d) ? '<span class="tgd-card-m">' + stars(d) + '</span>' : '')
      + (isBrand ? '<span class="tgd-card-d">' + (d.d ? esc(clip(d.d, 90)) : 'Shop ' + esc(d.n)) + '</span>' : '')
      + (d.t === 'product' ? '<span class="tgd-card-p">' + money(d) + '</span>' : '')
      + '</a>';
  }

  function renderResults(host, query) {
    var retired = retiredFor(query);
    if (retired) {
      host.innerHTML = '<div class="tgd-res"><div class="tgd-res-note">' + esc(retired) + '</div></div>';
      track('search', { search_term: query, results_count: 0, retired: true, surface: 'results_page' });
      return;
    }

    var all = search(prepared, query, 400);
    track('search', { search_term: query, results_count: all.length, surface: 'results_page' });
    track('view_search_results', { search_term: query, results_count: all.length });

    if (!all.length) {
      host.innerHTML = '<div class="tgd-res"><div class="tgd-res-empty">No results for \u201c'
        + esc(query) + '\u201d.</div>'
        + '<a class="tgd-all" href="' + esc(fallbackUrl(query)) + '">Browse all products</a></div>';
      return;
    }

    var byType = { product: [], brand: [], category: [], page: [] };
    for (var i = 0; i < all.length; i++) {
      var t = all[i].doc.t;
      if (byType[t]) byType[t].push(all[i].doc);
    }

    var html = '<div class="tgd-res">';
    html += '<div class="tgd-res-sum">' + all.length + ' result' + (all.length === 1 ? '' : 's')
      + ' for \u201c' + esc(query) + '\u201d</div>';

    /* Quick nav. Only groups with hits appear, so this never advertises an empty
     * section, and it is skipped entirely when just one group matched — a single chip
     * that scrolls nowhere useful is noise.
     *
     * scroll-margin-top on the headings keeps the target clear of the fixed header;
     * without it an anchor jump lands with the heading hidden behind the nav bar. */
    var present = [];
    for (var pi2 = 0; pi2 < GROUPS.length; pi2++) {
      var g2 = GROUPS[pi2];
      if (byType[g2.t] && byType[g2.t].length) present.push(g2);
    }
    if (present.length > 1) {
      html += '<nav class="tgd-jump" aria-label="Jump to result type">';
      for (var ji = 0; ji < present.length; ji++) {
        html += '<a href="#tgd-g-' + present[ji].t + '">' + present[ji].label
          + '<span class="tgd-jump-n">' + byType[present[ji].t].length + '</span></a>';
      }
      html += '</nav>';
    }

    for (var gi = 0; gi < GROUPS.length; gi++) {
      var grp = GROUPS[gi];
      var list = byType[grp.t];
      if (!list || !list.length) continue;
      html += '<h2 id="tgd-g-' + grp.t + '">' + grp.label + ' (' + list.length + ')</h2>';
      if (grp.t === 'product' || grp.t === 'brand') {
        html += '<div class="tgd-res-grid" data-grid="' + grp.t + '">';
        for (var pi = 0; pi < Math.min(list.length, RESULTS_PAGE_SIZE); pi++) html += cardHtml(list[pi]);
        html += '</div>';
        if (list.length > RESULTS_PAGE_SIZE) {
          html += '<button class="tgd-more" data-more="' + grp.t + '">Show more '
            + esc(grp.label.toLowerCase()) + '</button>';
        }
      } else {
        /* Categories and pages stay a compact list: they are navigational and carry no
         * artwork, so a grid would just be rows of near-identical text cards. Brands do
         * have logos, so they get the grid above. */
        html += '<div class="tgd-list">';
        for (var li = 0; li < list.length; li++) {
          var mb = matchedBrand(list[li], query);
          html += '<a href="' + esc(list[li].u) + '">' + esc(list[li].n)
            + (mb ? '<span class="tgd-list-m">' + esc(mb) + '</span>' : '') + '</a>';
        }
        html += '</div>';
      }
    }

    /* Faceted narrowing stays on the Finsweet page rather than being rebuilt here.
     * This page's job is relevance across every content type; that page's job is
     * filtering products, and it already does it. */
    html += '<h2>Narrow by brand, category or price</h2>';
    html += '<a class="tgd-all" href="' + esc(fallbackUrl(query)) + '">Filter products for \u201c'
      + esc(query) + '\u201d</a>';
    html += '</div>';

    host.innerHTML = html;

    /* Per type, not just products, now that brands are a grid too. The counter has to
     * be per type as well — one shared `shown` would page the second grid from wherever
     * the first one had got to. */
    var moreBtns = host.querySelectorAll('.tgd-more');
    for (var mb = 0; mb < moreBtns.length; mb++) {
      (function (btn) {
        var type = btn.getAttribute('data-more');
        var list = byType[type] || [];
        var shown = RESULTS_PAGE_SIZE;
        btn.addEventListener('click', function () {
          var grid = host.querySelector('[data-grid="' + type + '"]');
          if (!grid) return;
          var next = list.slice(shown, shown + RESULTS_PAGE_SIZE);
          var frag = '';
          for (var k = 0; k < next.length; k++) frag += cardHtml(next[k]);
          grid.insertAdjacentHTML('beforeend', frag);
          shown += next.length;
          if (shown >= list.length && btn.parentNode) btn.parentNode.removeChild(btn);
        });
      }(moreBtns[mb]));
    }

    /* Handle the jump links ourselves so the measured offset is applied. Leaving it
     * to the browser's native anchor behaviour is what put the heading under the
     * header. */
    var jumps = host.querySelectorAll('.tgd-jump a');
    for (var jj = 0; jj < jumps.length; jj++) {
      jumps[jj].addEventListener('click', function (ev) {
        var href = this.getAttribute('href') || '';
        var m = /^#tgd-g-(.+)$/.exec(href);
        if (!m) return;
        ev.preventDefault();
        scrollToGroup(m[1]);
      });
    }

    /* Set the CSS fallback from the real measurement too, so any anchor that is not
     * intercepted (a pasted #tgd-g-brand URL, say) still clears the header. */
    document.documentElement.style.setProperty('--tgd-sticky', (stickyOffset() + 16) + 'px');

    host.querySelectorAll('.tgd-card, .tgd-list a').forEach(function (a, idx) {
      a.addEventListener('click', function () {
        track('search_result_click', {
          search_term: query, position: idx + 1,
          item_id: a.getAttribute('href'), result_type: 'results_page'
        });
      });
    });
  }

  function queryFromUrl() {
    try {
      var p = new URLSearchParams(window.location.search);
      /* `*` is accepted as well as `q` so existing links and the Finsweet-style URL
       * both land here rather than showing an empty page. */
      return (p.get('q') || p.get('*') || p.get('query') || '').trim();
    } catch (_) { return ''; }
  }

  function initResultsPage() {
    var host = document.querySelector(RESULTS_SELECTOR);
    if (!host) {
      /* Say something when we are clearly ON the results page but the container is
       * absent. Returning silently meant a missing Webflow Embed looked identical to
       * "the script is broken", and the page reads as blank apart from Webflow's own
       * native search element reporting zero results. */
      if (window.location.pathname.replace(/\/$/, '') === RESULTS_PATH) {
        console.warn('[tgd-search] no ' + RESULTS_SELECTOR + ' on ' + RESULTS_PATH +
          ' — add an Embed containing <div id="tgd-search-results"></div> to that page.');
      }
      return;
    }
    if (host.getAttribute('data-tgd-done') === '1') return;

    var query = queryFromUrl();
    if (!query) {
      host.innerHTML = '<div class="tgd-res"><div class="tgd-res-empty">'
        + 'Type in the search box above to find products, brands and articles.</div></div>';
      return;
    }
    host.setAttribute('data-tgd-done', '1');

    var css = document.createElement('style');
    css.textContent = CSS + RESULTS_CSS;   // reuse the badge styles from the dropdown
    document.head.appendChild(css);

    host.innerHTML = '<div class="tgd-res"><div class="tgd-res-empty">Searching\u2026</div></div>';

    /* Prefill the header box so the query is visible and editable, which it is not on
     * the Finsweet page today. */
    var input = document.querySelector(INPUT_SELECTOR);
    if (input && !input.value) input.value = query;

    loadIndex().then(function () {
      if (!prepared) {
        // Nothing to render from; send them somewhere that works on its own.
        window.location.replace(fallbackUrl(query));
        return;
      }
      renderResults(host, query);
    });
  }

  function init() {
    var inputs = document.querySelectorAll(INPUT_SELECTOR);
    for (var i = 0; i < inputs.length; i++) attach(inputs[i]);
    initResultsPage();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', onDocClick);
    window.addEventListener('resize', function () {
      var input = document.querySelector(INPUT_SELECTOR);
      if (input && panel && panel.getAttribute('data-open')) place(input);
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    /* The header is a Webflow component on every page, but the search bar can be
     * revealed by an interaction after load, so re-scan once rather than assuming it
     * exists at DOMContentLoaded. */
    setTimeout(init, 1500);
  }

  /* Exposed for the offline tests, which cover ranking, folding, synonyms and the
   * retired-term path — the parts whose failures are silent rather than visible. */
  var api = {
    fold: fold, squash: squash, tokens: tokens, expand: expand, within: within,
    prepare: prepare, search: search, retiredFor: retiredFor,
    stars: stars, ratingBoost: ratingBoost, stickyOffset: stickyOffset,
    matchedBrand: matchedBrand, contentTokens: contentTokens,
    chromeOver: chromeOver, scrollToGroup: scrollToGroup, initials: initials, clip: clip,
    resultsUrl: resultsUrl, fallbackUrl: fallbackUrl, queryFromUrl: queryFromUrl,
    SYNONYMS: SYNONYMS, WEIGHTS: WEIGHTS,
  };
  if (typeof window !== 'undefined') window.__tgdSearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
