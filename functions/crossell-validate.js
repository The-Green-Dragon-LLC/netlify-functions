/**
 * crossell-validate.js  —  Netlify Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Foxy pre-payment webhook.  Runs before any card is charged and enforces two
 * rules for CROSSELL_PROMO items:
 *
 *   1. PRICE CHECK  — each promo item's price must be >= the expected 40%-off
 *      price for its product code.  Rejects if someone lowered the price via
 *      URL manipulation.
 *
 *   2. QUANTITY LIMIT — no more than PROMO_LIMIT units may be in the cart at
 *      the promotional price.  Client-side code (crossell-popup.js) converts
 *      overflow to full-price line items, but this webhook is the authoritative
 *      backstop in case someone bypasses the front end.
 *
 * DEPLOYMENT
 * ──────────
 *  1. Copy this file to your Netlify project:
 *       netlify/functions/crossell-validate.js
 *
 *  2. Deploy (git push or Netlify CLI).
 *
 *  3. Add the URL in Foxy Admin → Store → Advanced → Pre-payment webhook:
 *       https://YOUR-SITE.netlify.app/.netlify/functions/crossell-validate
 *
 *  4. In Netlify → Site Settings → Environment Variables add:
 *       FOXY_WEBHOOK_KEY  →  your key from Foxy Admin → Store → Advanced → Webhook key
 *
 * KEEPING IN SYNC WITH crossell-popup.js
 * ──────────────────────────────────────
 *   • PROMO_LIMIT must match the PROMO_LIMIT value in crossell-popup.js
 *   • PROMO_PRICES keys must match the product codes in CROSSELL_PRODUCTS
 *   • PROMO_PRICES values must equal Math.round(regularPrice * 60) / 100
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');

/* ─── CONFIGURATION ─────────────────────────────────────────────────────── */

/** Must match PROMO_CATEGORY in crossell-popup.js */
const PROMO_CATEGORY = 'CROSSELL_PROMO';

/** Must match PROMO_LIMIT in crossell-popup.js */
const PROMO_LIMIT = 3;

/**
 * Expected discounted price for each promo product code.
 * Formula: Math.round(regularPrice * 60) / 100   (= 40% off)
 *
 * Keep in sync with CROSSELL_PRODUCTS in crossell-popup.js.
 *
 * Parent codes (fallback for non-variant add-to-cart):
 *   recKkoAfqQsG0egdL  Ferris Wheel - Kanna Extract Tablets   $19.99 → $11.99
 *   rechUKdlBzIOr1MLn  Mmelt - Hippie Flip Mushroom Gummies   $34.99 → $20.99
 *
 * Ferris Wheel variant codes (all $19.99 → $11.99):
 *   rechSEXDGj34FT77U  Blue Razz
 *   recNTLM2EMmGSfU13  Juicy Apple
 *   recDT1utJwnorlyY8  Pink Stardust
 *   recGU7TQeCYXziEa9  Citrus Twist
 *
 * Mmelt variant codes (all $34.99 → $20.99):
 *   recOicdAKLK67435n  Cosmic Peach
 *   recmkGpGL9FRg99kS  Daydream Bliss
 *   recVvHfnTDHfTbypU  Ego Melter
 *   recoBtUNdqINTmHHh  Rainbow Drip
 *   rec7VoOk2wogWYc1v  Stargaze Grape
 *   recvcqWPwO6zWw2Oi  Trippy Tropic
 */
const PROMO_PRICES = {
  // Ferris Wheel - Kanna Extract Tablets  (regular $19.99 → 40% off = $11.99)
  'recKkoAfqQsG0egdL': 11.99,  // parent
  'rechSEXDGj34FT77U': 11.99,  // Blue Razz
  'recNTLM2EMmGSfU13': 11.99,  // Juicy Apple
  'recDT1utJwnorlyY8': 11.99,  // Pink Stardust
  'recGU7TQeCYXziEa9': 11.99,  // Citrus Twist

  // Mmelt - Hippie Flip Mushroom Gummies - 10 count  (regular $34.99 → 40% off = $20.99)
  'rechUKdlBzIOr1MLn': 20.99,  // parent
  'recOicdAKLK67435n': 20.99,  // Cosmic Peach
  'recmkGpGL9FRg99kS': 20.99,  // Daydream Bliss
  'recVvHfnTDHfTbypU': 20.99,  // Ego Melter
  'recoBtUNdqINTmHHh': 20.99,  // Rainbow Drip
  'rec7VoOk2wogWYc1v': 20.99,  // Stargaze Grape
  'recvcqWPwO6zWw2Oi': 20.99   // Trippy Tropic
};

