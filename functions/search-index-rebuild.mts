// Search index rebuild — MANUAL / HTTP trigger
//
// Two uses:
//   1. Validation. ?dry=1 builds and reports WITHOUT writing to Blobs, so the
//      join, folds, exclusions and compliance guard can be checked against live
//      data before anything is persisted.
//   2. Off-cycle rebuilds — e.g. after editing the search synonym/pin tables,
//      instead of waiting up to 6h for the schedule.
//
// WHY THIS EXISTS SEPARATELY FROM search-index-build.mts
//   Netlify does not expose scheduled functions over HTTP (a GET returns 403), so
//   the scheduled function cannot be curl'd. This is the reachable twin. Both call
//   the same lib/search-index-builder.js, so they cannot drift.
//
// WHY v2 (.mts): @netlify/blobs only auto-configures on the v2 runtime. See the
// note in search-index-build.mts.
//
// WHY THE KEY MATTERS
//   A build makes ~29 Airtable calls. Unauthenticated, a loop over this endpoint
//   would burn the 100k/month Airtable quota in under an hour — the same failure
//   crossell-config.js caused accidentally, but deliberate. The key protects quota
//   (availability), not secrecy.
//
//   Because access already requires the key, this endpoint returns VERBOSE errors
//   including a stack, and reports build failures separately from storage failures
//   so one is never mistaken for the other.
//
// INVOKE
//   GET /.netlify/functions/search-index-rebuild?key=<SEARCH_INDEX_KEY>&dry=1
//   GET /.netlify/functions/search-index-rebuild?key=<SEARCH_INDEX_KEY>
//
// Env: SEARCH_INDEX_KEY, plus everything lib/search-index-builder.js needs.

import type { Config, Context } from "@netlify/functions";

/* Static import, NOT createRequire(). esbuild cannot statically analyse a
 * require() obtained from createRequire, so it left the call as a runtime
 * lookup and never bundled the file — the deploy crashed with
 * "Cannot find module '../lib/search-index-builder.js'". A static import is
 * bundled; the default export of a CommonJS module is its module.exports. */
import builder from "../lib/search-index-builder.js";
import { writeIndex, codeVersion } from "../lib/search-index-store.mjs";
const { build, keyMatches } = builder as any;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const want = Netlify.env.get("SEARCH_INDEX_KEY") || "";

  if (!want) {
    return json(503, { ok: false, error: "SEARCH_INDEX_KEY is not set in this environment" });
  }
  if (!keyMatches(url.searchParams.get("key"), want)) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const dry = url.searchParams.get("dry") === "1";
  const started = Date.now();

  try {
    const { index, stats } = await build();
    const bytes = Buffer.byteLength(JSON.stringify(index));

    let blobs = "skipped (dry run)";
    if (!dry) {
      try {
        blobs = await writeIndex(index);
      } catch (blobErr: any) {
        // The build succeeded; only storage failed. Reporting these as separate
        // stages is what made the v1 Blobs incompatibility obvious immediately.
        return json(500, {
          ok: false,
          stage: "blobs-write",
          error: String(blobErr?.message || blobErr),
          stack: blobErr?.stack ? String(blobErr.stack).split("\n").slice(0, 6) : undefined,
          buildOk: true,
          codeVersion: codeVersion(),
          bytes,
          ms: Date.now() - started,
          ...stats,
        });
      }
    }

    const report = { ok: true, trigger: "manual", dry, bytes, ms: Date.now() - started, blobs, ...stats, codeVersion: codeVersion() };
    console.log("[search-index-rebuild]", JSON.stringify(report));
    // Sample docs make it obvious at a glance whether the join actually worked —
    // null prices or zero sales across the board mean it did not.
    return json(200, dry ? { ...report, sample: index.docs.slice(0, 8) } : report);
  } catch (err: any) {
    console.error("[search-index-rebuild] FAILED", err?.stack || err);
    return json(500, {
      ok: false,
      stage: "build",
      error: String(err?.message || err),
      stack: err?.stack ? String(err.stack).split("\n").slice(0, 6) : undefined,
      ms: Date.now() - started,
    });
  }
};

export const config: Config = {
  path: "/.netlify/functions/search-index-rebuild",
};
