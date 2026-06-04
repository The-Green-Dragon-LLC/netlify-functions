/**
 * crossell-config.js  —  Netlify Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns the live cross-sell configuration from Airtable:
 *
 *   categories — names of all Parent Categories whose Primary Category is
 *                "THC" (used to decide when the popup fires)
 *
 *   products   — products with the "Cross-sell Promo" checkbox checked
 *                (the items shown in the popup at 40% off)
 *
 * Called by crossell-popup.js on cart page load.  Response is cached in the
 * browser's sessionStorage so Airtable is only hit once per session.
 *
 * URL: https://YOUR-SITE.netlify.app/.netlify/functions/crossell-config
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const Airtable = require('airtable');

const BASE_ID                  = 'appWUsGD3byrYcN3l';
const PARENT_CATEGORIES_TABLE  = 'tbltqhRcmg8d8zHWE';
const PRODUCTS_TABLE           = 'tblkLl9qqg654fWi7';
const PRODUCT_PAGE_BASE_URL    = 'https://www.thegreendragoncbd.com/products/';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  // Handle CORS preflight
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
        // Cache at the CDN edge for 5 minutes; browser re-validates after 1 min
        'Cache-Control': 'public, max-age=60, s-maxage=300',
      },
      body: JSON.stringify({ categories, products }),
    };
  } catch (err) {
    console.error('[crossell-config] Airtable error:', err.message || err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load cross-sell config' }),
    };
  }
};

/**
 * Returns the Name of every Parent Category whose Primary Category
 * links to the "THC" record — these are the Foxy product category codes
 * that should trigger the cross-sell popup.
 */
async function fetchTHCCategories(base) {
  const names = [];
  await base(PARENT_CATEGORIES_TABLE)
    .select({
      fields:          ['Name'],
      filterByFormula: `{Primary Categories} = "THC"`,
    })
    .eachPage((records, fetchNextPage) => {
      records.forEach((r) => {
        const name = r.get('Name');
        if (name) names.push(name);
      });
      fetchNextPage();
    });
  return names;
}

/**
 * Returns products that have the "Cross-sell Promo" checkbox checked.
 * The 40%-off sale price is calculated client-side from regularPrice.
 */
async function fetchCrossSellProducts(base) {
  const products = [];
  await base(PRODUCTS_TABLE)
    .select({
      fields: [
        'Name',
        'Website Product Code',
        'Price',
        'Primary Image Webflow URL',
        'Slug',
      ],
      filterByFormula: `{Cross-sell Promo} = TRUE()`,
    })
    .eachPage((records, fetchNextPage) => {
      records.forEach((r) => {
        const code  = r.get('Website Product Code');
        const price = r.get('Price');
        const slug  = r.get('Slug');
        if (!code || !price) return; // skip records missing required fields

        products.push({
          name:         r.get('Name') || '',
          code:         code,
          regularPrice: price,
          image:        r.get('Primary Image Webflow URL') || '',
          url:          slug ? PRODUCT_PAGE_BASE_URL + slug : '',
        });
      });
      fetchNextPage();
    });
  return products;
}
