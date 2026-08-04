/**
 * DOM behaviour tests for public/search-dropdown.js.
 *
 * Uses a hand-rolled minimal DOM rather than a headless browser, so this stays a
 * zero-dependency `node` run like the rest of the suite. It is not a rendering test:
 * it checks the behaviours whose failure would be a REGRESSION on the live site —
 * that the existing form still works, that a banned term shows a statement instead
 * of an empty panel, that out-of-stock and discontinued are labelled rather than
 * hidden, and that prices never render as a fake range.
 */
'use strict';

const path = require('path');
const fs = require('fs');

/* ─── minimal DOM ─────────────────────────────────────────────────────────────── */

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [], attrs: {}, style: {}, _html: '', textContent: '',
    className: '', id: '',
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(type, fn) { (this._on = this._on || {})[type] = fn; },
    getBoundingClientRect() { return { top: 10, bottom: 40, left: 20, width: 400 }; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) {
      // Only what the script asks for: the result rows.
      if (sel !== '.tgd-r') return [];
      const n = (this._html.match(/class="tgd-r"/g) || []).length;
      return Array.from({ length: n }, () => makeEl('a'));
    },
    closest() { return null },
    scrollIntoView() {},
  };
}

const input = makeEl('input');
input.value = '';

const head = makeEl('head');
const body = makeEl('body');

global.window = {
  scrollX: 0, scrollY: 0, dataLayer: [],
  addEventListener() {}, location: { href: '', search: '?q=blue+raspberry', replace() {} },
};
global.document = {
  readyState: 'complete',
  head, body,
  // renderResults writes the measured sticky offset into a CSS custom property.
  documentElement: { style: { setProperty() {} } },
  createElement: makeEl,
  addEventListener() {},
  querySelector(sel) { return sel.indexOf('search') !== -1 ? input : null; },
  querySelectorAll(sel) { return sel.indexOf('search') !== -1 ? [input] : []; },
};
global.fetch = () => Promise.reject(new Error('offline in tests'));

const SRC = path.join(__dirname, '..', 'public', 'search-dropdown.js');
require(SRC);
const S = global.window.__tgdSearch;

let fails = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '   <<< ' + JSON.stringify(extra)));
  if (!cond) fails++;
};

const src = fs.readFileSync(SRC, 'utf8');

console.log('\nsearch dropdown (DOM)\n');

console.log(' wiring');
ok(typeof S === 'object' && typeof S.search === 'function', 'script loads under a bare DOM without throwing');
ok(input.getAttribute('data-tgd-search') === '1', 'attaches to the existing header input', input.attrs);
ok(input.getAttribute('role') === 'combobox' || src.indexOf("'combobox'") !== -1,
  'marks the input as a combobox for assistive tech');
ok(src.indexOf("autocomplete") !== -1, 'disables native autocomplete so it cannot cover the panel');

console.log(' progressive enhancement — the live form must never get worse');
ok(/shop-all-products\?\*=/.test(src), 'keeps the current /shop-all-products?*= fallback URL');
ok(/Enter[\s\S]{0,400}active >= 0/.test(src),
  'Enter prefers a highlighted row when there is one');
/* The property that must hold is narrower than it was: Enter now also routes to the
 * results page, so the fallback is specifically "no usable index -> let the form
 * submit", not "no highlighted row -> let the form submit". */
ok(/if \(prepared && q\.length >= 2\)/.test(src),
  'and only overrides the form submit when an index is actually loaded');
