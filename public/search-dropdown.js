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

  var INDEX_URL = 'https://wondrous-bublanina-d440ec.netlify.app/.netlify/functions/search-index';

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
      if (ft.length > qt.length && ft.indexOf(qt) === 0) {
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
  var WEIGHTS = { n: 10, b: 6, c: 4, x: 7, q: 2, d: 1.5 };

  /* An exact brand-name query jumps the brand page above its own products. 18% of
   * searches are brand-seeking, and someone typing "flying horse" wants the brand,
   * not whichever of its products happens to sort first. */
  var BRAND_PIN_BOOST = 26;

  var TYPE_BASE = { product: 0, brand: 1.5, category: 1.2, page: 1.0 };

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
        },
        nameFolded: fold(d.n),
        // Only the identity-ish fields; squashing a description is meaningless.
        sq: { n: squash(d.n), b: squash(d.b), x: squash(d.x) },
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

    for (var i = 0; i < expanded.length; i++) {
      var qt = expanded[i];
      // Expanded synonyms count for less than what the user actually typed.
      var isOriginal = qTokens.indexOf(qt) !== -1;
      var weightScale = isOriginal ? 1 : 0.5;
      var bestForToken = 0;
      for (var key in WEIGHTS) {
        if (!f[key] || !f[key].length) continue;
        var s = tokenScore(qt, f[key]) * WEIGHTS[key];
        if (s > bestForToken) bestForToken = s;
      }
      // Joined-word forms: "trehouse" against "tre house".
      for (var sk in entry.sq) {
        var ss = squashScore(qt, entry.sq[sk]) * WEIGHTS[sk];
        if (ss > bestForToken) bestForToken = ss;
      }
      if (bestForToken > 0) { matchedAny = true; total += bestForToken * weightScale; }
    }
    if (!matchedAny) return 0;

    /* Require most of a multi-word query to land somewhere. Without this, "flying
     * horse gummies" matches every gummy on the strength of one token. */
    if (qTokens.length > 1) {
      var hits = 0;
      for (var t = 0; t < qTokens.length; t++) {
        var landed = false;
        for (var key2 in WEIGHTS) {
          if (f[key2] && f[key2].length && tokenScore(qTokens[t], f[key2]) > 0) { landed = true; break; }
        }
        if (!landed) {
          for (var sk2 in entry.sq) {
            if (squashScore(qTokens[t], entry.sq[sk2]) > 0) { landed = true; break; }
          }
        }
        if (landed) hits++;
      }
      if (hits < Math.ceil(qTokens.length / 2)) return 0;
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
    { t: 'page',     label: 'Pages',      max: 3 }
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
      + (d.b && d.t === 'product' ? '<span class="tgd-m">' + esc(d.b) + '</span>' : '')
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
        html += '<div class="tgd-g">' + grp.label + '</div>';
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
    '.tgd-list a{display:block;padding:9px 0;border-bottom:1px solid #eee;text-decoration:none;color:inherit}',
    '.tgd-more{margin-top:14px;padding:9px 16px;border:1px solid #276749;background:#fff;color:#276749;',
    'border-radius:6px;font-weight:600;cursor:pointer}',
    '.tgd-res-empty{padding:24px 0;color:#5a5a5a}',
    '.tgd-res-note{padding:16px;background:#f7f4e8;border:1px solid #e4dcc0;border-radius:8px;color:#5d4f22}'
  ].join('');

  function cardHtml(d) {
    var badge = '';
    if (d.t === 'product' && !d.st) badge += '<span class="tgd-b tgd-oos">Out of stock</span>';
    if (d.dc) badge += '<span class="tgd-b tgd-dc">While supplies last</span>';
    return '<a class="tgd-card" href="' + esc(d.u) + '">'
      + (d.img ? '<img src="' + esc(d.img) + '" alt="" loading="lazy">' : '')
      + '<span class="tgd-card-n">' + esc(d.n) + badge + '</span>'
      + (d.b ? '<span class="tgd-card-m">' + esc(d.b) + '</span>' : '')
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

    for (var gi = 0; gi < GROUPS.length; gi++) {
      var grp = GROUPS[gi];
      var list = byType[grp.t];
      if (!list || !list.length) continue;
      html += '<h2>' + grp.label + ' (' + list.length + ')</h2>';
      if (grp.t === 'product') {
        html += '<div class="tgd-res-grid" data-grid="1">';
        for (var pi = 0; pi < Math.min(list.length, RESULTS_PAGE_SIZE); pi++) html += cardHtml(list[pi]);
        html += '</div>';
        if (list.length > RESULTS_PAGE_SIZE) {
          html += '<button class="tgd-more" data-more="product">Show more products</button>';
        }
      } else {
        /* Brands, categories and pages are navigational, so a compact list beats a
         * grid of near-identical cards. */
        html += '<div class="tgd-list">';
        for (var li = 0; li < list.length; li++) {
          html += '<a href="' + esc(list[li].u) + '">' + esc(list[li].n) + '</a>';
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

    var shown = RESULTS_PAGE_SIZE;
    var moreBtn = host.querySelector('[data-more="product"]');
    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        var grid = host.querySelector('[data-grid="1"]');
        var next = byType.product.slice(shown, shown + RESULTS_PAGE_SIZE);
        var frag = '';
        for (var k = 0; k < next.length; k++) frag += cardHtml(next[k]);
        grid.insertAdjacentHTML('beforeend', frag);
        shown += next.length;
        if (shown >= byType.product.length) moreBtn.parentNode.removeChild(moreBtn);
      });
    }

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
    resultsUrl: resultsUrl, fallbackUrl: fallbackUrl, queryFromUrl: queryFromUrl,
    SYNONYMS: SYNONYMS, WEIGHTS: WEIGHTS,
  };
  if (typeof window !== 'undefined') window.__tgdSearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
