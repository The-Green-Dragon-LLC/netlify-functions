/**
 * Ranking tests for public/search-dropdown.js.
 *
 * Every case here is drawn from the measured GA4 data rather than invented, so a
 * regression shows up as "this real query stops working" instead of an abstract
 * scoring change. Fully offline: no network, no DOM, no index fetch.
 *
 * Run with `npm run test:ranking`, or `npm test` which runs both suites.
 */
'use strict';

const path = require('path');
const S = require(path.join(__dirname, '..', 'public', 'search-dropdown.js'));

/* A small catalogue shaped like the real index, using real brands and products so
 * the assertions mean something. Field names match the built index exactly:
 * n=name b=brand c=categories x=variant text q=FAQ questions d=description
 * s=Number of Sales st=in stock dc=discontinued t=type u=url */
const INDEX = {
  docs: [
    { t: 'brand', n: 'TRĒ House', u: '/brand/tre-house', d: 'Hemp brand' },
    { t: 'brand', n: 'Flying Horse', u: '/brand/flying-horse', d: 'THC brand' },
    { t: 'brand', n: 'Hixotic', u: '/brand/hixotic', d: 'Cannabis brand' },
    { t: 'category', n: 'Vape Pens', u: '/product-parent-categories/vape-pens', d: 'Shop vape pens' },
    { t: 'category', n: 'Gummies & Edibles', u: '/product-parent-categories/gummies-edibles', d: 'Shop gummies' },
    { t: 'page', n: 'Delta 8 Gummies & Edibles', u: '/delta-8-gummies-edibles', d: 'Shop delta 8 gummies' },

    { t: 'product', n: 'Flying Horse - Delta 9 Gummies', u: '/product/flying-horse-d9-gummies',
      b: 'Flying Horse', c: ['Delta 9'], x: 'Blue Raspberry · Watermelon', s: 900, st: 1, p: 24.99 },
    { t: 'product', n: 'Hixotic - Trap\'d Out Pre-rolls', u: '/product/hixotic-trapd-out',
      b: 'Hixotic', c: ['THCa'], x: 'Sour Apple Jack · LA Mamba', s: 38, st: 1, p: 12.99,
      q: 'Is HiXotic legit?' },
    { t: 'product', n: 'TRĒ House - Vape Cartridge', u: '/product/tre-house-vape-cart',
      b: 'TRĒ House', c: ['Vape Carts'], x: 'Sativa · Indica', s: 120, st: 1, p: 29.99 },
    { t: 'product', n: 'Generic Gummies', u: '/product/generic-gummies',
      b: 'Nobody', c: ['Gummies & Edibles'], x: 'Cherry', s: 5, st: 1, p: 9.99 },
    { t: 'product', n: 'Out Of Stock Gummies', u: '/product/oos-gummies',
      b: 'Nobody', c: ['Gummies & Edibles'], x: 'Cherry', s: 800, st: 0, p: 9.99 },
    { t: 'product', n: 'Discontinued Gummies', u: '/product/disc-gummies',
      b: 'Nobody', c: ['Gummies & Edibles'], x: 'Cherry', s: 300, st: 1, dc: 1, p: 9.99 },
    { t: 'product', n: 'Drug Test Info Product', u: '/product/dt-info',
      b: 'Nobody', c: ['CBD'], s: 10, st: 1, p: 19.99,
      q: 'Will this show on a drug test? · How many mg per gummy?' },
  ],
};

const prepared = S.prepare(INDEX);
const run = (q, n) => S.search(prepared, q, n || 10).map((r) => r.doc.n);
const top = (q) => run(q, 1)[0];

let fails = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '   <<< ' + JSON.stringify(extra)));
  if (!cond) fails++;
};

console.log('\nsearch ranking\n');

console.log(' diacritic folding (3,592 views/yr land on brand misspellings)');
ok(S.fold('TRĒ House') === 'tre house', 'macron folded away', S.fold('TRĒ House'));
ok(top('tre house') === 'TRĒ House', '"tre house" finds TRĒ House — impossible with substring matching', run('tre house'));
ok(top('trehouse') === 'TRĒ House', '"trehouse" (concatenated, 111 views) pins the brand', run('trehouse'));
ok(S.squash('TRĒ House') === 'trehouse', 'squashed form drops spaces and diacritics', S.squash('TRĒ House'));
ok(run('flyinghorse').indexOf('Flying Horse') !== -1, '"flyinghorse" concatenation matches', run('flyinghorse'));

console.log(' brand intent (18% of all searches)');
ok(top('flying horse') === 'Flying Horse', 'exact brand query pins the BRAND page above its products', run('flying horse'));
ok(run('flying horse')[1] === 'Flying Horse - Delta 9 Gummies', 'its product ranks immediately after', run('flying horse'));
ok(top('hixotic') === 'Hixotic', 'single-word brand pins too', run('hixotic'));

console.log(' typo tolerance');
ok(run('hixotc').length > 0, '"hixotc" (dropped letter) still matches', run('hixotc'));
ok(run('gummis').indexOf('Generic Gummies') !== -1, '"gummis" matches gummies — substring cannot', run('gummis'));
ok(S.within('stiizy', 'stiiizy', 1) === 1, 'bounded edit distance works', S.within('stiizy', 'stiiizy', 1));
ok(S.within('abc', 'xyz', 1) === -1, 'and gives up past the bound');
ok(run('cba').length === 0, 'short tokens get NO fuzz — "cba" must not match "cbd"', run('cba'));

