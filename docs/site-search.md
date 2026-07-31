# Site Search — design, findings and status

> **This file is the living document.** It lives in git so it has version control and
> diffs. Snapshots are published to the shared Google Drive folder at milestones for
> people who don't use git — Drive is deliberately not kept in step commit by commit.
>
> **Status as of 2026-07-31 — the indexer is BUILT and VERIFIED on `develop`.**
>
> | Piece | State |
> |---|---|
> | Airtable API quota overage | ✅ fixed, in production (`4743281`) |
> | Index builder + scheduled rebuild | ✅ built, verified end to end on `develop` |
> | Public read endpoint (durable cache) | ✅ verified — 800 docs, 93KB gzipped |
> | Client-side search UI (dropdown) | ⬜ not started — this is what reaches customers |
> | Brand/category FAQ folding | ⬜ not started (~774 FAQs currently unused) |
> | Cherry-pick to `main` | ⬜ pending — the schedule only runs on published deploys |
>
> Sections §0–§0f are measured findings and remain accurate. §4–§6 are the original
> options comparison, kept for the reasoning trail — the decision (Option A) is
> settled and built. §7 is the dashboard design, not yet built.

---

**Site:** thegreendragoncbd.com — Webflow site ID `627d284eb79828f894d0a981` ("TGD Website")
**Date:** 2026-07-30
**Stated priority:** results relevance ("bad/irrelevant results")
**Stated scope:** everything — products, brands, categories, blog, info pages

> **Data provenance:** all counts below are measured directly from the Webflow CMS API (`list_collection_items` totals) and `list_pages`, not estimated from `sitemap.xml`. An earlier draft of this doc used sitemap estimates that were wrong by a wide margin (it claimed ~800 products and ~500 blog posts; actual figures are 539 and 307). Treat sitemap-derived counts as unreliable for this site.

---

## 0. What the search box actually is

**Correction:** an earlier draft of this doc claimed the top-bar box was broken and returned zero results for every query. **That was wrong.** I tested by fetching raw HTML without executing JavaScript, which cannot evaluate a client-side Finsweet filter — a JS-driven filter shows zero matches under that method no matter what. The test was invalid and the conclusion is retracted.

What the markup does show is **three distinct search inputs** on the site:

| # | Selector | Wiring | What it does |
|---|---|---|---|
| 1 | `#search-site` | `name="query"`, `type="search"`, inside `<form action="/search">` | Feeds Webflow **native site search**. On the homepage this form carries the class `hide-me`. |
| 2 | `#search-bar` | `name="*"`, `data-name="*"`, **no `fs-cmsfilter-field` attribute**, inside a Webflow **Form Block** (`data-wf-page-id`, `w-form-done`) | Class is `search-input navbar` — the top-bar box. No static binding to either Webflow search or Finsweet. |
| 3 | `#field-3` | `fs-cmsfilter-field="*"`, class `product-filter_search`, placeholder "Search for anything" | The **Finsweet CMS Filter** input in the product-list filter sidebar. This is the one that demonstrably works. |

Confirmed by script load: `/shop-all-products` loads `cmsfilter.js` + `cmsload.js`; `/search` loads **neither** (only `cmsstatic` and `countitems`), so the `fs-cmsfilter-*` attributes present on `/search` are inert leftovers.

### RESOLVED: how search actually works

Confirmed by browser test. **Input 2 is the top bar, and `name="*"` is deliberate - not a bug.**

The flow:

1. Top bar submits a **GET to `/shop-all-products`**, producing e.g. `?*=binoid`.
2. Finsweet CMS Filter on that page reads the `*` query param and applies it to the input carrying `fs-cmsfilter-field="*"` (input 3, the sidebar "Search for anything").
3. The product list filters client-side to matching items.

This is **Finsweet's URL-prefilter convention**: the query-param name must match the `fs-cmsfilter-field` value. Since the target field is `*` ("search all fields"), the param must be `*`.

**Do not "fix" `name="*"`.** An earlier draft of this doc proposed renaming it to `name="query"`. That would send `?query=binoid`, which Finsweet ignores - **silently breaking search on all 120 pages.** The proposal came from a raw-HTML test that cannot see client-side JavaScript. It was never implemented; only the section 0c cache header shipped.

Input 1 (`#search-site`, `name="query"`, `hide-me`) is a separate legacy path feeding Webflow native search at `/search` - effectively dead (section 0d).

Relevant components either way:

| Component | ID | Instances |
|---|---|---:|
| **Header Searchbar** | `052d85f0-55d4-e3aa-2bfa-a60f597c1e55` | **120** |
| Header Searchbar (Wholesale) | `3fcd2ef9-26f9-bbd9-3c4f-6016bf63591f` | 14 |

---

## 0b. Why Finsweet CMS Filter explains "bad/irrelevant results"

This is the real diagnosis, and it's a **stronger** argument for replacement than "Webflow native search is weak." Finsweet CMS Filter is a **substring filter over a rendered CMS list**, not a search engine:

- **No relevance ranking.** Results come back in the CMS list's existing sort order — your `Shop All Sort Order` / merchandising order — not best-match order. Searching "gummies" returns gummies in merchandising order, so the most relevant item is wherever it happened to sit in the list. This is precisely the "bad/irrelevant results" complaint.
- **Substring match only.** "gummis" matches nothing. No typo tolerance, no stemming, no synonyms ("weed" ≠ "THC").
- **Products only.** It filters one CMS list, so blog posts, brands, FAQs, strains, and the ~50 commercial landing pages are **not searchable at all** — which is exactly why you asked for "everything."
- **Page-weight cost.** `/shop-all-products` uses `fs-cmsload-mode="render-all"` and ships **550KB of HTML with 574 rendered CMS items**. Client-side filtering over the full catalog only works because the whole collection is rendered into the DOM on every such page.

