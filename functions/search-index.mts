// Search index — PUBLIC READ ENDPOINT
//
// Serves the index built by search-index-build.mts. The footer script fetches this
// once, lazily, on first interaction with the search box and does all matching
// client-side.
//
// WHY NOT BUILD ON REQUEST
//   A full build takes ~13s and makes ~29 Airtable calls — well past what a
//   synchronous function should do. So the build is scheduled and this endpoint
//   only reads the prebuilt blob. No amount of traffic can reach Airtable.
//
// WHY v2 (.mts): @netlify/blobs only auto-configures on the v2 runtime; under
// exports.handler it throws MissingBlobsEnvironmentError. See search-index-build.mts.
//
// CACHING — 'durable' IS LOAD-BEARING
//   Plain s-maxage caches PER EDGE POP, so every POP would miss independently and
//   re-invoke. 'durable' persists the response in Netlify's global object store so
//   all edge nodes share one copy. This is the same fix applied to
//   crossell-config.js after uncached reads pushed the Airtable workspace to 1.77M
//   calls against a 100k/month quota. Do not drop the directive.
//
//   CDN TTL matches the 6-hourly build cadence. Browsers get a short TTL plus an
//   ETag, so a rebuild reaches customers promptly without re-downloading ~430KB on
//   every page view.
//
// NOTE ON CONTENT
//   This response is PUBLIC. The builder enforces a field allowlist and a leak
//   guard so no cost/wholesale/margin data can reach it. If you add fields to the
//   index, re-read the SECURITY note in lib/search-index-builder.js first.

import type { Context } from "@netlify/functions";
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const BLOB_STORE = "search";
const BLOB_KEY = "index.json";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, if-none-match",
  "access-control-allow-methods": "GET, OPTIONS",
};

// 6h at the edge, matching the build cadence; serve stale for a day while
// revalidating so a late or failed build never leaves the box without an index.
const CDN_CACHE = "public, durable, s-maxage=21600, stale-while-revalidate=86400";
/* Browser TTL. The index only changes every 6h, so 300s was needlessly chatty —
 * 15 minutes still propagates a rebuild quickly while cutting revalidations by 3x.
 * must-revalidate plus the ETag below keeps a stale copy from being served. */
const BROWSER_CACHE = "public, max-age=900, must-revalidate";

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  let index: any = null;
  try {
    index = await getStore(BLOB_STORE).get(BLOB_KEY, { type: "json" });
  } catch (err: any) {
    // A read can throw rather than return null when the store does not exist yet.
    // Either way there is no index to serve. Detail is an infrastructure message
    // only — no stack, since this is public. For a full diagnosis use
    // search-index-rebuild, which is key-protected and verbose.
    console.error("[search-index] blob read threw:", err?.stack || err);
    return new Response(JSON.stringify({
      error: "index unavailable",
      detail: String(err?.message || err).slice(0, 200),
      hint: "run search-index-rebuild?key=…&dry=1 to diagnose",
    }), {
      status: 503,
      // NEVER cache a failure: with durable caching, a first-deploy miss would
      // otherwise be pinned at the edge for six hours.
      headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  if (!index) {
    return new Response(JSON.stringify({
      error: "index not built yet",
      hint: "run search-index-rebuild",
    }), {
      status: 503,
      headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const body = JSON.stringify(index);
  const etag = '"' + createHash("sha1").update(body).digest("base64") + '"';

  /* Compare NORMALISED ETags. Netlify rewrites ours when it applies its own
   * content encoding, appending a suffix: we send "abc=" and the edge serves
   * "abc=-df", so the browser echoes back the suffixed form and a literal
   * comparison never matches — every revalidation then re-sent ~93KB instead of a
   * 304. Strip weak prefixes, quotes and any trailing -suffix before comparing. */
  const normalise = (t: string) =>
    t.trim().replace(/^W\//, "").replace(/"/g, "").replace(/-[0-9a-z]+$/i, "");
  const inm = req.headers.get("if-none-match") || "";
  if (inm && inm.split(",").some((t) => normalise(t) === normalise(etag))) {
    return new Response(null, {
      status: 304,
      headers: { ...CORS, etag, "cache-control": BROWSER_CACHE, "netlify-cdn-cache-control": CDN_CACHE },
    });
  }

  return new Response(body, {
    status: 200,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      etag,
      "netlify-cdn-cache-control": CDN_CACHE,
      "cache-control": BROWSER_CACHE,
      "x-index-built-at": String(index.builtAt || ""),
      "x-index-docs": String((index.docs || []).length),
    },
  });
};
