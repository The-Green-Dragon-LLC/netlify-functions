/**
 * Sticky-header scroll offset for the results-page jump links.
 *
 * This exists because the offset was got WRONG THREE TIMES, each time by modelling the
 * header instead of measuring it: a hardcoded 110px; then an enumeration that only
 * counted bars straddling y=0 (missing a stacked second bar); then that same
 * enumeration run BEFORE the scroll, while a sticky nav was still in normal flow at
 * top:44 and so measured as ~0.
 *
 * The shape simulated below is the one that broke it: an announcement bar in normal
 * flow at the top of the document with a sticky nav beneath it, plus a
 * statically-positioned link INSIDE that nav, which is what hit-testing actually
 * returns. Any future change to the offset logic has to keep these passing.
 */
'use strict';
const VH = 800, DOC = 4000;
let scrollY = 0;

function rect(top, height) { return { top, bottom: top + height, height, left: 0, width: 1200 }; }

const heading = {
  id: 'tgd-g-brand', className: 'tgd-res-h', _doc: 1500, _h: 40,
  getBoundingClientRect() { return rect(this._doc - scrollY, this._h); },
  contains(o) { return o === this; },
};
const announcement = {
  className: 'promo-bar', _pos: 'static',
  getBoundingClientRect() { return rect(0 - scrollY, 44); },
  contains(o) { return o === this; }, parentElement: null,
};
const nav = {
  className: 'nav-wrap', _pos: 'sticky',
  getBoundingClientRect() { return rect(Math.max(0, 44 - scrollY), 56); },
  contains(o) { return o === this || o === navLink; }, parentElement: null,
};
/* A statically-positioned child INSIDE the sticky nav. This is the case that broke the
 * naive position check: the hit is the link, whose own position is static. */
const navLink = {
  className: 'nav-link', _pos: 'static',
  getBoundingClientRect() { const r = nav.getBoundingClientRect(); return rect(r.top + 18, 20); },
  contains(o) { return o === this; },
};
navLink.parentElement = nav;
const section = {
  className: 'page-section', _pos: 'static',
  getBoundingClientRect() { return rect(0 - scrollY, DOC); },
  contains(o) { return true; }, parentElement: null,
};

const body = { className: 'body', contains: () => true, parentElement: null };
const inside = (r, y) => y >= r.top && y < r.bottom;

global.window = {
  innerWidth: 1200, innerHeight: VH, dataLayer: [],
  get scrollY() { return scrollY; },
  scrollTo(a, b) {
    const y = typeof a === 'object' ? a.top : b;
    scrollY = Math.max(0, Math.min(DOC - VH, y));
  },
  getComputedStyle(el) { return { position: el._pos || 'static', visibility: 'visible', display: 'block' }; },
  addEventListener() {}, history: { replaceState() {} },
  location: { href: '', search: '?q=x', pathname: '/search' },
};
global.document = {
  readyState: 'complete', body,
  documentElement: { style: { setProperty() {} } },
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
  addEventListener() {},
  getElementById: (id) => (id === 'tgd-g-brand' ? heading : null),
  querySelector: () => null,
  querySelectorAll: (sel) => (sel === 'body *' ? [announcement, nav, navLink, heading, section] : []),
  elementFromPoint(x, y) {
    if (y < 0 || y > VH) return null;
    if (inside(navLink.getBoundingClientRect(), y)) return navLink;   // nav's child is on top
    if (inside(nav.getBoundingClientRect(), y)) return nav;
    if (inside(announcement.getBoundingClientRect(), y)) return announcement;
    if (inside(heading.getBoundingClientRect(), y)) return heading;
    return section;
  },
};
global.fetch = () => Promise.reject(new Error('offline'));

require(require('path').join(__dirname, '..', 'public', 'search-dropdown.js'));
const S = window.__tgdSearch;

let fails = 0;
const ok = (c, label, extra) => {
  console.log((c ? '  ok   ' : '  FAIL ') + label + (c ? '' : '   <<< ' + JSON.stringify(extra)));
  if (!c) fails++;
};

console.log('\nsticky header — real shape (static announcement + sticky nav)\n');

/* The root cause, demonstrated. */
scrollY = 0;
const oldWay = S.stickyOffset();
ok(oldWay === 0,
  'ROOT CAUSE: the old pre-scroll measurement returns ' + oldWay + ' at the top of the page',
  { oldWay });
console.log('         (nav sits at top:44 until the page moves, so nothing straddled y=0)');

scrollY = 1500;
ok(S.stickyOffset() === 56, 'the same function is right once scrolled — timing, not logic', S.stickyOffset());

/* The fix: measure at the settled position, via hit-testing. */
scrollY = 1500;
ok(S.chromeOver(heading) === 56, 'chromeOver sees 56px of nav through its static child', S.chromeOver(heading));

scrollY = 0;
S.scrollToGroup('brand');
const gap = heading.getBoundingClientRect().top - nav.getBoundingClientRect().bottom;
ok(scrollY === 1428, 'lands at 1500 - 56 - 16 = 1428', scrollY);
ok(gap === 16, 'heading sits ' + gap + 'px clear BELOW the nav (was hidden behind it)', { gap });
ok(heading.getBoundingClientRect().top >= 56, 'heading top is below the nav bottom');

/* No pinned chrome: only the deliberate 16px of breathing room, no phantom offset.
 * A heading flush against the very top edge of the viewport reads as cramped. */
nav._pos = 'static';
scrollY = 0;
S.scrollToGroup('brand');
ok(scrollY === 1484, 'with nothing pinned it stops 16px above the heading, not 100+', scrollY);
nav._pos = 'sticky';

/* A target near the document end cannot be centred; must not throw or overshoot. */
heading._doc = DOC - 20;
scrollY = 0;
S.scrollToGroup('brand');
ok(scrollY === DOC - VH, 'a target near the end clamps to the document end', scrollY);
heading._doc = 1500;

console.log('\nbrand card rendering\n');
ok(S.initials('Space Gods') === 'SG', 'initials for a two-word brand', S.initials('Space Gods'));
ok(S.initials('TR\u0112 House') === 'TH', 'initials fold the macron', S.initials('TR\u0112 House'));
ok(S.initials('OPiA') === 'O', 'single word gives one letter', S.initials('OPiA'));
ok(S.initials('') === '?', 'empty name still renders a tile', S.initials(''));
ok(S.clip('a b c', 90) === 'a b c', 'short text is untouched');
const clipped = S.clip('Premium hemp derived products crafted for consistency and tested by a third party lab', 40);
ok(clipped.length <= 41 && /\u2026$/.test(clipped) && !/ \u2026$/.test(clipped),
  'long text clips on a word boundary: ' + JSON.stringify(clipped));

console.log('\n' + (fails ? fails + ' failing' : 'all assertions passed') + '\n');
process.exitCode = fails ? 1 : 0;
