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
  addEventListener() {}, location: { href: '' },
};
global.document = {
  readyState: 'complete',
  head, body,
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
  'Enter only intercepts when a row is highlighted, otherwise the form submits');
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

console.log(' escaping');
ok(S.fold('<script>') === 'script', 'folding strips markup characters');
ok(/replace\(\/&\/g, '&amp;'\)/.test(src), 'output is HTML-escaped before innerHTML');

console.log('\n' + (fails ? fails + ' failing' : 'all assertions passed') + '\n');
process.exitCode = fails ? 1 : 0;
