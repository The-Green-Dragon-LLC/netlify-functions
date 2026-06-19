/**
 * crossell-config.js  —  Netlify Function
 * Returns live cross-sell config from Airtable.
 *
 * Response shape:
 * {
 *   categoryCrossSells: [
 *     {
 *       primaryCategory: "THC",
 *       parentCategories: ["Delta 8", "THCa", ...],   // Foxy category codes that trigger this
 *       products: [{ name, code, regularPrice, image, url, variantsLabel, variants }],
 *       discountPct: 40,    // integer, e.g. 40 = 40% off  (null = use popup default)
 *       maxQty: 3,          // max units at discount price  (null = use popup default)
 *     }
 *   ],
 *   genericCrossSells: [    // shown when no category cross-sell matches
 *     {
 *       products: [...],
 *       discountPct: 25,
 *       maxQty: 2,
 *     }
 *   ]
 * }
 */
'use strict';

const Airtable = require('airtable');

const BASE_ID                   = 'appWUsGD3byrYcN3l';
const PRIMARY_CATEGORIES_TABLE  = 'tbliSkVUbug2MYAW7';
const PARENT_CATEGORIES_TABLE   = 'tbltqhRcmg8d8zHWE';
const CROSSELLS_TABLE           = 'tblwkNLyvaTJaGgpD'; // Cross-Sells (generic)
const PRODUCTS_TABLE            = 'tblkLl9qqg654fWi7';
const VARIANTS_TABLE            = 'tblEtb1aIH5Xk4Nh9';
const PRODUCT_PAGE_BASE_URL     = 'https://www.thegreendragoncbd.com/products/';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(BASE_ID);

  try {
    const [categoryCrossSells, genericCrossSells] = await Promise.all([
      fetchCategoryCrossSells(base),
      fetchGenericCrossSells(base),
    ]);
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ categoryCrossSells, genericCrossSells }),
    };
  } catch (err) {
    console.error('[crossell-config]', err.message || err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load config' }),
    };
  }
};

/* ─────────────────────────────────────────────────────────────────────────
   CATEGORY CROSS-SELLS
   Fetches Primary Categories that have a Cross-sell Product linked,
   then resolves their Parent Categories (Foxy category codes), product
   details, variants, discount %, and max qty.
───────────────────────────────────────────────────────────────────────── */

async function fetchCategoryCrossSells(base) {
  // Step 1 — Primary Categories that have at least one linked cross-sell product
  const primaryCatRecords = [];
  await base(PRIMARY_CATEGORIES_TABLE)
    .select({
      fields: ['Name', 'Cross-sell Product', 'Cross-sell Discount', 'Cross-sell Max Qty'],
      filterByFormula: 'COUNTA({Cross-sell Product}) > 0',
    })
    .eachPage((records, next) => { records.forEach(r => primaryCatRecords.push(r)); next(); });

  if (!primaryCatRecords.length) return [];

  // Normalise each primary category record, collecting product IDs along the way.
  // Airtable "percent" fields return decimal fractions — 0.4 means 40%.
  const allProductIds = [];
  const primaryCatData = primaryCatRecords.map(r => {
    const productIds  = r.get('Cross-sell Product') || [];
    const rawDiscount = r.get('Cross-sell Discount'); // null | 0.0–1.0
    allProductIds.push(...productIds);
    return {
      id:          r.id,
      name:        r.get('Name') || '',
      productIds,
      discountPct: rawDiscount != null ? Math.round(rawDiscount * 100) : null,
      maxQty:      r.get('Cross-sell Max Qty') || null,
    };
  });

  // Step 2 — For each Primary Category, look up which Parent Categories belong to it.
  // Parent Categories use a "Primary Categories" linked-record field whose primary
  // field is the Primary Category name, so `{Primary Categories} = "<name>"` works.
  const parentCatsByPrimary = {};
  await Promise.all(primaryCatData.map(async pc => {
    parentCatsByPrimary[pc.id] = [];
    await base(PARENT_CATEGORIES_TABLE)
      .select({
        fields:         ['Name'],
        filterByFormula: `{Primary Categories} = "${pc.name}"`,
      })
      .eachPage((records, next) => {
        records.forEach(r => { if (r.get('Name')) parentCatsByPrimary[pc.id].push(r.get('Name')); });
        next();
      });
  }));

  // Step 3 — Batch-fetch all products (and their variants)
  const productMap = await buildProductMap(base, [...new Set(allProductIds)]);

  // Step 4 — Assemble final result
  return primaryCatData
    .map(pc => {
      const products = pc.productIds
        .map(id => productMap[id])
        .filter(p => p && p.code);

      if (!products.length) return null;

      // Always include the primary category name itself so products whose
      // Foxy category code IS the primary name (e.g. "CBD") still match,
      // even if no Parent Category sub-records link to this primary category.
      const parentCats = parentCatsByPrimary[pc.id] || [];
      const allParentCats = parentCats.includes(pc.name)
        ? parentCats
        : [pc.name, ...parentCats];

      return {
        primaryCategory:  pc.name,
        parentCategories: allParentCats,
        products,
        discountPct:      pc.discountPct,  // integer or null
        maxQty:           pc.maxQty,        // integer or null
      };
    })
    .filter(Boolean);
}

