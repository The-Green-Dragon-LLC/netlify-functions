// Search index rebuild — SCHEDULED (every 6 hours)
//
// Joins Webflow (live URLs) to Airtable (ranking signals, variant/FAQ graph) and
// writes the index to Netlify Blobs. search-index.mts serves it. All the real work
// is in lib/search-index-builder.js.
//
// WHY THIS IS A v2 (.mts) FUNCTION AND NOT exports.handler
//   @netlify/blobs only auto-configures on the v2 function runtime. Under the
//   classic exports.handler signature it throws:
//     MissingBlobsEnvironmentError: The environment has not been configured to use
//     Netlify Blobs. To use it manually, supply ... siteID, token
//   The documented v1 workaround is passing a siteID and a Netlify API token by
//   hand, which would mean storing an account-scoped PAT as a secret. Using v2
//   instead needs no new credentials at all.
//
// ⚠️ NOT REACHABLE OVER HTTP. Netlify does not expose scheduled functions on a
//    public URL — a GET returns 403 before this code runs. Use
//    search-index-rebuild for manual runs and dry runs.
//
// WHY 6-HOURLY: a build makes ~29 Airtable calls. Hourly would be ~21k/month
// against a 100k quota; 6-hourly is ~3.5k. That quota was already blown once
// (1.77M) by uncached reads in crossell-config.js, so this stays conservative.
// It is still far fresher than Webflow's native reindex, which is gated on a
// full-site publish.
//
// Env: WEBFLOW_SEARCH_TOKEN, AIRTABLE_API_KEY (or AIRTABLE_TOKEN).

import type { Config } from "@netlify/functions";

/* Static import, NOT createRequire(). esbuild cannot statically analyse a
 * require() obtained from createRequire, so it left the call as a runtime
 * lookup and never bundled the file — the deploy crashed with
 * "Cannot find module '../lib/search-index-builder.js'". A static import is
 * bundled; the default export of a CommonJS module is its module.exports. */
import builder from "../lib/search-index-builder.js";
import { writeIndex, codeVersion } from "../lib/search-index-store.mjs";
const { build } = builder as any;

export default async () => {
  const started = Date.now();
  try {
    const { index, stats } = await build();
    const blobs = await writeIndex(index);
    console.log("[search-index-build]", JSON.stringify({
      ok: true,
      trigger: "schedule",
      bytes: Buffer.byteLength(JSON.stringify(index)),
      ms: Date.now() - started,
      blobs,
      ...stats,
    }));
  } catch (err: any) {
    // Logged for the Netlify function log. A failed build deliberately leaves the
    // PREVIOUS index in place — stale search beats no search.
    console.error("[search-index-build] FAILED after", Date.now() - started, "ms:",
      err?.stack || err?.message || err);
  }
};

export const config: Config = {
  // Declared in code rather than netlify.toml so the schedule lives next to the
  // reasoning for it, and there is only one source of truth.
  schedule: "0 */6 * * *",
};