That last point reframes the payload question in §4. A search index is fetched **once and cached across the entire site**; the Finsweet approach re-ships the collection's markup on every category page. So the index isn't added weight on top of a lean site — it substitutes for a pattern you're already paying for repeatedly.

---

## 0c. ✅ RESOLVED: Airtable API quota was 17.7× over (fixed & shipped)

Measured from the workspace settings screen (Airtable **Pro**, monthly):

| Metric | Usage | Limit | Status |
|---|---|---|---|
| Records (per base) | 10,735 | 50,000 | ✅ healthy — 39k headroom |
| Attachments | 1.9 GB | 20 GB | ✅ |
| **Public API calls (per month)** | **1,769,076** | **100,000** | 🔴 **1,769% of quota** |
| Paid users | 10 | 10 | ⚠️ at seat limit |
| AI credits | 0 | 150,000 | — |

**This blocked the indexer** — there was no API headroom for scheduled Airtable reads. **Fixed and shipped to production on 2026-07-30** (commit `4743281`); see the verification below.

### Root cause: `crossell-config.js`

`netlify-functions/functions/crossell-config.js` returned **`Cache-Control: no-store`** on its success path (line 58), and `crossell-popup.js` is embedded site-wide in the Webflow footer.

**Correction to an earlier draft:** I first wrote that this fired on *every page view*. That was imprecise. `crossell-popup.js` already caches the config in `sessionStorage` (`tgd_crossell_config`, lines 1225–1235), so it's **one fetch per browser session**, not per page view. The mechanism and the magnitude are unchanged — 1,769,076 calls ÷ ~15 per invocation ≈ 118,000 invocations/month ≈ **~3,900/day**, which reads as a very plausible daily *session* count.

If anything this sharpens the diagnosis: the client already deduplicated *within* a session, but nothing deduplicated *across* sessions, so every new visitor cost ~15 Airtable reads. Durable Cache is precisely the missing layer — it collapses all sessions globally to ~4 origin hits/day.

Worse, each invocation makes 12–18 Airtable requests, including an N+1 loop at lines 111–122 — one request *per primary category*:

```js
await Promise.all(primaryCatData.map(async pc => {          // N+1: one request per category
  await base(PARENT_CATEGORIES_TABLE).select({
    fields: ['Name'],
    filterByFormula: `{Primary Categories} = "${pc.name}"`,
  })...
```

Plus separate paginated reads of Primary Categories, Cross-Sells, Products, and Variants.

At ~15 requests per invocation, 1,769,076 calls implies roughly **118,000 invocations/month (~3,900/day)** — consistent with normal site traffic. The mechanism and the magnitude agree, so I'm confident this is the source rather than a coincidence.

### The fix as shipped

```js
'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=21600, stale-while-revalidate=86400',
'Cache-Control': 'public, max-age=60',
```

The **`durable`** directive is load-bearing and was the reason not to just use plain `s-maxage`. Plain `s-maxage` caches **per edge POP**, so each POP would miss independently and re-invoke the function, multiplying Airtable reads by POP count — potentially leaving the quota still blown even "with caching." `durable` persists the response in Netlify's global object store so all edge nodes share one copy. It is serverless-functions-only, which is exactly this case.

Cross-sell config is merchandising data that changes rarely, so 6h of edge staleness is an acceptable trade; `stale-while-revalidate` means visitors are never blocked on a refresh. Collapsing the N+1 into a single query is no longer worth doing — at ~120 origin invocations/month it costs ~1,080 calls, which is noise. It was only ever a problem because it ran per session.

The error path is deliberately left **uncached** so transient Airtable failures can recover instead of being pinned at the edge.

Also worth auditing the other Airtable-reading functions for the same pattern: `back-in-stock-subscribe.js`, `custom-shipping-endpoint.js`, and `pre-payment-webhook.js` show no cache handling (though the latter two are webhook-driven, so per-request reads are expected there).

### ✅ Verified on both `develop` and production

Shipped as `e41d64e` on `develop`, cherry-picked to `main` as `4743281`. Measured against `develop--wondrous-bublanina-d440ec.netlify.app`:

```
req 1:  Cache-Status: "Netlify Durable"; hit; ttl=21501,"Netlify Edge"; fwd=miss   1632ms
req 2:  Cache-Status: "Netlify Edge"; hit                                            66ms
req 3:  Cache-Status: "Netlify Edge"; hit                                            72ms
```

Request 1 is the decisive case: **the edge POP missed** (`fwd=miss`), and without the `durable` directive that miss would have invoked the function and fired ~15 Airtable reads. Instead `"Netlify Durable"; hit` served it — the function never ran, Airtable was never touched. That's the per-POP multiplication problem provably solved rather than merely avoided.

- `ttl=21501` confirms `s-maxage=21600` is honored, with `Age: 99` accounting for the difference.
- `Cache-Control: public, max-age=60` reaches the browser; `Netlify-CDN-Cache-Control` correctly governs the CDN only.
- `Netlify-Vary: query` is harmless here — `crossell-popup.js` builds the URL with **no query string** (line 56–57), so all callers share one cache key. Worth preserving: adding a cache-buster param would fragment the durable cache per-param and silently undo this.
- Latency dropped to ~70ms from local edge, so the popup is faster too.

Production shows the same behaviour after the cherry-pick:

```
prod req 1:  Cache-Status: "Netlify Durable"; hit; ttl=21325,"Netlify Edge"; fwd=miss
prod req 2:  Cache-Status: "Netlify Edge"; hit
```

**Remaining step:** confirm the Airtable API counter falls off a cliff over 2–3 days. The header check proves the caching mechanism works; it does **not** yet prove `crossell-config.js` was the *whole* 1.77M. If the counter only falls partway, something else reads Airtable per-request — audit `back-in-stock-subscribe.js` and `custom-shipping-endpoint.js` next.

⚠️ **Behaviour change to remember:** cross-sell config edits in Airtable now take up to 6h to appear on the site instead of being instant.

