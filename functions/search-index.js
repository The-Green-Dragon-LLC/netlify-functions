/**
 * SEARCH INDEX — PUBLIC READ ENDPOINT
 * ────────────────────────────────────────────────────────────────────────────
 * Serves the index built by `search-index-build.js` to the browser. The footer
 * script fetches this once, lazily (on first interaction with the search box),
 * and does all matching client-side.
 *
 * WHY NOT BUILD ON REQUEST
 *   A full build makes ~40 Airtable calls plus paged Webflow reads and takes
 *   longer than a synchronous function should run. So the build is scheduled and
 *   this endpoint only reads the prebuilt blob — fast, and it cannot melt the
 *   Airtable quota no matter how much traffic arrives.
 *
 * CACHING — 'durable' IS LOAD-BEARING
 *   Plain s-maxage caches PER EDGE POP, so every POP would miss independently and
 *   re-invoke. `durable` persists the response in Netlify's global object store so
 *   all edge nodes share one copy. This is the same fix applied to
 *   crossell-config.js after uncached reads pushed the Airtable workspace to 1.77M
 *   calls against a 100k/month quota. Do not drop the directive.
 *
 *   The index only changes when the 6-hourly build runs, so the CDN TTL matches.
 *   Browsers get a short TTL plus ETag revalidation, so a rebuild reaches
 *   customers promptly without re-downloading ~180KB on every page.
 *
 * NOTE ON CONTENT
 *   This response is PUBLIC. The builder enforces a field allowlist and a leak
 *   guard so no cost/wholesale/margin data can reach it. If you add fields to the
 *   index, re-read the SECURITY note in search-index-build.js first.
 */
'use strict';

const crypto = require('crypto');

const BLOB_STORE = 'search';
const BLOB_KEY   = 'index.json';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/* 6h at the edge, matching the build cadence; serve stale for a day while
 * revalidating so a late/failed build never leaves the box without an index. */
const CDN_CACHE = 'public, durable, s-maxage=21600, stale-while-revalidate=86400';
/* Short browser TTL — the ETag below makes the revalidation a cheap 304. */
const BROWSER_CACHE = 'public, max-age=300, must-revalidate';

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  let index = null;
  try {
    const { getStore } = require('@netlify/blobs');
    index = await getStore(BLOB_STORE).get(BLOB_KEY, { type: 'json' });
  } catch (err) {
    // A read can throw rather than return null when the store does not exist yet
    // (nothing ever written) or when Blobs is not initialised. Both mean "no index
    // to serve", so treat them the same and let the detail explain which.
    // Detail is an infrastructure message only — no stack, since this is public.
    // For a full diagnosis use search-index-rebuild (key-protected, verbose).
    console.error('[search-index] blob read threw:', (err && err.stack) || err);
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'index unavailable',
        detail: String((err && err.message) || err).slice(0, 200),
        hint: 'run search-index-rebuild?key=…&dry=1 to diagnose',
      }),
    };
  }

  try {
    // No blob yet means the builder has not run (or has never succeeded). Say so
    // plainly and DO NOT cache it — otherwise a first-deploy miss would be pinned
    // at the edge for six hours.
    if (!index) {
      return {
        statusCode: 503,
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'index not built yet', hint: 'run search-index-rebuild' }),
      };
    }

    const body = JSON.stringify(index);
    const etag = '"' + crypto.createHash('sha1').update(body).digest('base64') + '"';

    const inm = (event && event.headers && (event.headers['if-none-match'] || event.headers['If-None-Match'])) || '';
    if (inm && inm.split(',').some((t) => t.trim() === etag)) {
      return {
        statusCode: 304,
        headers: { ...CORS, ETag: etag, 'Cache-Control': BROWSER_CACHE, 'Netlify-CDN-Cache-Control': CDN_CACHE },
        body: '',
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/json; charset=utf-8',
        ETag: etag,
        'Netlify-CDN-Cache-Control': CDN_CACHE,
        'Cache-Control': BROWSER_CACHE,
        'X-Index-Built-At': String(index.builtAt || ''),
        'X-Index-Docs': String((index.docs || []).length),
      },
      body,
    };
  } catch (err) {
    console.error('[search-index] read failed', err && err.message ? err.message : err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'index unavailable' }),
    };
  }
};