/** Floating-point tolerance: reject anything more than 1 cent below expected. */
const PRICE_TOLERANCE = 0.01;

/* ─── SIGNATURE VERIFICATION ────────────────────────────────────────────── */

function verifySignature(rawBody, signature) {
  const key = process.env.FOXY_WEBHOOK_KEY;
  if (!key) {
    console.warn('[crossell-validate] FOXY_WEBHOOK_KEY not set — skipping signature check');
    return true;
  }
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.toLowerCase(), 'hex'),
      Buffer.from(expected.toLowerCase(), 'hex')
    );
  } catch (_) {
    return false;
  }
}

/* ─── HANDLER ────────────────────────────────────────────────────────────── */

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawBody   = event.body || '';
  const signature = event.headers['foxy-webhook-signature']
                 || event.headers['foxycart-hmac-signature']
                 || '';

  // 1. Verify request is genuinely from Foxy
  if (!verifySignature(rawBody, signature)) {
    console.error('[crossell-validate] Signature mismatch');
    return respond(false, 'Request could not be verified.');
  }

  // 2. Parse payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return respond(false, 'Invalid request format.');
  }

  // 3. Extract cart items
  //    FoxyCart 2.0 HAL+JSON: payload._embedded['fx:items']
  const items = (
    payload._embedded &&
    (payload._embedded['fx:items'] || payload._embedded['fx:line_items'])
  ) || [];

  // 4. Find all CROSSELL_PROMO items and validate them
  const promoItems = items.filter(item => {
    const cat =
      item.category ||
      (item._embedded &&
       item._embedded['fx:item_category'] &&
       item._embedded['fx:item_category'].code) ||
      '';
    return cat.toUpperCase() === PROMO_CATEGORY.toUpperCase();
  });

  // ── Rule 1: Price check ──────────────────────────────────────────────────
  for (const item of promoItems) {
    const code           = item.code || item.product_code || '';
    const submittedPrice = parseFloat(item.price || 0);
    const expectedPrice  = PROMO_PRICES[code];

    if (expectedPrice === undefined) {
      console.warn('[crossell-validate] Unknown promo code:', code);
      return respond(false,
        `Promotional product "${code}" is not recognized.  ` +
        `Please contact support or remove the item and try again.`
      );
    }

    if (submittedPrice < expectedPrice - PRICE_TOLERANCE) {
      console.warn(
        `[crossell-validate] Price tampered for ${code}: ` +
        `expected >= ${expectedPrice}, got ${submittedPrice}`
      );
      return respond(false,
        `The promotional price for "${item.name || code}" could not be validated.  ` +
        `Please remove the item and add it again from the offer, or contact support.`
      );
    }
  }

  // ── Rule 2: Quantity limit ───────────────────────────────────────────────
  const totalPromoQty = promoItems.reduce((sum, item) => sum + (item.quantity || 0), 0);

  if (totalPromoQty > PROMO_LIMIT) {
    console.warn(
      `[crossell-validate] Promo qty exceeded: ${totalPromoQty} > ${PROMO_LIMIT}`
    );
    return respond(false,
      `The promotional price is limited to ${PROMO_LIMIT} units per order.  ` +
      `Please reduce the quantity of the promotional item in your cart and try again.`
    );
  }

  // All checks passed
  return respond(true);
};

/* ─── RESPONSE HELPER ────────────────────────────────────────────────────── */

function respond(ok, details) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      ok
        ? { ok: true }
        : { ok: false, details: details || 'This order could not be processed.' }
    )
  };
}