### Indexer API budget (once fixed)

A full rebuild reads ~42 Airtable requests (Products ~7, Variants ~11, FAQs ~12, Blog ~4, Brands 2, categories/strains/basics ~3, config tables ~3):

| Cadence | Calls/month | % of 100k quota |
|---|---:|---:|
| Hourly | ~30,240 | 30% ❌ too greedy |
| **Every 6 hours** | **~5,040** | **5% ✅ recommended** |
| Daily | ~1,260 | 1.3% |

**Recommendation: full rebuild every 6 hours, plus an Airtable-automation webhook that triggers an off-cycle rebuild when a merchandising config table changes.** Config edits stay near-instant, and steady-state cost is ~5% of quota. Still a 24–72× improvement in freshness over Webflow's publish-gated reindexing.

---

## 0d. Search is currently unused — which changes the sequencing

**`/search` received 1 pageview in the last month**, likely internal testing. Combined with §0's markup findings, that tells us something important:

- The native search results page is **effectively dead**. No inbound-link or SEO risk in changing or replacing it, and no URL to preserve.
- The top-bar box is **not navigating to `/search`**. So it either filters in place via Finsweet, or customers aren't using it.
- The only search customers actually use is the Finsweet sidebar filter (`#field-3`) on `/shop-all-products` and category pages.

### Two consequences worth being honest about

> **Superseded by section 0f** - the data was pulled and the questions below are answered. Kept for the reasoning trail.

**1. Baseline query data probably DOES exist - correcting an earlier claim.** I previously wrote that there was no historical search data to mine. That was wrong, and it followed from assuming `/search` was the only search surface. Because the real flow puts the query **in the URL** as `/shop-all-products?*=<term>` (section 0), every historical search is already recorded in GA4.

**Action: pull GA4 -> "Page path + query string", filtered to `/shop-all-products` containing `*=`.** That yields the actual search terms customers have used and their volumes, retroactively, with **no instrumentation and no two-week wait.**

This is the single highest-value next step. It delivers:

- **Real demand volume** - settles the suppressed-demand question immediately.
- **The actual query corpus** - raw material for the synonym map and pinned results in section 7, built from evidence instead of guesswork.
- **Zero-result candidates** - cross-reference the terms against the catalog to find searches that currently return nothing.

Caveat: if the GA4 property is configured to exclude query parameters from page paths, the terms will not be there. Worth checking first - and if they have been stripped, that is exactly what section 7's `search` event instrumentation fixes going forward.

**2. The ROI case rests on an assumption - but GA4 can now settle it.** With `/search` near-dead, the case looked like *suppressed demand* rather than *observed demand*. That judgement was based on the wrong surface: the `/shop-all-products?*=` data above measures **actual** search usage, so this stops being an assumption as soon as that report is pulled. That's a reasonable assumption here — the box appears to be collapsed behind a magnifier icon (`search_icon-link-wrapper` carries a `data-w-id` interaction, and the correctly-wired form carries the class `hide-me`), and a collapsed icon reliably gets a fraction of the usage a visible input gets. With 539 products, 3 category levels, and ~50 landing pages, search *should* be carrying real load. But it is an assumption, and it deserves to be tested cheaply rather than assumed at the cost of a full build.

### Recommended re-sequencing

Insert a cheap validation step **before** the indexer:

| Step | Work | Purpose |
|---|---|---|
| **0e** | Pull the GA4 `/shop-all-products?*=` report | **~30 minutes, no code.** Retroactive demand volume plus the real query corpus. |
| then | Indexer, dropdown, matcher upgrade, dashboard | Build against evidence, sized to observed demand. |

This replaces the earlier plan of instrumenting and waiting two weeks - the data already exists.

**This does not invalidate the relevance work.** The Finsweet filter *is* used, and it's a substring match with no ranking (§0b) — that's a real defect on a real path, worth fixing regardless. The re-sequencing is about *ordering* and *sizing*, not about whether to do it.

---

## 0e. Scope reduction: most of the surface already works

Knowing the real flow shrinks this project meaningfully. What exists versus what is actually broken:

| Piece | Status |
|---|---|
| Search entry point | **Works** - top bar, 120 instances |
| Query -> results navigation | **Works** - GET to `/shop-all-products?*=` |
| Results page | **Exists** - `/shop-all-products` |
| Facets | **Exists** - Finsweet sidebar: brand, category, subcategories, price rangeslider |
| **Matching** | **Broken** - substring only, no typo tolerance, no synonyms |
| **Ranking** | **Broken** - CMS sort order, not relevance; no `Number of Sales`, no stock awareness |
| **Coverage** | **Broken** - products only; blog, brands, FAQs, strains, ~50 landing pages unreachable |

So we are **not** building a search surface from scratch. We are replacing the **matching and ranking engine** behind a working one, and adding cross-content coverage.

That reshapes two build steps:

- **Results page (was step 3):** largely already built. Rather than a new page, the cheaper intervention is to **rescore the existing list**. Because `fs-cmsload-mode="render-all"` puts every product in the DOM, a script can match and reorder those existing nodes using our index for scoring - keeping Finsweet for facets and rendering. Much less work than a new page, and no disruption to a flow customers already use.
- **Cross-content coverage:** cannot live on `/shop-all-products`, which is a product list. The **instant dropdown is the natural home** for "everything" - grouped Products / Brands / Categories & Landing Pages / Articles - while the product page keeps products-plus-facets. That split falls out of the architecture rather than being imposed on it.

Net effect: the dropdown becomes the highest-value net-new piece, and the page-level matcher upgrade is the fix for the path customers already use.

---

## 0f. MEASURED search demand (GA4, 12 months: 2025-07-29 to 2026-07-29)

The GA4 `/shop-all-products?*=` export settles every open question about demand. **Search is heavily used.**