console.log(' synonyms (7-OH had 276 spellings; vape pens 99)');
ok(S.expand(['vapes']).indexOf('pen') !== -1, '"vapes" expands to pen', S.expand(['vapes']));
ok(run('vapes').length > 0, '"vapes" finds vape results', run('vapes'));
ok(run('edibles').indexOf('Generic Gummies') !== -1, '"edibles" finds gummies', run('edibles'));
ok(run('cartridge').length > 0, '"cartridge" finds carts', run('cartridge'));

console.log(' category and landing-page intent ("vape pens" is the #1 query, 13,363 views)');
ok(top('vape pens') === 'Vape Pens', 'category page outranks products for a category query', run('vape pens'));
ok(run('delta 8 gummies').indexOf('Delta 8 Gummies & Edibles') !== -1, 'landing page is reachable at all — it is not today', run('delta 8 gummies'));

console.log(' variant text (what people actually type)');
ok(run('blue raspberry').indexOf('Flying Horse - Delta 9 Gummies') !== -1,
  'a flavour that appears in NO product name still finds its product', run('blue raspberry'));
ok(run('sour apple jack').indexOf("Hixotic - Trap'd Out Pre-rolls") !== -1, 'multi-word flavour matches', run('sour apple jack'));

console.log(' FAQ questions');
ok(run('drug test').indexOf('Drug Test Info Product') !== -1, 'a natural-language question reaches its product', run('drug test'));

console.log(' stock and discontinued');
const g = run('gummies', 10);
ok(g.indexOf('Out Of Stock Gummies') > g.indexOf('Generic Gummies'),
  'out of stock is demoted below a lower-selling in-stock item', g);
ok(g.indexOf('Out Of Stock Gummies') !== -1, 'but still present, not hidden', g);
/* Discontinued means "not reordering", not unavailable. It sells 300 vs Generic's 5,
 * so popularity must still rank it higher. */
ok(g.indexOf('Discontinued Gummies') < g.indexOf('Generic Gummies'),
  'discontinued is NOT demoted — it still has stock and outsells', g);

console.log(' Yotpo ratings (counts on this catalogue are 1-14, so evidence matters)');
ok(S.ratingBoost({}) === 0, 'unrated is neutral — 3 of the 12 best-sellers have no reviews', S.ratingBoost({}));
ok(S.ratingBoost({ r: 4.6, rc: 5 }) === 0, 'an average rating is neutral', S.ratingBoost({ r: 4.6, rc: 5 }));
/* The point of the shrinkage: a lone perfect review must not outrank a strong one
 * backed by real volume. */
ok(S.ratingBoost({ r: 4.9, rc: 8 }) > S.ratingBoost({ r: 5, rc: 1 }),
  '4.9 from 8 reviews beats 5.0 from 1', [S.ratingBoost({ r: 4.9, rc: 8 }), S.ratingBoost({ r: 5, rc: 1 })]);
ok(S.ratingBoost({ r: 5, rc: 200 }) > S.ratingBoost({ r: 5, rc: 8 }),
  'more reviews at the same score counts for more');
/* Asymmetry check: an earlier version scaled against the 0.4 headroom above the mean,
 * so a 4.0 product lost 2.4 while a perfect one could gain only 0.4. */
ok(Math.abs(S.ratingBoost({ r: 4, rc: 14 })) <= S.ratingBoost({ r: 5, rc: 200 }) * 1.2,
  'a good-not-great rating is not punished harder than a perfect one is rewarded',
  [S.ratingBoost({ r: 4, rc: 14 }), S.ratingBoost({ r: 5, rc: 200 })]);
ok(Math.abs(S.ratingBoost({ r: 1, rc: 999 })) <= 2.5,
  'the boost is clamped so rating can never dominate text relevance', S.ratingBoost({ r: 1, rc: 999 }));
ok(S.stars({ r: 4.9, rc: 8 }).indexOf('★') !== -1, 'renders filled stars');
ok(S.stars({}) === '', 'renders nothing when there is no rating');
ok(/aria-label/.test(S.stars({ r: 4.5, rc: 3 })), 'stars carry an accessible label', S.stars({ r: 4.5, rc: 3 }));

console.log(' popularity ranking (the signal current search cannot see)');
const gum = run('gummies', 10);
ok(gum.indexOf('Flying Horse - Delta 9 Gummies') < gum.indexOf('Generic Gummies'),
  'a 900-sale product outranks a 5-sale one on an equal text match', gum);

console.log(' multi-word queries must not match on one token alone');
ok(run('flying horse gummies').indexOf('Generic Gummies') === -1,
  '"flying horse gummies" does not return every gummy', run('flying horse gummies'));

console.log(' compliance: 7-OH is illegal and not sold');
ok(S.retiredFor('7oh') !== null, '"7oh" is caught', S.retiredFor('7oh'));
ok(S.retiredFor('7-oh') !== null, '"7-oh" is caught');
ok(S.retiredFor('7 oh') !== null, '"7 oh" is caught');
ok(S.retiredFor('7 hydroxy') !== null, '"7 hydroxy" is caught');
ok(S.retiredFor('hydroxymitragynine') !== null, 'the full compound name is caught');
ok(S.retiredFor('7 pack gummies') === null, '"7 pack" is NOT caught — the guard is not a bare 7', S.retiredFor('7 pack gummies'));
ok(!/alternativ|instead|similar|try/i.test(S.retiredFor('7oh')),
  'and it offers NO substitutes for a banned substance', S.retiredFor('7oh'));

console.log(' empty and junk input');
ok(run('') .length === 0, 'empty query returns nothing');
ok(run('   ').length === 0, 'whitespace returns nothing');
ok(run('zzzqqxx').length === 0, 'nonsense returns nothing rather than everything', run('zzzqqxx'));

console.log('\n' + (fails ? fails + ' failing' : 'all assertions passed') + '\n');
process.exitCode = fails ? 1 : 0;
