/**
 * crossell-config.js  —  Netlify Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns live cross-sell configuration from Airtable:
 *
 *   categories — Parent Category names whose Primary Category is "THC"
 *   products   — Products with "Cross-sell Promo" checked, including variants
 *
 * Product shape:
 * {
 *   name, code, regularPrice, image, url,
 *   variantsLabel: "Flavor",          // option name for cart URL
 *   variants: [                        // empty array = no variants
 *     { name: "Watermelon Pucker", code: "recXXX", image: "https://..." }
 *   ]
 * }
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const Airtable = require('airtable');

const BASE_ID               = 'appWUsGD3byrYcN3l';
const PARENT_CATEGORIES_TABLE = 'tbltqhRcmg8d8zHWE';
const PRODUCTS_TABLE        = 'tblkLl9qqg654fWi7';
const VARIANTS_TABLE        = 'tblEtb1aIH5Xk4Nh9';
const PRODUCT_PAGE_BASE_URL = 'https://www.thegreendragoncbd.com/products/';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(BASE_ID);

  try {
    const [categories, products] = await Promise.all([
      fetchTHCCategories(base),
      fetchCrossSellProducts(base),
    ]);

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
      },
      body: JSON.stringify({ categories, products }),
    };
  } catch (err) {
    console.error('[crossell-config] Error:', err.message || err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load cross-sell config' }),
    };
  }
};

/* ─── THC categories ──────────────────────────────────────────────────────── */

async function fetchTHCCategories(base) {
  const names = [];
  await base(PARENT_CATEGORIES_TABLE)
    .select({ fields: ['Name'], filterByFormula: `{Primary Categories} = "THC"` })
    .eachPage((records, next) => { records.forEach(r => { if (r.get('Name')) names.push(r.get('Name')); }); next(); });
  return names;
}

/* ─── Cross-sell products + variants ─────────────────────────────────────── */

async function fetchCrossSellProducts(base) {
  // Step 1 — collect all cross-sell product records
  const productRecords = [];
  await base(PRODUCTS_TABLE)
    .select({
      fields: [
        'Name',
        'Website Product Code',
        'Price',
        'Primary Image Webflow URL',
        'Slug',
        'Variants',          // linked record IDs of variants
        'Variants Label',    // option name, e.g. "Flavor"
      ],
      filterByFormula: `{Cross-sell Promo} = TRUE()`,
    })
    .eachPage((records, next) => { records.forEach(r => productRecords.push(r)); next(); });

  if (!productRecords.length) return [];

  // Step 2 — collect all variant record IDs across every product
  const allVariantIds = productRecords.reduce((acc, r) => {
    const ids = r.get('Variants') || [];
    return acc.concat(ids);
  }, []);

  // Step 3 — batch-fetch all variants in one Airtable call
  const variantMap = {}; // recordId → { name, code, image, label }
  if (allVariantIds.length > 0) {
    const formula = allVariantIds.length === 1
      ? `RECORD_ID() = "${allVariantIds[0]}"`
      : `OR(${allVariantIds.map(id => `RECORD_ID() = "${id}"`).join(',')})`;

    await base(VARIANTS_TABLE)
      .select({
        fields: [
          'Name',                      // display value, e.g. "Watermelon Pucker"
          'Website Product Code',      // variant's Foxy code
          'Primary Image Webflow URL', // variant-specific image (may be empty)
          'Variant Label',             // option type, e.g. "Flavor"
        ],
        filterByFormula: formula,
      })
      .eachPage((records, next) => {
        records.forEach(r => {
          variantMap[r.id] = {
            name:  r.get('Name')                      || '',
            code:  r.get('Website Product Code')      || '',
            image: r.get('Primary Image Webflow URL') || '',
            label: r.get('Variant Label')             || '',
          };
        });
        next();
      });
  }

  // Step 4 — assemble final product objects
  return productRecords
    .filter(r => r.get('Website Product Code') && r.get('Price'))
    .map(r => {
      const variantIds    = r.get('Variants') || [];
      const variantsLabel = r.get('Variants Label') || '';
      const variants      = variantIds
        .map(id => variantMap[id])
        .filter(v => v && v.code); // drop any that have no Foxy code

      const slug = r.get('Slug');
      return {
        name:          r.get('Name') || '',
        code:          r.get('Website Product Code'),
        regularPrice:  r.get('Price'),
        image:         r.get('Primary Image Webflow URL') || '',
        url:           slug ? PRODUCT_PAGE_BASE_URL + slug : '',
        variantsLabel: variantsLabel || (variants[0] && variants[0].label) || '',
        variants:      variants,
      };
    });
}
