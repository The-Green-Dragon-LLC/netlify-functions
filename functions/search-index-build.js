/**
 * SEARCH INDEX BUILD — SCHEDULED WRAPPER
 * ────────────────────────────────────────────────────────────────────────────
 * Rebuilds the search index every 6 hours (schedule lives in netlify.toml) and
 * writes it to Netlify Blobs. All the actual work is in lib/search-index-builder.js.
 *
 * ⚠️ THIS FUNCTION IS NOT REACHABLE OVER HTTP. Netlify does not expose scheduled
 *    functions on a public URL — a GET returns 403 before this code ever runs. So
 *    do NOT add a key check here expecting to curl it, and do not try to test it
 *    that way. Use functions/search-index-rebuild.js for manual runs and dry runs.
 *
 * Failure policy: log and return 500. A failed build leaves the PREVIOUS index in
 * place, which is the right outcome — stale search beats no search, and the read
 * endpoint keeps serving the last good blob until the next run succeeds.
 */
'use strict';

const { build, writeIndex } = require('../lib/search-index-builder');

exports.handler = async () => {
  const started = Date.now();
  try {
    const { index, stats } = await build();
    const note = await writeIndex(index);
    const report = {
      ok: true,
      trigger: 'schedule',
      bytes: Buffer.byteLength(JSON.stringify(index)),
      ms: Date.now() - started,
      blobs: note,
      ...stats,
    };
    console.log('[search-index-build]', JSON.stringify(report));
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    // Surfaced in the Netlify function log; the previous index stays live.
    console.error('[search-index-build] FAILED after', Date.now() - started, 'ms:',
      (err && err.stack) || (err && err.message) || err);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
