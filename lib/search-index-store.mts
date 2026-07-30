// Search index — storage + build fingerprint (ESM side)
//
// These two things cannot live in lib/search-index-builder.js. That module is
// CommonJS so the offline tests can require it, and esbuild turns a top-level
// require() of anything external into a shim that throws once it is bundled into
// an ESM v2 function:
//
//   Error: Dynamic require of "https" is not supported
//
// So anything needing a real import — @netlify/blobs, node:crypto, node:fs —
// belongs here, in a module that is ESM from the start.

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* Keep in sync with lib/search-index-builder.js, which exports these too so both
 * the writer and the reader agree on where the index lives. */
export const BLOB_STORE = "search";
export const BLOB_KEY = "index.json";

/** Persist a freshly built index. Returns a short human-readable confirmation. */
export async function writeIndex(index: unknown): Promise<string> {
  await getStore(BLOB_STORE).setJSON(BLOB_KEY, index);
  return `wrote ${BLOB_KEY} to store "${BLOB_STORE}"`;
}

/* Fingerprint of the deployed bundle, so a report from a stale deploy is
 * distinguishable from a fix that did not work — that ambiguity has already cost a
 * debugging round trip.
 *
 * Hashing the bundle rather than reading COMMIT_REF/BRANCH: those are build-time
 * variables and are NOT scoped to the function runtime, so they came back
 * "unknown". Computed once; never throws — a diagnostic must not fail a build. */
let cached: string | null = null;
export function codeVersion(): string {
  if (cached) return cached;
  try {
    cached = createHash("sha1")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex")
      .slice(0, 8);
  } catch {
    cached = "unknown";
  }
  return cached;
}
