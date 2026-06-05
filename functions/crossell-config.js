/**
 * crossell-config.js  —  Netlify Function
 * Returns live cross-sell config from Airtable:
 *   categories — THC Parent Category names (to trigger the popup)
 *   products   — Products with "Cross-sell Promo" checked, with variants + prices
 *
 * Product shape:
 * {
 *   name, code, regularPrice,   // regularPrice = lowest variant price (or parent price)
 *   image, url, variantsLabel,
 *   variants: [{ name, code, image, price }]  // empty = no variants
 * }
 */
'use strict';

const Airtable = require('airtable');

const BASE_ID                  = 'appWUsGD3byrYcN3l';
const PARENT_CATEGORIES_TABLE  = 'tbltqhRcmg8d8zHWE';
const PRODUCTS_TABLE           = 'tblkLl9qqg654fWi7';
const VARIANTS_TABLE           = 'tblEtb1aIH5Xk4Nh9';
const PRODUCT_PAGE_BASE_URL    = 'https://www.thegreendragoncbd.com/products/';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(BASE_ID);

  try {
    const [categories, products] = await Promise.all([
      fetchTHCCategories(base),
      fetchCrossSellProducts(base),
    ]);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, s-maxage=300' },
      body: JSON.stringify({ categories, products }),
    };
  } catch (err) {
    console.error('[crossell-config]', err.message || err);
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to load config' }) };
  }
};

async function fetchTHCCategories(base) {
  const names = [];
  await base(PARENT_CATEGORIES_TABLE)
    .select({ fields: ['Name'], filterByFormula: `{Primary Categories} = "THC"` })
    .eachPage((records, next) => { records.forEach(r => { if (r.get('Name')) names.push(r.get('Name')); }); next(); });
  return names;
}

async function fetchCrossSellProducts(base) {
  // Step 1 — collect cross-sell product records
  const productRecords = [];
  await base(PRODUCTS_TABLE)
    .select({
      fields: ['Name', 'Website Product Code', 'Price', 'Primary Image Webflow URL', 'Slug', 'Variants', 'Variants Label'],
      filterByFormula: '{Cross-sell Promo}',
    })
    .eachPage((records, next) => { records.forEach(r => productRecords.push(r)); next(); });

  if (!productRecords.length) return [];

  // Step 2 — collect all variant IDs
  const allVariantIds = productRecords.reduce((acc, r) => acc.concat(r.get('Variants') || []), []);

  // Step 3 — batch-fetch all variants (including Price)
  const variantMap = {};
  if (allVariantIds.length > 0) {
    const formula = allVariantIds.length === 1
      ? `RECORD_ID() = "${allVariantIds[0]}"`
      : `OR(${allVariantIds.map(id => `RECORD_ID() = "${id}"`).join(',')})`;

    await base(VARIANTS_TABLE)
      .select({
        fields: ['Name', 'Website Product Code', 'Price', 'Primary Image Webflow URL', 'Variant Label'],
        filterByFormula: formula,
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

  // Step 4 — assemble products
  return productRecords
    .filter(r => r.get('Website Product Code')) // only require a Foxy code
    .map(r => {
      const variantIds    = r.get('Variants') || [];
      const variantsLabel = r.get('Variants Label') || '';
      const variants      = variantIds.map(id => variantMap[id]).filter(v => v && v.code);

      // Use parent price if set, otherwise use lowest variant price
      const parentPrice = r.get('Price') || 0;
      const lowestVariantPrice = variants.length
        ? Math.min(...variants.map(v => v.price).filter(p => p > 0))
        : 0;
      const regularPrice = parentPrice || lowestVariantPrice;

      const parentName = r.get('Name') || '';
      const slug       = r.get('Slug');

      // For each variant, derive a short display name by stripping the
      // parent product name prefix (e.g. "Ferris Wheel…-   Blue Razz" → "Blue Razz")
      const variantsWithDisplay = variants.map(v => {
        let displayName = v.name;
        if (displayName.startsWith(parentName)) {
          displayName = displayName.slice(parentName.length).replace(/^[\s\-]+/, '').trim();
        }
        return Object.assign({}, v, { displayName });
      });

      return {
        name:          parentName,
        code:          r.get('Website Product Code'),
        regularPrice:  regularPrice,
        image:         r.get('Primary Image Webflow URL') || '',
        url:           slug ? PRODUCT_PAGE_BASE_URL + slug : '',
        variantsLabel: variantsLabel || (variants[0] && variants[0].label) || '',
        variants:      variantsWithDisplay,
      };
    });
}
