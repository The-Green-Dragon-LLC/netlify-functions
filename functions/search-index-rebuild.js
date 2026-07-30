/**
 * SEARCH INDEX REBUILD — MANUAL / HTTP WRAPPER
 * ────────────────────────────────────────────────────────────────────────────
 * Key-protected HTTP trigger for the search index build. Two uses:
 *   1. Validation. `?dry=1` builds and reports WITHOUT writing to Blobs, so the
 *      join, folds, exclusions and compliance guard can be checked against live
 *      data before anything is persisted.
 *   2. Off-cycle rebuilds — e.g. right after editing the search synonym/pin
 *      tables in Airtable, instead of waiting up to 6h for the schedule.
 *
 * WHY THIS EXISTS SEPARATELY FROM search-index-build.js
 *   Netlify does not expose scheduled functions over HTTP (a GET returns 403), so
 *   the scheduled function cannot be curl'd. This is the reachable twin. Both call
 *   the same lib/search-index-builder.js, so they cannot drift.
 *
 * WHY THE KEY MATTERS
 *   A build makes ~40 Airtable calls. Unauthenticated, a loop over this endpoint
 *   would burn the 100k/month Airtable quota in under an hour — the same failure
 *   that crossell-config.js caused accidentally, but deliberate. The key protects
 *   quota (availability), not secrecy.
 *
 *   Because access already requires the key, this endpoint returns VERBOSE errors
 *   including the stack. That is deliberate: Blobs initialisation is the most
 *   likely thing to break on a new deploy, and a generic "failed" message would
 *   mean digging through function logs to learn anything.
 *
 * INVOKE
 *   GET /.netlify/functions/search-index-rebuild?key=<SEARCH_INDEX_KEY>&dry=1
 *   GET /.netlify/functions/search-index-rebuild?key=<SEARCH_INDEX_KEY>
 *
 * Env: SEARCH_INDEX_KEY, plus everything lib/search-index-builder.js needs.
 */
'use strict';

const { build, writeIndex } = require('../lib/search-index-builder');

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const want = process.env.SEARCH_INDEX_KEY || '';

  if (!want) {
    return {
      statusCode: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: false, error: 'SEARCH_INDEX_KEY is not set in this environment' }),
    };
  }
  // Constant-time-ish: compare lengths first, then content. Not a timing-critical
  // secret, but there is no reason to leak length via early exit either.
  const got = String(qs.key || '');
  if (got.length !== want.length || got !== want) {
    return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
  }

  const dry = qs.dry === '1';
  const started = Date.now();

  try {
    const { index, stats } = await build();
    const bytes = Buffer.byteLength(JSON.stringify(index));

    let blobs = 'skipped (dry run)';
    if (!dry) {
      try {
        blobs = await writeIndex(index);
      } catch (blobErr) {
        // The build itself succeeded — report that separately from the write so a
        // Blobs problem is not mistaken for a data problem.
        return {
          statusCode: 500,
          headers: JSON_HEADERS,
          body: JSON.stringify({
            ok: false,
            stage: 'blobs-write',
            error: String((blobErr && blobErr.message) || blobErr),
            stack: (blobErr && blobErr.stack) ? String(blobErr.stack).split('\n').slice(0, 6) : undefined,
            buildOk: true,
            bytes,
            ms: Date.now() - started,
            ...stats,
          }, null, 2),
        };
      }
    }

    const report = { ok: true, trigger: 'manual', dry, bytes, ms: Date.now() - started, blobs, ...stats };
    console.log('[search-index-rebuild]', JSON.stringify(report));
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      // A few sample docs make it obvious at a glance whether the join worked.
      body: JSON.stringify(dry ? { ...report, sample: index.docs.slice(0, 3) } : report, null, 2),
    };
  } catch (err) {
    console.error('[search-index-rebuild] FAILED', (err && err.stack) || err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ok: false,
        stage: 'build',
        error: String((err && err.message) || err),
        stack: (err && err.stack) ? String(err.stack).split('\n').slice(0, 6) : undefined,
        ms: Date.now() - started,
      }, null, 2),
    };
  }
};