| Metric | Value |
|---|---|
| Total views on `?*=` filtered pages | **212,853** |
| Of which are likely typed queries | **175,871** (83%) |
| Facet/category selections (contain `&` or `,`) | 35,515 (17%) |
| Distinct normalized typed queries | **22,046** |
| Approx. typed searches per day | **~480** |

**This retires the "search is unused" concern entirely.** `/search` having 1 pageview was a red herring - it was simply the wrong surface. Demand is *observed*, large, and no longer an assumption.

### Search runs on more pages than we thought

| Host page | Views |
|---|---:|
| `/shop-all-products` | 183,295 |
| `/product-primary-categories/thc` | 23,187 |
| `/shop-all-thc-cbd-glass-products` | 4,693 |
| `/sales-deals` | 699 |
| `/special-code` | 504 |
| `/product-primary-categories/soul-energy` | 405 |
| `/subcategories/thc-vape-pens-carts` | 50 |

So the `*=` prefilter is live on category and collection pages too, not just shop-all. Any matcher replacement has to work on all of them.

### Finding 1: ~18% of search is brand-seeking

Cross-referenced against all 102 Brand records:

- **13.3%** (23,389 views) are an **exact brand name**, across 93 different brands
- **4.6%** (8,158 views) name a brand **inside a longer query** ("elf thc", "ghost carts")
- **Total: 31,547 views = 17.9% of typed searches**

Top brand searches: Flying Horse (5,844 exact + 1,507 embedded = **7,351**), Ghost (3,371 + 1,944 = **5,315**), OPiA (3,029), Space Gods (1,631), Cake (2,040), Torch (2,004), Dome Wrecker (1,139).

Today a search for "flying horse" substring-matches product *names* and returns them in **merchandising order**. It does not surface the Flying Horse brand page. Brands are a content type we already planned to index (102 records) - this data says they should also be **pinned** to the top for exact brand matches.

### Finding 2: spelling fragmentation is enormous - the synonym map has a measured payload

| Concept | Views | Distinct spellings | Examples |
|---|---:|---:|---|
| vape pens | **13,363** | 99 | `vape pens` (9,053), `vape` (1,734), `vapes` (813), `disposable` (765), `pen` (192) |
| vape carts | **7,328** | 9 | `vape carts` (5,324), `cart` (777), `carts` (587), `cartridge` (333) |
| **7-OH** | **5,327** | **276** | `7oh` (1,752), `7` (1,063), `7 oh` (878), `7-oh` (451), `7 hydroxy` (146) |
| gummies | **4,908** | 205 | `gummies` (3,268), `edibles` (598), `gummy` (261), `gummi` (74), `gummie` (65) |
| delta 9 | **2,518** | 277 | `delta 9` (1,119), `delta 9 gummies` (395), `d9` (89) |
| delta 8 | **1,942** | 234 | `delta 8` (949), `delta 8 gummies` (360), `d8` (25) |
| pre-rolls | **1,893** | 67 | `pre rolls` (629), `prerolls` (367), `preroll` (324), `pre roll` (284) |
| tinctures | **1,130** | 14 | `tinctures` (882), `tincture` (188), `oil` (44) |

**7-OH alone is spelled 276 different ways for 5,327 views.** This is no longer a guess about "weed" vs "THC" - it is a concrete, prioritized synonym list drawn from what customers actually type.

### Finding 3: brand misspellings - 3,592 views across 80 near-miss spellings

Fuzzy-matched against the brand list:

| Query | Views | Intended brand |
|---|---:|---|
| `tre house` | 438 | TRĒ House |
| `spacegods` | 189 | Space Gods |
| `space god` | 184 | Space Gods |
| `shrooms` | 149 | Shroomi |
| `domewrecker` | 137 | Dome Wrecker |
| `trehouse` | 111 | TRĒ House |
| `3 chi` | 111 | 3CHI |
| `flying horses` | 104 | Flying Horse |
| `moonwalker` | 100 | MoonWlkr |
| `stiizy` | 57 | Stiiizy |

🎯 **The clearest single example: "TRĒ House" contains a macron (Ē).** Substring matching means `tre house` and `trehouse` - **549 views/year** - can *never* match it. Diacritic folding alone fixes that, and it's a two-line change in the indexer. Same class of bug for `3 chi` vs `3CHI` (whitespace), `stiizy` vs `Stiiizy` (letter count), `moonwalker` vs `MoonWlkr` (dropped vowels).

### Finding 4: possible catalog or brand-page gaps

High-volume queries matching **no** brand record, which look like brand names rather than product types:

`fvkd` (896) · `elf` (848) + `elf thc` (681) · `kush burst` (568) · `graveyard` (510) · `koi` (487) · `sumo` (483) · `haze` (688)

Each is either a brand you carry without a Brand record, or a brand customers want that you don't stock. **Worth your eyes - I can't tell which from data alone**, but either way these are thousands of searches a year landing on poor results.

### Finding 5: a long tail that only fuzzy matching can serve

- 22,046 distinct queries; the top 200 account for just **54.6%** of volume
- **52% of distinct queries (11,562) have exactly 1 view**

Hand-curated synonyms will never cover that tail. This is the strongest argument for a real engine with typo tolerance and stemming over any amount of manual mapping.

### ⚠️ Caveat: the counts are inflated by keystroke-level pageviews

~22% of typed views are queries of 4 characters or fewer, and prefixes show up as their own rows - `delta` (990) alongside `delta 8` (949) and `delta 9` (1,119); `7` (1,063) alongside `7oh` (1,752).

The cause: GA4 enhanced measurement fires a `page_view` on History API changes, and Finsweet rewrites the URL as the filter updates. So incremental typing logged multiple pageviews per actual search. **Absolute counts overstate distinct searches; relative rankings remain sound.** Don't quote "480 searches/day" externally without that qualifier.