/* ─────────────────────────────────────────────────────────────────────────
   GENERIC CROSS-SELLS
   Fetches active rows from the Cross-Sells table, sorted by Priority.
   These are shown when no category cross-sell matches the cart contents.
   The "Select" field carries the trigger type (e.g. "Any item") for future
   filtering; all active rows are returned here and the popup handles priority.
───────────────────────────────────────────────────────────────────────── */

async function fetchGenericCrossSells(base) {
  const rows = [];
  await base(CROSSELLS_TABLE)
    .select({
      fields:          ['Name', 'Active', 'Product', 'Discount', 'Max Qty', 'Select', 'Priority'],
      filterByFormula: '{Active} = TRUE()',
      sort:            [{ field: 'Priority', direction: 'asc' }],
    })
    .eachPage((records, next) => { records.forEach(r => rows.push(r)); next(); });

  if (!rows.length) return [];

  // Collect all product IDs referenced across active rows
  const allProductIds = rows.reduce((acc, r) => acc.concat(r.get('Product') || []), []);
  const productMap    = await buildProductMap(base, [...new Set(allProductIds)]);

  return rows
    .map(r => {
      const productIds  = r.get('Product') || [];
      const rawDiscount = r.get('Discount'); // percent field: 0.4 = 40%
      const products    = productIds.map(id => productMap[id]).filter(p => p && p.code);

      if (!products.length) return null;

      return {
        name:        r.get('Name')     || '',
        trigger:     r.get('Select')   || 'Any item', // trigger type for future use
        products,
        discountPct: rawDiscount != null ? Math.round(rawDiscount * 100) : null,
        maxQty:      r.get('Max Qty')  || null,
      };
    })
    .filter(Boolean);
}

/* ─────────────────────────────────────────────────────────────────────────
   SHARED PRODUCT HELPER
   Fetches Products + Variants by Airtable record ID and returns a map.
───────────────────────────────────────────────────────────────────────── */

async function buildProductMap(base, productIds) {
  if (!productIds.length) return {};

  // Fetch products
  const formula = productIds.length === 1
    ? `RECORD_ID() = "${productIds[0]}"`
    : `OR(${productIds.map(id => `RECORD_ID() = "${id}"`).join(',')})`;

  const productRecords = [];
  await base(PRODUCTS_TABLE)
    .select({
      fields:          ['Name', 'Website Product Code', 'Price', 'Primary Image Webflow URL', 'Slug', 'Variants', 'Variants Label'],
      filterByFormula: formula,
    })
    .eachPage((records, next) => { records.forEach(r => productRecords.push(r)); next(); });

  // Batch-fetch all variants
  const allVariantIds = productRecords.reduce((acc, r) => acc.concat(r.get('Variants') || []), []);
  const variantMap    = {};

  if (allVariantIds.length > 0) {
    const varFormula = allVariantIds.length === 1
      ? `RECORD_ID() = "${allVariantIds[0]}"`
      : `OR(${allVariantIds.map(id => `RECORD_ID() = "${id}"`).join(',')})`;

    await base(VARIANTS_TABLE)
      .select({
        fields:          ['Name', 'Website Product Code', 'Price', 'Primary Image Webflow URL', 'Variant Label'],
        filterByFormula: varFormula,
      })
      .eachPage((records, next) => {
        records.forEach(r => {
          variantMap[r.id] = {
            name:  r.get('Name')                      || '',
            code:  r.get('Website Product Code')      || '',
            price: r.get('Price')                     || 0,
            image: r.get('Primary Image Webflow URL') || '',
            label: r.get('Variant Label')             || '',
          };
        });
        next();
      });
  }

  // Assemble product map keyed by Airtable record ID
  const productMap = {};
  for (const r of productRecords) {
    if (!r.get('Website Product Code')) continue; // skip products without a Foxy code

    const parentName    = r.get('Name')           || '';
    const variantIds    = r.get('Variants')        || [];
    const variantsLabel = r.get('Variants Label')  || '';
    const variants      = variantIds.map(id => variantMap[id]).filter(v => v && v.code);

    // Prefer parent price; fall back to lowest variant price
    const parentPrice        = r.get('Price') || 0;
    const lowestVariantPrice = variants.length
      ? Math.min(...variants.map(v => v.price).filter(p => p > 0))
      : 0;
    const regularPrice = parentPrice || lowestVariantPrice;

    // Derive short display names for variants by stripping the parent name prefix
    // e.g. "Ferris Wheel… - Blue Razz" → "Blue Razz"
    const variantsWithDisplay = variants.map(v => {
      let displayName = v.name;
      if (displayName.startsWith(parentName)) {
        displayName = displayName.slice(parentName.length).replace(/^[\s\-]+/, '').trim();
      }
      return Object.assign({}, v, { displayName });
    });

    const slug = r.get('Slug');
    productMap[r.id] = {
      name:          parentName,
      code:          r.get('Website Product Code'),
      regularPrice,
      image:         r.get('Primary Image Webflow URL') || '',
      url:           slug ? PRODUCT_PAGE_BASE_URL + slug : '',
      // Use the parent product's Variants Label only — not the individual variant's
      // Variant Label — so the cart shows e.g. "Flavor: Blue Razz" not "Blue Razz: Blue Razz".
      variantsLabel: variantsLabel || '',
      variants:      variantsWithDisplay,
    };
  }

  return productMap;
}