ok(/catch\s*\(\s*function|\.catch\(/.test(src), 'a failed index fetch is caught, not thrown');
ok(global.window.__tgdSearch !== undefined, 'a rejected fetch did not break module load');

console.log(' price rendering');
/* "$11.11 - $11.11" is a real bug on the current results page. */
ok(/hi > d\.lo/.test(src), 'a range renders only when the ends actually differ');
ok(/<s>/.test(src), 'a sale price strikes through the original');

console.log(' stock and discontinued labelling');
ok(/Out of stock/.test(src), 'out of stock is labelled');
ok(/While supplies last/.test(src), 'discontinued reads "While supplies last", not hidden');
ok(!/display:\s*none[^}]*tgd-oos/.test(src), 'and neither state hides the row');

console.log(' analytics (GTM-KPK8VKF already on the site)');
ok(/dataLayer/.test(src), 'pushes to the existing dataLayer');
ok(/'search'/.test(src) && /search_result_click/.test(src), 'emits search and search_result_click');
ok(/results_count/.test(src), 'reports result count, which is what makes zero-result queries visible');

console.log(' compliance surface');
ok(/retiredFor\(q\)/.test(src), 'checks the retired-term list before searching');
ok(/results_count: 0, retired: true/.test(src), 'and reports the retired case distinctly in analytics');

console.log(' results page routing (Enter and "See all" must not land on the old filter page)');
ok(S.resultsUrl('blue raspberry') === '/search?q=blue%20raspberry' ||
   S.resultsUrl('blue raspberry') === '/search?q=blue+raspberry',
  'results URL points at /search with the query', S.resultsUrl('blue raspberry'));
ok(S.fallbackUrl('x').indexOf('/shop-all-products') === 0, 'the filter page remains the no-index fallback', S.fallbackUrl('x'));
ok(S.queryFromUrl() === 'blue raspberry', 'reads ?q= from the URL', S.queryFromUrl());
ok(/prepared && q\.length >= 2[\s\S]{0,700}resultsUrl\(q\)/.test(src),
  'Enter with no highlighted row goes to the results page when the index loaded');
ok(/if \(prepared\) \{[\s\S]{0,200}\}[\s\S]{0,300}fallbackUrl\(query\)/.test(src) || /seeAllUrl/.test(src),
  '"See all" switches to the filter page only when there is no index');
ok(/p\.get\('q'\) \|\| p\.get\('\*'\)/.test(src),
  'also accepts the legacy ?*= parameter so old links keep working');
ok(/RESULTS_SELECTOR/.test(src) && /tgd-search-results/.test(src),
  'renders into a container the Webflow page provides');

console.log(' quick nav for result types');
ok(/tgd-jump/.test(src), 'renders a jump nav on the results page');
ok(/present\.length > 1/.test(src), 'but only when more than one type matched — a lone chip is noise');
ok(/id="tgd-g-' \+ grp\.t/.test(src), 'headings carry anchor ids for the nav to target');
ok(/scroll-margin-top/.test(src), 'anchored headings clear the fixed header rather than hiding behind it');
ok(/totalOfType > hits\.length/.test(src), 'dropdown group labels show the full count when more exists behind "See all"');

console.log(' sticky-header scroll offset (the header covered the heading)');
ok(/stickyOffset/.test(src), 'measures the sticky chrome instead of hardcoding a height');
ok(!/scroll-margin-top:\s*110px/.test(src), 'the guessed 110px is gone');
ok(/var\(--tgd-sticky/.test(src), 'CSS fallback reads the measured value');
ok(/top <= covered \+ 4/.test(src),
  'grows the covered band so a STACKED second bar counts — requiring every bar to straddle y=0 returned 56 instead of 100');
ok(/height > 300/.test(src), 'ignores full-height overlays, which are not top chrome');
ok(/ev\.preventDefault\(\)[\s\S]{0,80}scrollToGroup/.test(src),
  'intercepts the jump click rather than trusting the native anchor jump');
ok(/replaceState/.test(src), 'updates the hash without triggering a second un-offset jump');

console.log(' brand cards (logo grid, like products)');
ok(/grp\.t === 'product' \|\| grp\.t === 'brand'/.test(src), 'brands render as a card grid, not a text list');
ok(/tgd-card-brand/.test(src), 'brand cards get their own class so the logo tile can differ from a product shot');
ok(/tgd-card-init/.test(src), 'a brand with no logo in the CMS falls back to initials rather than a hole');
ok(/data-grid="' \+ grp\.t/.test(src) && !/data-grid="1"/.test(src),
  'each grid is keyed by type, so "show more products" cannot inject into the brand grid');
ok(/var type = btn\.getAttribute\('data-more'\);[\s\S]{0,500}var shown = size;[\s\S]{0,120}btn\.addEventListener/.test(src),
  'the show-more counter lives inside the per-button closure — one shared counter would page the second grid from the first grid position');
ok(/data-page="' \+ size/.test(src) && /getAttribute\('data-page'\)/.test(src),
  'page size is written onto the grid and read back, so it cannot drift from what was rendered');
ok(/\{ t: 'blog',[^}]*page: 8/.test(src),
  'articles cap at 8 up front — lowest intent and the largest type ("what is thca" matches 108)');

console.log(' article cards');
ok(/grp\.t === 'product' \|\| grp\.t === 'brand' \|\| grp\.t === 'blog'/.test(src),
  'articles render as cards in the grid, which is also what paginates them');
ok(/tgd-card-blog img\{height:120px;object-fit:cover\}/.test(src),
  'an editorial photo is cover-fitted, unlike a contain-fitted brand logo');
ok(/tgd-card-noimg/.test(src), 'an article with no thumbnail gets a neutral tile rather than a ragged row');
ok(/for \(var bt = 0; bt < GROUPS\.length; bt\+\+\) byType\[GROUPS\[bt\]\.t\] = \[\];/.test(src),
  'result buckets are derived from GROUPS — a hardcoded list silently dropped all 306 articles');
ok(!/byType = \{ product: \[\]/.test(src), 'and the hand-listed literal is gone');
ok(/object-fit:contain/.test(src), 'logos are contain-fitted so wordmarks are not cropped');

/* ─── RENDERED OUTPUT ────────────────────────────────────────────────────────────
 *
 * Everything above this point checks the source or the ranker. That was not enough: a
 * hardcoded `byType` literal missing 'blog' silently discarded all 306 article results
 * AFTER they had matched and ranked, and every ranking assertion still passed. These
 * assertions look at the HTML that actually comes out. */
console.log(' rendered output');

const RDOCS = { docs: [] };
for (let i = 0; i < 30; i++) {
  RDOCS.docs.push({ t: 'blog', n: 'THCa Article ' + i, u: '/blog/thca-' + i,
    d: 'All about THCa and what it does.', img: 'https://img/thca-' + i + '.png' });
}
RDOCS.docs.push({ t: 'product', n: 'THCa Gummies', u: '/product/thca-gummies', p: 30, st: 1 });
RDOCS.docs.push({ t: 'brand', n: 'THCa Co', u: '/brand/thca-co', img: 'https://img/logo.png' });
RDOCS.docs.push({ t: 'blog', n: 'THCa With No Picture', u: '/blog/no-pic', d: 'No thumbnail here.' });

const rhost = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  querySelector: () => null, querySelectorAll: () => [] };
S.renderResults(rhost, 'thca', S.prepare(RDOCS));
const out = rhost.innerHTML;
const sections = [...out.matchAll(/<h2 id="tgd-g-([a-z]+)">([^<]*)</g)].map((m) => m[1]);

ok(sections.indexOf('blog') !== -1, 'an Articles section is rendered at all', sections);
ok(sections.indexOf('product') !== -1 && sections.indexOf('brand') !== -1,
  'alongside products and brands', sections);
ok((out.match(/tgd-card-blog/g) || []).length === 8,
  'articles are capped at 8 up front', (out.match(/tgd-card-blog/g) || []).length);
ok(/data-more="blog"/.test(out) && /Show more articles/.test(out),
  'with a Show more articles button, since 31 matched');
ok(/data-grid="blog" data-page="8"/.test(out), 'the grid records its own page size for the button to read');
ok(/tgd-card-k">Article</.test(out), 'article cards are labelled "Article"');
ok(/tgd-card-blog[\s\S]{0,400}<img/.test(out), 'article cards render their thumbnail');
/* Asserted on cardHtml directly: whether the no-thumbnail article lands inside the first
 * 8 depends on ranking, so checking the page output would be a test that passes by
 * accident. A ragged row is the failure mode being guarded against. */
const noPic = S.cardHtml({ t: 'blog', n: 'No Picture', u: '/blog/no-pic', d: 'Text only.' });
ok(/tgd-card-noimg/.test(noPic), 'an article with no thumbnail gets a placeholder tile, not a collapsed card', noPic);
ok(/tgd-card-blog/.test(noPic) && !/<img/.test(noPic), 'and no empty img element');
const withPic = S.cardHtml({ t: 'blog', n: 'Has Picture', u: '/blog/p', img: 'https://img/x.png' });
ok(/<img src="https:\/\/img\/x\.png"/.test(withPic) && !/tgd-card-noimg/.test(withPic),
  'while one with a thumbnail uses it and skips the placeholder');
ok(!/tgd-card-p/.test(withPic), 'article cards carry no price');
ok(!/\$NaN|undefined/.test(out), 'no undefined or NaN leaks into the markup');

console.log(' escaping');
ok(S.fold('<script>') === 'script', 'folding strips markup characters');
ok(/replace\(\/&\/g, '&amp;'\)/.test(src), 'output is HTML-escaped before innerHTML');

console.log('\n' + (fails ? fails + ' failing' : 'all assertions passed') + '\n');
process.exitCode = fails ? 1 : 0;