There's a silver lining: it proves customers **type incrementally and watch results update** - which is exactly the behaviour an instant dropdown is designed for, and evidence that the dropdown is the right primary investment.

---

## 1. What we have today

Webflow's **native site search**, with a results page at `/search` (page ID `62868ade8bbf47ff70e20b5b`, created 2022). Plan: **Enterprise Lite**.

Verified problems:

| Problem | Detail |
|---|---|
| **Stale index** | Webflow's published timings are 12h after full-site publish (Premium) / 72h (legacy CMS); manual reindex is limited to once every 12–24h. **Webflow does not publicly document Enterprise timings** — worth asking your Webflow rep, though it doesn't change the design. The structural problem holds on every plan: reindexing is **gated on a full-site publish**, and single-item CMS publishing never triggers it. |
| **No relevance ranking** | Loose whole-word token matching, no ranking. Webflow's own docs recommend third-party search above **100 items** — we have ~3,500 indexable URLs. |
| **No typo tolerance** | "gummis", "delta 8", "kratom capsuls" → poor or empty results. |
| **No synonyms** | "weed" ≠ "THC", "edibles" ≠ "gummies", "pen" ≠ "vape". |
| **No stock awareness** | Discontinued and out-of-stock products rank identically to in-stock bestsellers. |
| **Broken results page** | Header reads "Showing 0 results" above 10 real results; prices render as `$11.11 - $11.11` (the CMS price-binding gotcha). |

Both display bugs get resolved for free by any replacement, since we build a new results page.

**Retracted:** an earlier draft claimed there was no search box in the nav. That was wrong — it came from an unreliable summarized HTML read. There *is* a top-bar search box, built as the separate **Header Searchbar** component (120 instances). See §0 for what it's wired to.

Note that native site search is only part of the story — the working product search is the Finsweet filter (§0b), so the native-search weaknesses below apply mainly to `/search`, while the Finsweet weaknesses apply to the box customers actually use.

Because the box already exists, build step 2 is *attaching an instant dropdown to an existing component* rather than designing and placing a new one — less work and less design risk than originally scoped.

---

## 2. Measured content inventory

### CMS collections (32 total; counts are live item totals)

| Collection | Items | Template path | Index as |
|---|---:|---|---|
| **FAQs** | **1,143** | `/faqs/` | folded into parent product (§3b) — never a standalone result |
| **Product Variants** | **1,026** | `/product-variants/` | folded into parent product (§3b) — never a standalone result |
| **Products** | **539** | `/product/` | ✅ primary doc |
| **Blog Posts** | **307** | `/blog/` | ✅ doc |
| **Brands** | **102** | `/brand/` | ✅ doc |
| Basics | 62 | `/basics/` | ✅ doc |
| Product Parent Categories | 59 | `/product-parent-categories/` | ✅ doc |
| Strains | 59 | `/strains/` | ✅ doc |
| Content Categories | 42 | `/category/` | optional (blog taxonomy) |
| Effects | 19 | `/effects/` | facet only |
| Team Members | 18 | `/team-members/` | low value (blog authors) |
| Aromas | 17 | `/aromas/` | facet only |
| Coupons | 17 | `/coupons/` | ✅ doc (people search "coupon") |
| Product Subcategories | 11 | `/product-subcategories/` | ✅ doc |
| Terpenes | 10 | `/terpenes/` | facet only |
| Product Primary Categories | 9 | `/product-primary-categories/` | ✅ doc |
| Success Stories | 6 | `/success-stories/` | ✅ doc |
| Store Locations | 1 | `/store-locations/` | ✅ doc |
| Careers | 1 | `/careers/` | ✅ doc |
| Promoted Sales | 1 | `/promoted-sales/` | skip |
| Reviews | **0** | `/reviews/` | empty — skip |
| Wholesale Products | **0** | `/products-wholesale/` | empty — skip |
| *(9 more: wholesale taxonomies, strain reviews, banners, etc.)* | — | — | skip |

**Total CMS items: ~3,449.**

### Static pages (174 total, roughly half are drafts)

The single biggest thing the earlier draft missed: there are **~50 hand-built commercial SEO landing pages** — `delta-8-gummies-edibles`, `thc-vape-pens-carts`, `thca-flower-prerolls`, `live-resin-vape-carts`, `thc-gummies`, `torch-gummies`, `ghost-carts`, `cake-weed-pen`, and so on — plus ~35 info/policy pages (`about`, `contact`, `faq`, `coupons`, `privacy-policy`, `terms-and-conditions`, `sales-deals`, `new-products`, `all-brands`).

These are **high-intent search targets**. Someone typing "delta 8 gummies" should land on `/delta-8-gummies-edibles`, and native search ranks these poorly today.

⚠️ **Roughly half the 174 pages are `draft: true`** (`components-test`, `sitewide-popup`, `careers-staging`, `shop-all-products-simple`, everything under `/pending-removal/` and `/templates/`). The indexer must filter on `draft === false` or we'll surface staging junk.

### What actually gets indexed

| | Count |
|---|---:|
| Standalone search documents | **~1,320** |
| Variant names folded into product docs | 1,026 strings |
| FAQ questions folded into product docs | 1,143 strings |

**Payload estimate:** ~630KB raw → **~160–190KB gzipped**, lazy-loaded on first interaction with the search box. Well inside what runs instantly client-side. (FAQ *answers* are rich text and must be truncated or omitted — indexing them in full would roughly triple the payload for little relevance gain. The *questions* are the high-signal part.)

---

## 3. The asset nobody's using: Airtable

Every content type also lives in Airtable (base `appWUsGD3byrYcN3l`, 41 tables), and the `Products` table carries **174 fields** — including ranking signals Webflow search can never see:

- **`Number of Sales`** — real popularity ranking. The single biggest relevance win available.
- **`Inventory`** (+ per-location: Chesterfield, St Peters, Warehouse), **`Discontinued`**, **`Allow Backorders`** — demote or hide what can't ship.
- **`Website Status`**, **`Distro Only`**, **`In-Store Only`**, **`To Be Deleted`**, **`Removal Status`** — keep non-web items out of results.
- **`Brand`**, **`Strains`**, three levels of category — real facets and synonym dimensions.
- **`On Sale`**, **`Sale Price`**, **`Lowest/Highest Price`** — correct price display, fixing the `$11.11` bug.
- **`Description (Full)`**, **`Summary`**, **`Ingredients`**, **`Meta Description`** — searchable body text.

### Architecture implication: join, don't pick

Airtable and Webflow are **not** interchangeable, and the earlier draft was wrong to describe this as Airtable-sourced. Airtable almost certainly holds *more* product records than the 539 live on the site (that's what `Distro Only` / `In-Store Only` / `Discontinued` exist for). So:

- **Webflow CMS is the authority for what has a live, linkable URL** (539 products, `draft: false`).
- **Airtable is the authority for ranking signals and rich attributes** (`Number of Sales`, `Inventory`, prices, descriptions).
- **Join them on `Webflow Item ID`**, which already exists as a field in the Airtable Products table.

This is the correct design and it means the indexer is the same work regardless of which search engine we pick — roughly **70% of total effort**. The engine is the swappable part.

---

## 3b. Fold mechanics (decided)

Product Variants and FAQs are **folded into their parent product document**. Neither ever appears as a standalone search result, and neither is ever linked directly.

### ⚠️ Neither collection has a parent reference in Webflow

This is the finding that dictates the implementation. I read both collection schemas:

- **`Product Variants`** fields: `price`, `sale-price`, `inventory`, `sku`, `weight`, `primary-image`, `strain`, `size`, `flavor`, `strength`, `type`, `allow-backorders`, `brand`, `parent-categories`, `name`, `slug` — **plus a block of cost/wholesale fields (see below)**. There is **no reference field pointing back to Products**.
- **`FAQs`** fields: `name` (the Question), `answer-rtf`, `answer` (plain text), `categories` → Content Categories, `display-on-faq-page`, `slug`. There is **no reference field pointing to Products** either.

The product↔variant and product↔FAQ relationships exist **only in Airtable** (`Products.Variants` and `Products.FAQs`, both `multipleRecordLinks`). So the fold **must be driven from the Airtable side** — walk outward from each product record. You cannot build it by iterating the Webflow FAQ or Variant collections, because those items don't know who their parent is.

This reinforces §3's join design: Webflow supplies the product URL, Airtable supplies both the ranking signals *and* the graph needed to fold in variants and FAQs.

### What gets folded, and how it's weighted

| Source | Fields folded into the product doc | Search weight |
|---|---|---|
| **Variants** (1,026) | `flavor`, `strain`, `strength`, `size`, `type`, `sku` | **high** — these are the differentiators customers type ("blue raspberry", "1000mg", "indica") |
| **FAQs** (1,143) | `name` (the question) | medium |
| **FAQs** | `answer` (plain text), **truncated to ~200 chars** | low |

Variant `flavor`/`strain`/`strength` is the highest-value text in this whole exercise: it makes "blue raspberry" find the right parent product, which neither native search nor the Finsweet filter can do today.

FAQ `answer-rtf` (rich text) is **not** indexed in full — that would roughly triple the payload for little relevance gain. The question carries nearly all the signal.

### Orphan handling

Not every FAQ belongs to a product. The `display-on-faq-page` switch is the discriminator:

- FAQ linked to a product via `Products.FAQs` → fold into that product.
- FAQ not linked to any product, `display-on-faq-page = true` → fold into the `/faq` static page document instead.
- FAQ linked to nothing and not on the FAQ page → **drop** (it's orphaned content).

An FAQ linked to several products gets folded into each of them.

### 🔒 Hard exclusion: cost and wholesale pricing

A client-side index is **publicly readable**, so margin data must never enter it. Both collections carry exactly the fields that would leak it:

- `Product Variants`: `base-unit-cost-tier-1/2/3`, `wholesale-cost-tier-1/2/3`, `msrp`, `units-per-case`, `number-of-cases`, `available-for-wholesale`, `distribution-product`
- Airtable `Products`: `Cost`, `Wholesale Cost (Tier 1/2/3)`, `Base Unit Cost (Tier 1/2/3)`, `MSRP`, `Lowest/Highest Wholesale Price`, `Wholesale Listings Price Display`

**Implementation rule: the indexer uses an explicit field allowlist, never a denylist.** A denylist silently leaks the next cost field someone adds to Airtable — and that table already has 174 fields and grows. Only retail-public fields are permitted: name, slug, brand, categories, retail `Price` / `Sale Price` / `Lowest`–`Highest Price`, image URL, stock flags, `Number of Sales`, descriptions, and the folded variant/FAQ text above.

Worth adding a guard to the indexer: fail the build if any output key matches `/cost|wholesale|tier|msrp|margin/i`.

---

## 4. Options

### Option A — Build on your Netlify + Airtable stack ✅ **Recommended**

Scheduled Netlify function joins Webflow CMS + Airtable → writes a lean JSON index → footer script does typo-tolerant instant search client-side (MiniSearch). Mirrors your existing `ProductSort` / `BannerScheduler` / `crossell-config` patterns.

- **Cost:** $0/mo
- **Relevance:** full control — field boosting (name > brand > category > body), fuzzy + prefix matching, `Number of Sales` popularity boost, in-stock boost, hand-tunable synonyms
- **Freshness:** 6-hourly + config webhook (§0c budget) vs. 12–72h today
- **Payload:** ~160–190KB gz, lazy-loaded → no effect on Core Web Vitals
- **Facets:** yes (brand, category, price, in-stock, effects/aromas/terpenes)
- **Analytics:** GA4 via the existing GTM container + Airtable Interface dashboard (§7)
- **Ceiling:** comfortable to ~5,000 docs client-side; we'd be at ~1,320

### Option A2 — Same, but served from your Webflow Cloud app

You already run a Webflow Cloud app (`aimtell-webflow-cloud`, Astro + Cloudflare Workers). A search route there is same-origin, edge-fast, zero client payload, with server-side query logging for free.

- **Cost:** $0/mo (existing app)
- **Tradeoff:** more moving parts + Worker cold starts, for a payload saving we don't need yet
- **Verdict:** natural upgrade path, not necessary for v1

### Option B — Pagefind (static, self-hosted)

- **Cost:** $0/mo
- **Fatal flaw:** crawl-based, so it only sees published HTML. No `Number of Sales` ranking, no stock demotion, inherits the stale prices already on the page. Throws away the entire Airtable advantage.
- **Verdict:** fine for a content site. Not for a 539-SKU store.

### Option C — Algolia (hosted)

- **Cost:** free "Build" tier is **10,000 requests/month** — the binding constraint, since instant search fires a request per debounced keystroke. Paid tiers run roughly **$0.50–$1.75 per 1,000 requests**; ~20k searches/month plausibly lands **~$30–75/mo**. *(Verify with a live quote — published figures vary by source.)*
- **Effort:** still needs the **same Webflow+Airtable indexer**
- **Real advantages:** query analytics (especially zero-result queries), merchandising UI usable without a developer, unlimited scale
- **Verdict:** Option A's effort **plus** a monthly fee. Justified for the analytics/merchandising console, not for relevance alone.

### Option D — Typesense Cloud / Meilisearch Cloud

- **Cost:** Typesense Cloud from **~$7–30/mo** (resource-based); Meilisearch Cloud from **~$30/mo**
- **Effort:** same indexer plus integration
- **Verdict:** best paid option if you'd rather not maintain search code. No relevance advantage at this catalog size.

---

## 5. Comparison

| | **A. Netlify + Airtable** | **B. Pagefind** | **C. Algolia** | **D. Typesense/Meili** |
|---|---|---|---|---|
| Monthly cost | **$0** | $0 | ~$30–75 | ~$7–30 |
| Typo tolerance | ✅ | ✅ | ✅ | ✅ |
| `Number of Sales` ranking | ✅ | ❌ | ✅ | ✅ |
| Stock-aware ranking | ✅ | ❌ | ✅ | ✅ |
| Index freshness | 6-hourly / webhook | on rebuild | near-realtime | near-realtime |
| Correct prices | ✅ | ❌ (stale) | ✅ | ✅ |
| Facets | ✅ | limited | ✅ | ✅ |
| Search analytics | ✅ GA4 + Airtable (§7) | ❌ | ✅ built-in | partial |
| Merchandising UI | ❌ (code) | ❌ | ✅ | ❌ |
| Scale ceiling | ~5k docs | high | unlimited | high |
| Reuses your patterns | ✅ | ❌ | partial | partial |

---

## 6. Recommendation

**Build Option A, structured so the engine is swappable.** The measured numbers reinforce this rather than changing it.

1. **The indexer is unavoidable work in every option** — and it's a *join* (Webflow for URLs, Airtable for signals), which no hosted engine does for you. Build it first with a pluggable output; if we later want Algolia or Typesense, we repoint the same indexer and keep the UI.
2. **Your ranking signals beat any vendor's defaults.** `Number of Sales` + live inventory is what a hosted engine spends months of click-analytics approximating. You have it today.
3. **~1,320 standalone docs is small.** Paying per-search at this scale buys scale you don't need.
4. **The two folded-in datasets are a real edge.** 1,026 variant names and 1,143 FAQ questions as searchable text against parent products means "blue raspberry" or "will this show on a drug test" can find the right product. Native search can't do this at all.
5. **It matches how the rest of the site is already built.**

**Update — this now settles the Option C question.** The merchandising console and query analytics were Algolia's last remaining advantage over Option A. You've asked to build them, and §7 shows they can be built on infrastructure you already run (GTM + Airtable Interfaces) with no new vendor. That removes the only reason I'd have recommended paying Algolia. **Option A, decisively.**


---

## 7. Dashboard: analytics + management

Yes — and the key insight is that this **shouldn't be one system**. Three layers, each in the place that's already best at it, with no new vendor and no new hosting.

### Layer 1 — GA4 via your existing GTM container (volume analytics)

`GTM-KPK8VKF` is already live on the site with `gtag` and `dataLayer`. Search analytics needs **no new infrastructure** — just push events:

| Event | Params | Why |
|---|---|---|
| `search` | `search_term`, `results_count` | GA4 has a **native site-search report**; zero-result queries are `results_count = 0` |
| `search_result_click` | `search_term`, `position`, `item_id`, `result_type` | Gives click-through rate and mean click position — the standard relevance quality metric |

The decisive advantage: your ecommerce tracking already flows through this container (`gtm-product-push.js`), so GA4 can attribute **search → add-to-cart → revenue**. That's a question Algolia's own analytics answers *worse* than your existing GA4 setup, because Algolia doesn't see your order data.

### Layer 2 — Airtable as system of record (management config)

New tables in the existing base, all editable by non-developers:

| Table | Purpose |
|---|---|
| `Search Synonyms` | term → synonyms, active switch. "weed"→THC, "edibles"→gummies, "pen"→vape |
| `Search Pins` | query → pinned URL + priority. "delta 8" → `/delta-8-gummies-edibles` |
| `Search Boosts` | product → boost or bury multiplier, for manual merchandising |
| `Search Needs Attention` | auto-populated daily: zero-result and low-CTR queries |
| `Search Index Log` | per build: timestamp, doc counts by type, items excluded, orphaned FAQs dropped, failures |

The indexer reads layers 1–3 of this table set on every build, so **editing a synonym in Airtable changes search behaviour on the next build** with no deploy. The config and the dashboard become the same artifact.

### Layer 3 — Airtable Interface Designer as the dashboard UI

Charts plus editable grids over the tables above. No code, no auth to build, no hosting, and it's a tool you already use daily. A Webflow Cloud or Netlify-hosted dashboard would need custom auth and ongoing maintenance to deliver the same thing.

### ⚠️ Do not log raw searches into Airtable — but records aren't the reason

**Correction:** I previously flagged record limits as the main trap. With real numbers that was overcautious — the base sits at **10,735 / 50,000 records**, so there's ~39k headroom and daily rollups fit comfortably.

**The actual constraint is API calls, not records** (§0c: 1,769,076 / 100,000). So the rule still holds, for a different reason: raw per-search logging would mean an Airtable write on every search, against a quota that's already 17.7× over.

**Split by volume:**

- **Raw events → GA4.** Unlimited, free, already installed via `GTM-KPK8VKF`. Zero Airtable cost.
- **Airtable gets one batched write per day:** every zero-result query plus the top ~100 by count. One request, not thousands. Add a 90-day purge to keep steady state near ~22k records.

⚠️ **Seat constraint:** paid users are at **10 / 10**. If the dashboard needs viewers who aren't already collaborators, that's either a plan change or a shared read-only interface link — worth checking what Pro allows before promising access to a wider team.

### Bonus: a report you're uniquely positioned to run

You already have back-in-stock signups and a `subscription-stock-check` Slack digest. Cross-referencing **search demand against live inventory** yields a restock-prioritisation report: *"customers searched for these out-of-stock items N times this week."* That's real buying intelligence, it fits your existing Slack-digest pattern, and no search vendor could produce it because none of them can see your inventory.

### Build order impact

Slots in as **step 5**, replacing the thinner "query logging" item: GA4 events + the Airtable config tables + the Interface. The config tables should land *with* the indexer (step 1), since the indexer reads them.

---

### Suggested build order

0. ✅ **DONE — Fixed the Airtable API overage** (§0c). `crossell-config.js` now uses Netlify Durable Cache; shipped to prod as `4743281` and verified. Awaiting 2–3 days of counter data to confirm it was the whole 1.77M.
0b. **DONE - Resolved what the top-bar box is wired to** (section 0). It GETs `/shop-all-products?*=<term>` and Finsweet filters client-side. `name="*"` is intentional; do not rename it.
0c. **DONE - Pulled the GA4 report** (section 0f). 12 months, 212,853 views, 175,871 typed queries, 22,046 distinct. Demand confirmed; synonym and pin lists now evidence-based.
0d. **Review the Finding 4 gap list** (section 0f) - `fvkd`, `elf`, `kush burst`, `graveyard`, `koi`, `sumo`, `haze`. Are these brands you carry, or stock gaps? Needs your judgement, not data.
1. **Indexer** — Netlify function on a **6-hourly** schedule (§0c budget), plus an Airtable-automation webhook for config changes. Webflow CMS (URL authority, `draft: false`) joined to Airtable on `Webflow Item ID` (ranking signals). Covers products, blog, brands, all three category levels, strains, basics, coupons, plus the ~50 static landing pages and ~35 info pages. Folds in variant names and FAQ questions. Excludes `Discontinued` / `In-Store Only` / `Distro Only` / non-published.
2. **Instant dropdown on the existing Header Searchbar component** — grouped results: Products (image, correct price, stock badge) / Brands / Categories & Landing Pages / Articles / Help. One component edit covers all 120 instances.
3. **Rescore the existing `/shop-all-products` list** (section 0e) - keep Finsweet for facets and rendering; replace its substring matching and CMS-order ranking with index-driven scoring over the already-rendered DOM nodes. Add correct pricing. Much cheaper than a new results page, and preserves a flow customers already use.
4. **Synonym + pinned-result map** - the `Search Synonyms` / `Search Pins` / `Search Boosts` tables from section 7, read by the indexer on every build. **Seed them from section 0f**: the 8 measured variant clusters (7-OH 276 spellings, vape pens 99, gummies 205, delta 8/9 ~250 each), the 80 brand misspellings, and pinned brand pages for the top brand queries. Add diacritic and whitespace folding so `tre house` matches `TRĒ House`.
5. **Dashboard** — GA4 `search` / `search_result_click` events via the existing GTM container, plus the Airtable config tables and an Airtable Interface over them. See §7.

### Open questions

- ~~Which Webflow site plan?~~ **Resolved: Enterprise Lite.** Reindex timing isn't publicly documented for Enterprise; ask your rep. Doesn't change the design.
- ~~Is there a search box in the nav today?~~ **Resolved: yes** — the Header Searchbar component (120 instances).
- ~~Which input does the top bar actually use?~~ **Resolved: `#search-bar` GETs `/shop-all-products?*=<term>`, and Finsweet prefilters from that param.** `name="*"` is intentional - renaming it would break search on 120 pages. See section 0.
- **Does the GA4 property strip query parameters?** Decides whether historical search terms are already recoverable (section 0d) or whether we need to instrument and wait.
- ~~Does `/search` still get traffic?~~ **Resolved: no — 1 pageview in the last month, likely internal testing.** See §0d. Removes the URL-preservation constraint entirely.
- ~~Should FAQs be standalone results?~~ **Decided: no — fold into parent products.** No standalone FAQ hits, no separate "Help" group. See §3b.
- ~~Product Variants as standalone results?~~ **Decided: no — fold into parent products,** never linked directly. See §3b.
- ~~Should search cover wholesale products?~~ **Resolved: moot.** The `Wholesale Products` collection has **0 items** on this site — wholesale lives on the separate Distro site (greendragondistribution.com, site ID `6781b33b9cffc0281c28d38d`), which is out of scope.
- ~~Include `Cost` / wholesale pricing fields?~~ **Decided: no — hard exclusion.** Enforced as a field allowlist, not a denylist. See §3b.
