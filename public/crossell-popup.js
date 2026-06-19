/**
 * crossell-popup.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Green Dragon CBD — Cross-Sell Popup
 *
 * • Shows a one-time-per-session popup when a triggering item is added to cart.
 * • Trigger and offer are driven by Airtable via the crossell-config endpoint:
 *     – Category cross-sells: per Primary Category popup (e.g. THC → specific product)
 *     – Generic cross-sells:  shown as an in-cart widget (never in the popup)
 * • Discount % and max promo qty are configurable per cross-sell in Airtable.
 * • Units over the promo limit are added at full price automatically.
 * • Price tampering is blocked server-side by the pre-payment webhook
 *   (crossell-validate.js) before any card is ever charged.
 *
 * ─── SETUP CHECKLIST ──────────────────────────────────────────────────────────
 *
 *  1. In Foxy Admin → Products → Categories, create:
 *       Code: CROSSELL_PROMO   Name: Cross-sell Promo
 *
 *  2. For every coupon in Foxy Admin → Advanced → Product Category Restrictions:
 *     whitelist only the categories the coupon should apply to, leaving
 *     CROSSELL_PROMO off the list.
 *
 *  3. Deploy crossell-validate.js as a Netlify function and register its URL
 *     in Foxy Admin → Store → Advanced → Pre-payment webhook URL.
 *
 *  4. In Webflow Site Settings → Custom Code → Footer Code, paste this file's
 *     contents wrapped in <script>…</script>.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════════
     1.  CONFIGURATION — update these values
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * URL of the Netlify function that returns live config from Airtable.
   * Auto-derived from this script's own src so the correct function is called
   * on both the develop deploy and production — no manual URL updates needed.
   */
  var CONFIG_URL = (function () {
    try {
      var s = document.currentScript;
      if (!s) {
        // Fallback for browsers without currentScript support
        var all = document.getElementsByTagName('script');
        s = all[all.length - 1];
      }
      if (s && s.src) {
        // Strip the script filename to get the deploy base URL, e.g.
        // "https://develop--wondrous-bublanina-d440ec.netlify.app"
        var base = s.src.replace(/\/[^\/]*$/, '');
        return base + '/.netlify/functions/crossell-config';
      }
    } catch (e) { /* ignore */ }
    // Hard-coded fallback if src detection fails
    return 'https://wondrous-bublanina-d440ec.netlify.app/.netlify/functions/crossell-config';
  })();

  /** sessionStorage key for caching the Airtable config (one fetch per session). */
  var CONFIG_CACHE_KEY = 'tgd_crossell_config';

  /**
   * Foxy product-category code for cross-sell promo items.
   * Keep in sync with crossell-validate.js.
   */
  var PROMO_CATEGORY = 'CROSSELL_PROMO';

  /**
   * Default discount percentage (40% off) and promo limit used when
   * the Airtable config does not specify values for a cross-sell.
   */
  var DEFAULT_DISCOUNT_PCT = 40;
  var DEFAULT_MAX_QTY      = 3;

  /**
   * Runtime promo limit — updated to activeConfig.maxQty when the popup fires.
   * All cart enforcement logic reads this variable so the limit is always in sync.
   */
  var PROMO_LIMIT = DEFAULT_MAX_QTY;

  /** Fallback Foxy store domain (auto-detected from FC.json when available). */
  var STORE_DOMAIN = 'thegreendragoncbd.foxycart.com';

  /**
   * sessionStorage key prefix — popup shows once per primary category per session.
   * e.g. tgd_crossell_shown_thc, tgd_crossell_shown_cbd
   */
  var SESSION_KEY_PREFIX = 'tgd_crossell_shown_';

  /**
   * Fallback THC categories — used only when the Airtable config fetch fails
   * AND the categoryCrossSells array is empty.
   */
  var THC_CATEGORIES_FALLBACK = [
    'Vape Kits', 'Delta 8', 'Delta 9', 'THCa', 'Delta 10',
    'Delta 11 (HXY-11)', 'Delta 6', 'Live Resin', 'THCP', 'THC-V', 'THCh', 'THCjd'
  ];

  /**
   * Fallback cross-sell products — used only when the Airtable config fetch
   * fails AND the categoryCrossSells array is empty.
   */
  var CROSSELL_PRODUCTS_FALLBACK = [
    {
      name:         'Ferris Wheel - Kanna Extract Tablets',
      code:         'recKkoAfqQsG0egdL',
      regularPrice: 19.99,
      image:        'https://cdn.prod.website-files.com/62829462cb406845143ba31e/6a0490a564b912e53be28dc5_FerrisWheel-ezgif.com-resize.webp',
      url:          'https://www.thegreendragoncbd.com/products/ferris-wheel-kanna-party-blend-tablets'
    },
    {
      name:         'Mmelt - Hippie Flip Mushroom Gummies - 10 count',
      code:         'rechUKdlBzIOr1MLn',
      regularPrice: 34.99,
      image:        'https://cdn.prod.website-files.com/62829462cb406845143ba31e/6a0cd593b0d30d35c6d61c77_HippyFlipGummies-ezgif.com-resize.webp',
      url:          'https://www.thegreendragoncbd.com/product/mmelt-hippie-flip-mushroom-gummies'
    }
  ];

  /* ══════════════════════════════════════════════════════════════════════════
     2.  LIVE CONFIG STATE
         Populated by loadConfig() once per session.
     ══════════════════════════════════════════════════════════════════════════ */

  /** Array of category cross-sell configs fetched from Airtable. */
  var CATEGORYCROSSSELLS = [];

  /** Array of generic cross-sell configs fetched from Airtable. */
  var GENERICCROSSSELLS  = [];

  /**
   * The category cross-sell config most recently shown as a popup.
   * Set when showPopup() is called; read by cart enforcement helpers for
   * promo-limit tracking on popup-originated promo items.
   *
   * Shape: { primaryCategory, parentCategories, products, discountPct, maxQty }
   */
  var ACTIVE_CONFIG = null;

  /* ══════════════════════════════════════════════════════════════════════════
     3.  HELPERS
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Apply discountPct to a regular price and return a formatted string like "23.99".
   * Rounds to the nearest cent.
   */
  function salePrice(regular, discountPct) {
    var off     = (discountPct != null) ? discountPct : DEFAULT_DISCOUNT_PCT;
    var payFrac = (100 - off) / 100;
    return (Math.round(regular * payFrac * 100) / 100).toFixed(2);
  }

  /**
   * The discount % to apply right now (from ACTIVE_CONFIG, or default).
   * Used by cart handlers after the popup has fired.
   */
  function activeDiscountPct() {
    return (ACTIVE_CONFIG && ACTIVE_CONFIG.discountPct != null)
      ? ACTIVE_CONFIG.discountPct
      : DEFAULT_DISCOUNT_PCT;
  }

  /**
   * The products relevant to the current session's active cross-sell.
   * Falls back to CROSSELL_PRODUCTS_FALLBACK if no config loaded.
   */
  function activeProducts() {
    return (ACTIVE_CONFIG && ACTIVE_CONFIG.products && ACTIVE_CONFIG.products.length)
      ? ACTIVE_CONFIG.products
      : CROSSELL_PRODUCTS_FALLBACK;
  }

  /**
   * Look up a product config by its Foxy product code, searching
   * parent codes and variant codes so variant cart items are found.
   * Returns the parent product object in both cases.
   */
  function getProductByCode(code) {
    var prods = activeProducts();
    for (var i = 0; i < prods.length; i++) {
      if (prods[i].code === code) return prods[i];
      var vars = prods[i].variants || [];
      for (var j = 0; j < vars.length; j++) {
        if (vars[j].code === code) return prods[i];
      }
    }
    return null;
  }

  /**
   * Given a cart item code (may be a variant code), return the matching
   * variant object or null.
   */
  function getVariantByCode(code) {
    var prods = activeProducts();
    for (var i = 0; i < prods.length; i++) {
      var vars = prods[i].variants || [];
      for (var j = 0; j < vars.length; j++) {
        if (vars[j].code === code) return vars[j];
      }
    }
    return null;
  }

  /** Returns true if a cart item was added as a cross-sell promo item. */
  function isPromoItem(item) {
    // Primary: check for the hidden marker option (reliable regardless of Foxy category)
    var opts = item.options || [];
    for (var i = 0; i < opts.length; i++) {
      var n = (opts[i].name || '').toLowerCase().replace(/^h:/, '');
      if (n === 'crossell_promo' && opts[i].value === 'true') return true;
    }
    // Fallback: category check
    return (item.category || '').toUpperCase() === PROMO_CATEGORY.toUpperCase();
  }

  /** Sum of quantities for all cross-sell promo items currently in the cart. */
  function getPromoQty() {
    var items = window.FC && FC.json && FC.json.items;
    if (!items) return 0;
    var total   = 0;
    var asArray = Array.isArray(items) ? items : Object.keys(items).map(function (k) { return items[k]; });
    for (var i = 0; i < asArray.length; i++) {
      if (isPromoItem(asArray[i])) total += (asArray[i].quantity || 0);
    }
    return total;
  }

  /** Sum of promo-category quantities for a specific Foxy product code. */
  function getPromoQtyForProduct(code) {
    var items = window.FC && FC.json && FC.json.items;
    if (!items) return 0;
    var asArray = Array.isArray(items) ? items : Object.keys(items).map(function (k) { return items[k]; });
    var total   = 0;
    for (var i = 0; i < asArray.length; i++) {
      if (isPromoItem(asArray[i]) && asArray[i].code === code) {
        total += (asArray[i].quantity || 0);
      }
    }
    return total;
  }

  /** Find a cart item from FC.json by its Foxy item ID. */
  function getCartItemByFcId(fcItemId) {
    var items = window.FC && FC.json && FC.json.items;
    if (!items) return null;
    for (var key in items) {
      if (Object.prototype.hasOwnProperty.call(items, key)) {
        if (String(items[key].id) === String(fcItemId)) return items[key];
      }
    }
    return null;
  }

  /**
   * Count all non-promo items in the cart (used for change-detection polling).
   */
  function countNonPromoItems() {
    var items = window.FC && FC.json && FC.json.items;
    if (!items) return 0;
    var total   = 0;
    var asArray = Array.isArray(items) ? items : Object.keys(items).map(function (k) { return items[k]; });
    for (var i = 0; i < asArray.length; i++) {
      if (!isPromoItem(asArray[i])) total += (asArray[i].quantity || 1);
    }
    return total;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     4.  CROSS-SELL MATCHING
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Normalise an option name for loose comparison — removes spaces, underscores,
   * hyphens and lowercases so variant spellings all compare equal.
   */
  function normaliseOptionName(s) {
    return (s || '').toLowerCase().replace(/[\s_\-]/g, '');
  }

  /**
   * Normalise a Foxy category code or Airtable category name for comparison.
   * Strips ALL non-alphanumeric characters so that:
   *   "CBD Topicals" === "cbd-topicals"
   *   "CBD Oils / Tinctures" === "cbd-oils-tinctures"
   *   "Full Spectrum CBD" === "full-spectrum-cbd"
   */
  function normaliseCategory(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Returns true if the cart item has the hidden Foxy option
   * "Restricted Shipping Code" set to "thc".
   */
  function itemHasTHCOption(item) {
    var options = item.options || [];
    for (var i = 0; i < options.length; i++) {
      if (normaliseOptionName(options[i].name) === 'restrictedshippingcode' &&
          (options[i].value || '').toLowerCase() === 'thc') {
        return true;
      }
    }
    return false;
  }

  /** Returns true if the given Foxy category code is in the fallback THC list. */
  function isTHCCategoryFallback(category) {
    var cat = (category || '').toLowerCase();
    for (var i = 0; i < THC_CATEGORIES_FALLBACK.length; i++) {
      if (THC_CATEGORIES_FALLBACK[i].toLowerCase() === cat) return true;
    }
    return false;
  }

  /**
   * Scan the cart and return the first matching CATEGORY cross-sell config.
   * Generic cross-sells are handled separately via the in-cart widget (renderCartCrossSell).
   *
   *   1. Category cross-sells — matched by Foxy category code or THC shipping option
   *   2. Hardcoded fallback   — used when config fetch failed (legacy behaviour)
   *
   * Returns a config object or null.
   */
  function findActiveCrossSell() {
    var items = window.FC && FC.json && FC.json.items;
    if (!items) return null;

    var asArray  = Array.isArray(items) ? items : Object.keys(items).map(function (k) { return items[k]; });
    var nonPromo = asArray.filter(function (it) { return !isPromoItem(it); });

    // 1. Category cross-sells (popup only)
    for (var c = 0; c < CATEGORYCROSSSELLS.length; c++) {
      var cs          = CATEGORYCROSSSELLS[c];
      if (!cs.products || !cs.products.length) continue;

      var normParents = (cs.parentCategories || []).map(normaliseCategory);
      var isPrimTHC   = cs.primaryCategory && cs.primaryCategory.toLowerCase() === 'thc';

      for (var i = 0; i < nonPromo.length; i++) {
        var item    = nonPromo[i];
        var normCat = normaliseCategory(item.category);
        if (normParents.indexOf(normCat) !== -1) return cs;
        if (isPrimTHC && itemHasTHCOption(item)) return cs;
      }
    }

    // 2. Hardcoded fallback (no Airtable config loaded, legacy THC detection)
    if (!CATEGORYCROSSSELLS.length && CROSSELL_PRODUCTS_FALLBACK.length) {
      for (var f = 0; f < nonPromo.length; f++) {
        if (itemHasTHCOption(nonPromo[f]) || isTHCCategoryFallback(nonPromo[f].category)) {
          return {
            products:    CROSSELL_PRODUCTS_FALLBACK,
            discountPct: DEFAULT_DISCOUNT_PCT,
            maxQty:      DEFAULT_MAX_QTY,
          };
        }
      }
    }

    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     5.  CART — ADD TO CART
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Add an item to the Foxy cart without page navigation.
   *
   * @param {Array} [customOptions]  e.g. [{name:'Flavor', value:'Watermelon Pucker'}]
   */
  function addToCart(name, price, code, category, qty, image, url, customOptions) {
    var json     = window.FC && FC.json;
    var domain   = (json && json.config && json.config.store_domain) || STORE_DOMAIN;
    var sessName = (json && json.session_name) || '';
    var sessId   = (json && json.session_id)   || '';

    var cartUrl = 'https://' + domain + '/cart'
      + '?name='     + encodeURIComponent(name)
      + '&price='    + Number(price).toFixed(2)
      + '&code='     + encodeURIComponent(code)
      + '&category=' + encodeURIComponent(category)
      + '&quantity=' + qty
      + (image ? '&image=' + encodeURIComponent(image) : '')
      + (url   ? '&url='   + encodeURIComponent(url)   : '')
      + (customOptions ? customOptions.map(function (o) {
          return '&' + encodeURIComponent(o.name) + '=' + encodeURIComponent(o.value);
        }).join('') : '')
      // Hidden marker travels with the item for reliable detection in getPromoQty()
      + (category === PROMO_CATEGORY ? '&h:crossell_promo=true' : '');

    if (sessName && sessId) {
      cartUrl += '&' + encodeURIComponent(sessName) + '=' + encodeURIComponent(sessId);
    }

    console.log('[crossell] cart URL:', cartUrl);

    // On the Foxy cart/checkout domain use direct navigation
    var onFoxyDomain = window.location.hostname === 'secure.thegreendragoncbd.com' ||
                       window.location.hostname.indexOf('foxycart') !== -1 ||
                       window.location.hostname.indexOf('foxy.io')  !== -1;

    if (onFoxyDomain) {
      var dest = cartUrl;
      if (window.location.pathname.indexOf('/checkout') === 0) dest += '&cart=checkout';
      window.location.href = dest;
    } else {
      var link = document.createElement('a');
      link.style.position = 'absolute';
      link.style.top      = '-9999px';
      link.style.left     = '-9999px';
      link.href = cartUrl;
      document.body.appendChild(link);
      link.click();
      setTimeout(function () { document.body.removeChild(link); }, 200);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     6.  PROMO LIMIT DISCLAIMER
     ══════════════════════════════════════════════════════════════════════════ */

  function updatePromoDisclaimer() {
    setTimeout(function () {
      var old = document.querySelectorAll('.cs-promo-limit-notice');
      for (var i = 0; i < old.length; i++) {
        if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
      }

      var items = window.FC && FC.json && FC.json.items;
      if (!items) return;

      var asArray    = Array.isArray(items) ? items : Object.keys(items).map(function (k) { return items[k]; });
      var promoItems = asArray.filter(isPromoItem);
      if (!promoItems.length) return;

      var totalPromoQty = promoItems.reduce(function (sum, it) { return sum + (it.quantity || 0); }, 0);

      var hasOverflow = asArray.some(function (it) {
        if (isPromoItem(it)) return false;
        return promoItems.some(function (p) { return p.code === it.code; });
      });

      if (!hasOverflow && totalPromoQty <= PROMO_LIMIT) return;

      var msg = '⚠️  The promotional price is limited to '
              + PROMO_LIMIT + ' units. '
              + 'Additional units have been added to your cart at the regular price.';

      promoItems.forEach(function (it) {
        var el = document.querySelector('[data-fc-item-id="' + it.id + '"]');
        if (!el) return;
        el.insertAdjacentHTML('afterend',
          '<div class="cs-promo-limit-notice" style="'
          + 'font-size:11px;line-height:1.4;color:#7a3c00;'
          + 'background:#fff8f0;border:1px solid #f5cba0;border-radius:5px;'
          + 'padding:5px 10px;margin:2px 0 8px;font-family:Lato,sans-serif;'
          + '">' + msg + '</div>'
        );
      });
    }, 300);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     7.  CART QUANTITY LIMIT ENFORCEMENT
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Watches the Foxy quantity input for direct edits. Caps promo items at
   * PROMO_LIMIT and adds overflow at full price.
   */
  function attachQuantityInputWatcher() {
    document.addEventListener('change', function (e) {
      var input = e.target;
      if (!input || !input.getAttribute) return;
      if (input.getAttribute('data-fc-id') !== 'item-quantity-input') return;

      var fcItemId = input.getAttribute('data-fc-item-id');
      if (!fcItemId) return;

      var cartItem = getCartItemByFcId(fcItemId);
      if (!cartItem || !isPromoItem(cartItem)) return;

      var newQty = parseInt(input.value, 10);
      if (isNaN(newQty) || newQty <= 0) return;

      var otherPromoQty = getPromoQty() - (cartItem.quantity || 0);
      var maxAllowed    = Math.max(1, PROMO_LIMIT - otherPromoQty);
      if (newQty <= maxAllowed) return;

      var overflowQty = newQty - maxAllowed;
      input.value     = maxAllowed; // cap before Foxy reads it

      var product      = getProductByCode(cartItem.code);
      var variant      = getVariantByCode(cartItem.code);
      if (!product) return;

      var overflowPrice = (variant && variant.price) ? variant.price : product.regularPrice;
      var overflowImage = (variant && variant.image) ? variant.image : product.image;
      var overflowOpts  = (cartItem.options || []).filter(function (o) {
        var n = normaliseOptionName(o.name);
        return n !== 'restrictedshopping' && n !== 'restrictedshippingcode' &&
               n !== 'airtablerecordid'   && n !== 'heavydrink' && n !== 'crossellpromo';
      });

      addToCart(
        cartItem.name, overflowPrice, cartItem.code, 'DEFAULT',
        overflowQty, overflowImage, product.url,
        overflowOpts.length ? overflowOpts : undefined
      );
    }, true);
  }

  /**
   * Intercepts the "+" button on promo cart items once the limit is reached,
   * adding one unit at full price instead.
   */
  function attachCartPlusInterceptor() {
    document.addEventListener('click', function (e) {
      var target = e.target;
      var addBtn = (target.classList && target.classList.contains('add-item-sign'))
        ? target
        : (target.closest ? target.closest('.add-item-sign') : null);
      if (!addBtn) return;

      var itemContainer = addBtn.closest ? addBtn.closest('[data-fc-item-id]') : null;
      if (!itemContainer) return;

      var fcItemId = itemContainer.getAttribute('data-fc-item-id');
      var cartItem = getCartItemByFcId(fcItemId);
      if (!cartItem) return;
      if (!isPromoItem(cartItem)) return;
      if (getPromoQty() < PROMO_LIMIT) return; // still under limit — let Foxy handle it

      e.stopPropagation();
      e.preventDefault();

      var product = getProductByCode(cartItem.code);
      if (product) {
        var variant       = getVariantByCode(cartItem.code);
        var overflowPrice = (variant && variant.price) ? variant.price : product.regularPrice;
        var overflowImage = (variant && variant.image) ? variant.image : product.image;
        var overflowOpts  = (cartItem.options || []).filter(function (o) {
          var n = normaliseOptionName(o.name);
          return n !== 'restrictedshopping' &&
                 n !== 'restrictedshippingcode' &&
                 n !== 'airtablerecordid' &&
                 n !== 'heavydrink' &&
                 n !== 'crossellpromo';
        });

        addToCart(
          cartItem.name, overflowPrice, cartItem.code, 'DEFAULT',
          1, overflowImage, product.url,
          overflowOpts.length ? overflowOpts : undefined
        );
      }
    }, true);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     8.  STYLES
     ══════════════════════════════════════════════════════════════════════════ */

  var STYLES = [
    '#tgd-crossell{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;font-family:Lato,sans-serif;}',
    '#tgd-crossell .cs-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.65);}',
    '#tgd-crossell .cs-box{position:relative;background:#fff;border-radius:14px;padding:30px 26px 24px;max-width:660px;width:100%;max-height:90vh;overflow-y:auto;z-index:1;box-shadow:0 20px 60px rgba(0,0,0,.35);}',
    '#tgd-crossell .cs-close{position:absolute;top:12px;right:16px;background:none;border:none;font-size:28px;line-height:1;cursor:pointer;color:#888;padding:0;}',
    '#tgd-crossell .cs-close:hover{color:#333;}',
    '#tgd-crossell .cs-eyebrow{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#e07b00;margin:0 0 6px;}',
    '#tgd-crossell .cs-title{font-size:22px;font-weight:800;color:#207348;margin:0 0 10px;line-height:1.2;font-family:Poppins,Lato,sans-serif;}',
    '#tgd-crossell .cs-subtitle{font-size:14px;color:#555;margin:0 0 22px;line-height:1.55;}',
    '#tgd-crossell .cs-subtitle strong{color:#207348;}',
    '#tgd-crossell .cs-note{font-size:12px;color:#e07b00;margin:0 0 18px;font-style:italic;}',
    '#tgd-crossell .cs-products{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:18px;}',
    '#tgd-crossell .cs-product{flex:1 1 calc(50% - 7px);min-width:220px;border:1px solid #e4e4e4;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;transition:box-shadow .15s;}',
    '#tgd-crossell .cs-product:hover{box-shadow:0 4px 16px rgba(0,0,0,.12);}',
    '#tgd-crossell .cs-product img{width:100%;height:220px;object-fit:contain;background:#f7f7f7;display:block;}',
    '#tgd-crossell .cs-product-info{padding:12px 14px 14px;flex:1;display:flex;flex-direction:column;}',
    '#tgd-crossell .cs-product-name{font-size:13px;font-weight:600;color:#222;margin:0 0 10px;flex:1;line-height:1.4;}',
    '#tgd-crossell .cs-prices{display:flex;align-items:center;gap:8px;margin-bottom:12px;}',
    '#tgd-crossell .cs-price-orig{font-size:12px;color:#bbb;text-decoration:line-through;}',
    '#tgd-crossell .cs-price-sale{font-size:18px;font-weight:800;color:#207348;}',
    '#tgd-crossell .cs-badge{font-size:11px;font-weight:700;background:#e07b00;color:#fff;border-radius:4px;padding:2px 7px;white-space:nowrap;}',
    '#tgd-crossell .cs-add-btn{display:block;text-align:center;padding:10px 14px;background:linear-gradient(142deg,#48d88d,#2fa264);color:#fff!important;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none!important;cursor:pointer;border:none;transition:opacity .15s;}',
    '#tgd-crossell .cs-add-btn:hover{opacity:.88;}',
    '#tgd-crossell .cs-add-btn:disabled{opacity:.4;cursor:not-allowed;pointer-events:none;}',
    '#tgd-crossell .cs-variant-select{width:100%;padding:8px 10px;border:1px solid #d0d0d0;border-radius:6px;font-size:13px;font-family:Lato,sans-serif;color:#333;background:#fff;margin-bottom:10px;cursor:pointer;-webkit-appearance:auto;appearance:auto;}',
    '#tgd-crossell .cs-variant-select:focus{outline:2px solid #37b772;border-color:#37b772;}',
    '#tgd-crossell .cs-disclaimer{font-size:11px;color:#999;text-align:center;margin:0 0 10px;font-style:italic;}',
    '#tgd-crossell .cs-decline{display:block;width:100%;background:none;border:none;color:#bbb;font-size:12px;text-decoration:underline;cursor:pointer;padding:2px 0 0;text-align:center;font-family:Lato,sans-serif;}',
    '#tgd-crossell .cs-decline:hover{color:#888;}',
    '@media(max-width:479px){#tgd-crossell .cs-product{flex:1 1 100%;}#tgd-crossell .cs-box{padding:22px 14px 18px;}#tgd-crossell .cs-title{font-size:18px;}}'
  ].join('');

  /** Styles for the in-cart generic cross-sell widget (#tgd-cart-crossell). */
  var CART_STYLES = [
    '#tgd-cart-crossell{padding:14px 16px;background:#f0fbf5;border-top:2px solid #d4eddf;font-family:Lato,sans-serif;}',
    '#tgd-cart-crossell .cs-cart-eyebrow{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#207348;margin:0 0 10px;}',
    '#tgd-cart-crossell .cs-cart-products{display:flex;flex-direction:column;gap:10px;}',
    '#tgd-cart-crossell .cs-cart-product{display:flex;gap:10px;align-items:flex-start;}',
    '#tgd-cart-crossell .cs-cart-img{width:68px;height:68px;object-fit:contain;background:#fff;border-radius:6px;flex-shrink:0;border:1px solid #e0e0e0;}',
    '#tgd-cart-crossell .cs-cart-details{flex:1;min-width:0;}',
    '#tgd-cart-crossell .cs-cart-name{font-size:12px;font-weight:600;color:#222;margin:0 0 5px;line-height:1.4;}',
    '#tgd-cart-crossell .cs-cart-prices{display:flex;align-items:center;gap:5px;margin-bottom:7px;flex-wrap:wrap;}',
    '#tgd-cart-crossell .cs-cart-price-orig{font-size:11px;color:#bbb;text-decoration:line-through;}',
    '#tgd-cart-crossell .cs-cart-price-sale{font-size:14px;font-weight:800;color:#207348;}',
    '#tgd-cart-crossell .cs-cart-badge{font-size:10px;font-weight:700;background:#e07b00;color:#fff;border-radius:4px;padding:2px 5px;white-space:nowrap;}',
    '#tgd-cart-crossell .cs-cart-variant-select{width:100%;padding:5px 8px;border:1px solid #d0d0d0;border-radius:5px;font-size:12px;font-family:Lato,sans-serif;color:#333;background:#fff;margin-bottom:7px;cursor:pointer;-webkit-appearance:auto;appearance:auto;}',
    '#tgd-cart-crossell .cs-cart-qty-wrap{display:flex;align-items:center;gap:5px;margin-bottom:8px;}',
    '#tgd-cart-crossell .cs-cart-qty-btn{width:26px;height:26px;border:1px solid #c8c8c8;border-radius:4px;background:#fff;color:#333;font-size:15px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;}',
    '#tgd-cart-crossell .cs-cart-qty-btn:hover{background:#f0f0f0;}',
    '#tgd-cart-crossell .cs-cart-qty-input{width:34px;text-align:center;border:1px solid #c8c8c8;border-radius:4px;font-size:13px;padding:3px 0;color:#333;font-family:Lato,sans-serif;-moz-appearance:textfield;}',
    '#tgd-cart-crossell .cs-cart-qty-input::-webkit-outer-spin-button,#tgd-cart-crossell .cs-cart-qty-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}',
    '#tgd-cart-crossell .cs-cart-add-btn{display:block;width:100%;text-align:center;padding:7px 10px;background:linear-gradient(142deg,#48d88d,#2fa264);color:#fff!important;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;border:none;transition:opacity .15s;}',
    '#tgd-cart-crossell .cs-cart-add-btn:hover{opacity:.88;}',
    '#tgd-cart-crossell .cs-cart-add-btn:disabled{opacity:.4;cursor:not-allowed;pointer-events:none;}',
  ].join('');

  /* ══════════════════════════════════════════════════════════════════════════
     9.  POPUP HTML
     ══════════════════════════════════════════════════════════════════════════ */

  function productCardHTML(p, discountPct) {
    var sale      = salePrice(p.regularPrice, discountPct);
    var hasVars   = p.variants && p.variants.length > 0;
    var varLabel  = p.variantsLabel || 'Option';

    var variantSelect = '';
    if (hasVars) {
      variantSelect = '<select class="cs-variant-select" data-product-code="' + p.code + '">'
        + '<option value="" selected disabled>Select</option>'
        + p.variants.map(function (v) {
            var vPrice   = v.price || p.regularPrice;
            var vSale    = salePrice(vPrice, discountPct);
            var vOrig    = Number(vPrice).toFixed(2);
            var dispName = v.displayName || v.name;
            var fullName = v.name;
            return '<option value="' + v.code + '"'
              + ' data-displayname="' + dispName.replace(/"/g, '&quot;') + '"'
              + ' data-fullname="'    + fullName.replace(/"/g, '&quot;') + '"'
              + ' data-image="'       + (v.image || '').replace(/"/g, '&quot;') + '"'
              + ' data-price="'       + vPrice + '"'
              + ' data-sale="'        + vSale  + '"'
              + ' data-orig="'        + vOrig  + '">'
              + dispName + '</option>';
          }).join('')
        + '</select>';
    }

    return '<div class="cs-product">'
      + '<img src="' + p.image + '" alt="' + p.name + '" loading="lazy" class="cs-product-img"/>'
      + '<div class="cs-product-info">'
      + '<p class="cs-product-name">' + p.name + '</p>'
      + '<div class="cs-prices">'
      + '<span class="cs-price-orig">$' + Number(p.regularPrice).toFixed(2) + '</span>'
      + '<span class="cs-price-sale">$' + sale + '</span>'
      + '<span class="cs-badge">' + discountPct + '% OFF</span>'
      + '</div>'
      + variantSelect
      + '<button class="cs-add-btn" data-product-code="' + p.code + '"'
      + (hasVars ? ' disabled' : '') + '>Add to Cart</button>'
      + '</div></div>';
  }

  function popupHTML(cs) {
    var discountPct = (cs.discountPct != null) ? cs.discountPct : DEFAULT_DISCOUNT_PCT;
    var maxQty      = cs.maxQty || DEFAULT_MAX_QTY;

    return '<div id="tgd-crossell" role="dialog" aria-modal="true" aria-labelledby="cs-title" style="display:none;">'
      + '<div class="cs-backdrop"></div>'
      + '<div class="cs-box">'
      + '<button class="cs-close" aria-label="Close offer">&times;</button>'
      + '<p class="cs-eyebrow">&#127905; Exclusive One-Time Offer</p>'
      + '<h2 id="cs-title" class="cs-title">Special Limited Time Offer &mdash; ' + discountPct + '% Off!</h2>'
      + '<p class="cs-subtitle">This special price is available <strong>today only</strong> and won\'t appear anywhere else on our site. Limited to ' + maxQty + ' units per customer at the discounted price.</p>'
      + '<div class="cs-products">' + cs.products.map(function (p) { return productCardHTML(p, discountPct); }).join('') + '</div>'
      + '<p class="cs-disclaimer">This discount cannot be combined with other offers or coupon codes.</p>'
      + '<button class="cs-decline">No thanks, I\'ll skip this offer</button>'
      + '</div></div>';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     10. IN-CART GENERIC CROSS-SELL
         Injected after .fc-cart__items on every cart render event.
         Generic cross-sells from Airtable appear here; they never show
         in the popup (popup is category cross-sells only).
     ══════════════════════════════════════════════════════════════════════════ */

  /** Build the inner HTML for the in-cart cross-sell widget. */
  function cartCrossSellHTML(cs) {
    var discountPct = (cs.discountPct != null) ? cs.discountPct : DEFAULT_DISCOUNT_PCT;
    var maxQty      = cs.maxQty || DEFAULT_MAX_QTY;

    // Pick one product at random so the widget stays compact and varies across sessions
    var randomProduct = cs.products[Math.floor(Math.random() * cs.products.length)];
    var productsHTML  = [randomProduct].map(function (p) {
      var sale    = salePrice(p.regularPrice, discountPct);
      var hasVars = p.variants && p.variants.length > 0;

      var variantSelect = '';
      if (hasVars) {
        variantSelect = '<select class="cs-cart-variant-select" data-product-code="' + p.code + '">'
          + '<option value="" selected disabled>Select ' + (p.variantsLabel || 'option') + '&hellip;</option>'
          + p.variants.map(function (v) {
              var vPrice   = v.price || p.regularPrice;
              var vSale    = salePrice(vPrice, discountPct);
              var vOrig    = Number(vPrice).toFixed(2);
              var dispName = v.displayName || v.name;
              return '<option value="' + v.code + '"'
                + ' data-displayname="' + dispName.replace(/"/g, '&quot;') + '"'
                + ' data-fullname="'    + (v.name || '').replace(/"/g, '&quot;') + '"'
                + ' data-image="'       + (v.image || '').replace(/"/g, '&quot;') + '"'
                + ' data-price="'       + vPrice + '"'
                + ' data-sale="'        + vSale  + '"'
                + ' data-orig="'        + vOrig  + '">'
                + dispName + '</option>';
            }).join('')
          + '</select>';
      }

      var qtyWrap = '<div class="cs-cart-qty-wrap">'
        + '<button class="cs-cart-qty-btn" data-action="minus" data-product-code="' + p.code + '">&#8722;</button>'
        + '<input class="cs-cart-qty-input" type="number" min="1" max="' + maxQty + '" value="1"'
        + ' data-product-code="' + p.code + '" readonly/>'
        + '<button class="cs-cart-qty-btn" data-action="plus" data-product-code="' + p.code + '">+</button>'
        + '</div>';

      return '<div class="cs-cart-product">'
        + '<img src="' + p.image + '" alt="' + p.name + '" class="cs-cart-img" loading="lazy"/>'
        + '<div class="cs-cart-details">'
        + '<p class="cs-cart-name">' + p.name + '</p>'
        + '<div class="cs-cart-prices">'
        + '<span class="cs-cart-price-orig">$' + Number(p.regularPrice).toFixed(2) + '</span>'
        + '<span class="cs-cart-price-sale">$' + sale + '</span>'
        + '<span class="cs-cart-badge">' + discountPct + '% OFF</span>'
        + '</div>'
        + variantSelect
        + qtyWrap
        + '<button class="cs-cart-add-btn" data-product-code="' + p.code + '"'
        + (hasVars ? ' disabled' : '') + '>Add to Cart</button>'
        + '</div></div>';
    }).join('');

    return '<p class="cs-cart-eyebrow">&#10024; You might also like &mdash; ' + discountPct + '% off today!</p>'
      + '<div class="cs-cart-products">' + productsHTML + '</div>';
  }

  /**
   * Handle "Add to Cart" inside the in-cart widget.
   * Adds at promo price while under the generic cross-sell maxQty limit;
   * any units beyond the limit are added at full price in a second cart call.
   */
  function handleCartCrossSellAdd(productCode, cs, qty) {
    qty = (qty && qty > 0) ? Math.floor(qty) : 1;
    // Find the parent product (productCode may be a variant code)
    var product = null;
    for (var i = 0; i < cs.products.length; i++) {
      if (cs.products[i].code === productCode) { product = cs.products[i]; break; }
      var vars = cs.products[i].variants || [];
      for (var j = 0; j < vars.length; j++) {
        if (vars[j].code === productCode) { product = cs.products[i]; break; }
      }
      if (product) break;
    }
    if (!product) return;

    var discountPct = (cs.discountPct != null) ? cs.discountPct : DEFAULT_DISCOUNT_PCT;
    var maxQty      = cs.maxQty || DEFAULT_MAX_QTY;

    var useCode = productCode;
    var useName = product.name;
    var usePrice = product.regularPrice;
    var useImage = product.image;
    var customOpts = [];

    // Resolve variant selection
    if (product.variants && product.variants.length > 0) {
      var sel = document.querySelector('.cs-cart-variant-select[data-product-code="' + productCode + '"]');
      if (!sel || !sel.value) return; // require variant selection
      var opt          = sel.options[sel.selectedIndex];
      useCode          = sel.value;
      var varFullName  = opt.getAttribute('data-fullname')    || opt.text;
      var varDispName  = opt.getAttribute('data-displayname') || varFullName;
      var varImg       = opt.getAttribute('data-image')       || '';
      var varPrice     = parseFloat(opt.getAttribute('data-price') || '0');
      if (varImg)       useImage = varImg;
      if (varPrice > 0) usePrice = varPrice;
      if (varFullName)  useName  = varFullName;
      if (product.variantsLabel && varDispName) {
        customOpts.push({ name: product.variantsLabel, value: varDispName });
      }
    }

    // Split qty across promo and full-price buckets
    var alreadyPromo = getPromoQtyForProduct(useCode);
    var promoSpace   = Math.max(0, maxQty - alreadyPromo);
    var promoQty     = Math.min(qty, promoSpace);
    var overflowQty  = qty - promoQty;
    var opts         = customOpts.length ? customOpts : undefined;

    if (promoQty > 0) {
      addToCart(useName, salePrice(usePrice, discountPct), useCode, PROMO_CATEGORY,
                promoQty, useImage, product.url, opts);
      if (maxQty > PROMO_LIMIT) PROMO_LIMIT = maxQty;
    }
    if (overflowQty > 0) {
      addToCart(useName, Number(usePrice).toFixed(2), useCode, 'DEFAULT',
                overflowQty, useImage, product.url, opts);
    }
  }

  /**
   * Inject (or refresh) the in-cart generic cross-sell widget.
   * Called on every FC cart-render event so it survives Foxy's full re-renders.
   */
  function renderCartCrossSell() {
    setTimeout(function () {
      console.log('[crossell] renderCartCrossSell — GENERICCROSSSELLS:', GENERICCROSSSELLS.length,
        '| .fc-cart__items found:', !!document.querySelector('.fc-cart__items'));

      // Remove any stale injection
      var existing = document.getElementById('tgd-cart-crossell');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

      if (!GENERICCROSSSELLS.length) {
        console.log('[crossell] renderCartCrossSell — no generic cross-sells configured');
        return;
      }
      // Randomly pick from all active generic cross-sell rows so different
      // products surface across cart renders and sessions.
      var cs = GENERICCROSSSELLS[Math.floor(Math.random() * GENERICCROSSSELLS.length)];
      if (!cs || !cs.products || !cs.products.length) return;

      // Locate the items container — behaviour differs by cart type:
      //   Sidecart   → .fc-cart__items  (inject AFTER: widget appears between items and totals sidebar)
      //   Full-page  → .cart-item-blocks (inject INSIDE/append: widget appears below items in the left column)
      var itemsList  = document.querySelector('.fc-cart__items');
      var appendInside = false;
      if (!itemsList) {
        itemsList    = document.querySelector('.cart-item-blocks');
        appendInside = true; // full-page is two-column flex; append inside keeps widget in left column
      }
      if (!itemsList || !itemsList.parentNode) {
        console.log('[crossell] renderCartCrossSell — cart items container not found in DOM');
        return;
      }

      // Inject styles once per page load
      if (!document.getElementById('tgd-cart-crossell-styles')) {
        var s = document.createElement('style');
        s.id  = 'tgd-cart-crossell-styles';
        s.textContent = CART_STYLES;
        document.head.appendChild(s);
      }

      var div       = document.createElement('div');
      div.id        = 'tgd-cart-crossell';
      div.innerHTML = cartCrossSellHTML(cs);
      if (appendInside) {
        itemsList.appendChild(div);                                    // full-page: bottom of items column
      } else {
        itemsList.parentNode.insertBefore(div, itemsList.nextSibling); // sidecart: after items container
      }
      console.log('[crossell] renderCartCrossSell — widget injected for:', cs.name || cs.products[0].name);

      // Stepper +/− and Add to Cart button
      div.addEventListener('click', function (e) {
        // Quantity stepper
        var qtyBtn = e.target.closest ? e.target.closest('.cs-cart-qty-btn') : null;
        if (qtyBtn) {
          var code   = qtyBtn.getAttribute('data-product-code');
          var input  = div.querySelector('.cs-cart-qty-input[data-product-code="' + code + '"]');
          if (!input) return;
          var val    = parseInt(input.value, 10) || 1;
          var maxVal = parseInt(input.getAttribute('max'), 10) || DEFAULT_MAX_QTY;
          if (qtyBtn.getAttribute('data-action') === 'minus') val = Math.max(1, val - 1);
          if (qtyBtn.getAttribute('data-action') === 'plus')  val = Math.min(maxVal, val + 1);
          input.value = val;
          return;
        }

        // Add to Cart button — read quantity from the stepper
        var btn = e.target.closest ? e.target.closest('.cs-cart-add-btn') : null;
        if (!btn || btn.disabled) return;
        var code     = btn.getAttribute('data-product-code');
        var qtyInput = div.querySelector('.cs-cart-qty-input[data-product-code="' + code + '"]');
        var qty      = qtyInput ? (parseInt(qtyInput.value, 10) || 1) : 1;
        handleCartCrossSellAdd(code, cs, qty);
      });

      // Variant select — enable button and update displayed prices/image
      div.addEventListener('change', function (e) {
        var sel = e.target.closest ? e.target.closest('.cs-cart-variant-select') : null;
        if (!sel) return;
        var card = sel.closest ? sel.closest('.cs-cart-product') : sel.parentNode;
        if (!card) return;
        var btn = card.querySelector('.cs-cart-add-btn');
        if (btn) btn.disabled = !sel.value;
        if (sel.value) {
          var opt   = sel.options[sel.selectedIndex];
          var oOrig = card.querySelector('.cs-cart-price-orig');
          var oSale = card.querySelector('.cs-cart-price-sale');
          var oImg  = card.querySelector('.cs-cart-img');
          if (oOrig) oOrig.textContent = '$' + opt.getAttribute('data-orig');
          if (oSale) oSale.textContent = '$' + opt.getAttribute('data-sale');
          if (oImg  && opt.getAttribute('data-image')) oImg.src = opt.getAttribute('data-image');
        }
      });
    }, 300);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     11. POPUP — SHOW / CLOSE
     ══════════════════════════════════════════════════════════════════════════ */

  /** Returns the per-category sessionStorage key for the given cross-sell config. */
  function shownKeyFor(cs) {
    var cat = (cs && cs.primaryCategory)
      ? cs.primaryCategory.toLowerCase().replace(/\s+/g, '_')
      : 'generic';
    return SESSION_KEY_PREFIX + cat;
  }

  function alreadyShownFor(cs) {
    try { return !!sessionStorage.getItem(shownKeyFor(cs)); } catch (e) { return false; }
  }

  function markShownFor(cs) {
    try { sessionStorage.setItem(shownKeyFor(cs), '1'); } catch (e) { /* ignore */ }
  }

  function closePopup() {
    var el = document.getElementById('tgd-crossell');
    if (el) el.style.display = 'none';
  }

  /**
   * Handle "Add to Cart" clicks inside the popup.
   * Respects PROMO_LIMIT: adds at promo price while space remains,
   * then at full price (1 unit per click).
   */
  function handlePromoAddClick(productCode) {
    console.log('[crossell] add clicked — code:', productCode, '| ACTIVE_CONFIG:', ACTIVE_CONFIG ? ACTIVE_CONFIG.primaryCategory || 'generic' : 'null');
    var product = getProductByCode(productCode);
    console.log('[crossell] product lookup:', product ? product.name : 'NOT FOUND');
    if (!product) return;

    var useName    = product.name;
    var useCode    = product.code;
    var useImage   = product.image;
    var usePrice   = product.regularPrice;
    var customOpts = [];

    if (product.variants && product.variants.length > 0) {
      var select = document.querySelector(
        '.cs-variant-select[data-product-code="' + productCode + '"]'
      );
      if (!select || !select.value) return;

      var selectedOpt     = select.options[select.selectedIndex];
      useCode             = select.value;
      var variantFullName = selectedOpt.getAttribute('data-fullname')    || selectedOpt.text;
      var variantDispName = selectedOpt.getAttribute('data-displayname') || variantFullName;
      var variantImg      = selectedOpt.getAttribute('data-image')       || '';
      var variantPrice    = parseFloat(selectedOpt.getAttribute('data-price') || '0');

      if (variantImg)       useImage = variantImg;
      if (variantPrice > 0) usePrice = variantPrice;
      if (variantFullName)  useName  = variantFullName;

      if (product.variantsLabel && variantDispName) {
        customOpts.push({ name: product.variantsLabel, value: variantDispName });
      }
    }

    var spaceLeft = PROMO_LIMIT - getPromoQty();
    var addPrice  = spaceLeft > 0 ? salePrice(usePrice, activeDiscountPct()) : usePrice;
    var addCat    = spaceLeft > 0 ? PROMO_CATEGORY : 'DEFAULT';
    console.log('[crossell] addToCart — name:', useName, '| price:', addPrice, '| code:', useCode, '| category:', addCat, '| price input:', usePrice, '| discountPct:', activeDiscountPct());

    addToCart(useName, addPrice, useCode, addCat, 1, useImage, product.url, customOpts.length ? customOpts : undefined);

    setTimeout(closePopup, 400);
  }

  /**
   * Show the popup for the given cross-sell config.
   * Sets ACTIVE_CONFIG and updates PROMO_LIMIT for the session.
   */
  function showPopup(cs) {
    if (alreadyShownFor(cs)) return;

    // Never show on the Foxy cart / checkout domain
    if (window.location.hostname.indexOf('foxycart')    !== -1 ||
        window.location.hostname.indexOf('foxy.io')      !== -1 ||
        window.location.hostname === 'secure.thegreendragoncbd.com') return;

    // Lock in this session's config for the popup that just fired
    ACTIVE_CONFIG = cs;
    PROMO_LIMIT   = (cs.maxQty != null) ? cs.maxQty : DEFAULT_MAX_QTY;

    markShownFor(cs);

    if (!document.getElementById('tgd-crossell-styles')) {
      var s = document.createElement('style');
      s.id  = 'tgd-crossell-styles';
      s.textContent = STYLES;
      document.head.appendChild(s);
    }

    if (!document.getElementById('tgd-crossell')) {
      document.body.insertAdjacentHTML('beforeend', popupHTML(cs));
    }

    var popup = document.getElementById('tgd-crossell');
    popup.style.display = 'flex';

    popup.querySelector('.cs-backdrop').addEventListener('click', closePopup);
    popup.querySelector('.cs-close').addEventListener('click', closePopup);
    popup.querySelector('.cs-decline').addEventListener('click', closePopup);

    popup.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.cs-add-btn') : null;
      if (btn && !btn.disabled) handlePromoAddClick(btn.getAttribute('data-product-code'));
    });

    // Variant dropdown: enable button and swap image/price on selection
    popup.addEventListener('change', function (e) {
      var select = e.target.closest ? e.target.closest('.cs-variant-select') : null;
      if (!select) return;
      var card = select.closest('.cs-product');
      if (!card) return;

      var btn = card.querySelector('.cs-add-btn');
      if (btn) btn.disabled = !select.value;

      if (select.value) {
        var opt    = select.options[select.selectedIndex];
        var varImg  = opt.getAttribute('data-image');
        var varSale = opt.getAttribute('data-sale');
        var varOrig = opt.getAttribute('data-orig');

        var cardImg   = card.querySelector('.cs-product-img');
        var priceOrig = card.querySelector('.cs-price-orig');
        var priceSale = card.querySelector('.cs-price-sale');

        if (varImg  && cardImg)   cardImg.src           = varImg;
        if (varOrig && priceOrig) priceOrig.textContent = '$' + varOrig;
        if (varSale && priceSale) priceSale.textContent = '$' + varSale;
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     12. AIRTABLE CONFIG LOADER
     ══════════════════════════════════════════════════════════════════════════ */

  function loadConfig() {
    try {
      var cached = sessionStorage.getItem(CONFIG_CACHE_KEY);
      if (cached) return Promise.resolve(JSON.parse(cached));
    } catch (e) { /* ignore */ }

    return fetch(CONFIG_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        try { sessionStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
        return data;
      })
      .catch(function (err) {
        console.warn('[crossell] Config fetch failed, using fallback:', err.message);
        return null;
      });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     13. FOXY EVENT HOOK + POLLING
     ══════════════════════════════════════════════════════════════════════════ */

  function attach() {
    if (!window.FC || !FC.client || typeof FC.client.on !== 'function') {
      setTimeout(attach, 100);
      return;
    }

    // FC events — re-render promo disclaimer and in-cart cross-sell on every cart update
    var onCartEvent = function () { updatePromoDisclaimer(); renderCartCrossSell(); };
    try { FC.client.on('loaded.done', onCartEvent); } catch (e) {}
    try { FC.client.on('add.done',    onCartEvent); } catch (e) {}
    try { FC.client.on('cart-loaded', onCartEvent); } catch (e) {}

    attachCartPlusInterceptor();
    attachQuantityInputWatcher();

    // Count-delta polling — fires popup when a non-promo item is added.
    // prevCount baseline is set on first read so pre-existing cart items
    // don't trigger the popup.
    //
    // Per-category tracking: we don't stop the poll early when one category's
    // popup fires — a different category may be added later in the same session.
    //
    // Race condition guard: if an item is added BEFORE the config fetch
    // completes, findActiveCrossSell() returns null (empty arrays).
    // pendingShow is set in that case so we retry the moment config arrives.
    var prevCount    = null;
    var configLoaded = false;
    var pendingShow  = false;

    var pollTimer = setInterval(function () {
      if (!(window.FC && FC.json && FC.json.items)) {
        updatePromoDisclaimer();
        return;
      }

      var current = countNonPromoItems();

      // Re-inject cart widget if cart is now visible but widget isn't there yet.
      // Sidecart uses .fc-cart__items; full-page cart uses .cart-item-blocks.
      if (GENERICCROSSSELLS.length &&
          (document.querySelector('.fc-cart__items') || document.querySelector('.cart-item-blocks')) &&
          !document.getElementById('tgd-cart-crossell')) {
        renderCartCrossSell();
      }

      if (prevCount === null) {
        prevCount = current; // establish baseline
        console.log('[crossell] poll baseline:', current, 'items');
      } else if (current > prevCount) {
        prevCount = current;
        console.log('[crossell] count delta detected — current:', current, '| configLoaded:', configLoaded);
        var items    = FC.json && FC.json.items;
        var asArray  = items ? (Array.isArray(items) ? items : Object.keys(items).map(function(k){return items[k];})) : [];
        var nonPromo = asArray.filter(function(it){return !isPromoItem(it);});
        console.log('[crossell] non-promo items:', nonPromo.map(function(it){return it.name + ' [cat:' + it.category + ' → norm:' + normaliseCategory(it.category) + ']';}));
        console.log('[crossell] CATEGORYCROSSSELLS:', CATEGORYCROSSSELLS.map(function(c){return c.primaryCategory+'('+c.parentCategories.join(',')+')';}).join(' | '));
        var cs = findActiveCrossSell();
        console.log('[crossell] findActiveCrossSell result:', cs ? cs.primaryCategory || 'generic' : 'null');
        if (cs) {
          console.log('[crossell] alreadyShownFor:', alreadyShownFor(cs), '| key:', shownKeyFor(cs));
          showPopup(cs); // showPopup checks alreadyShownFor(cs) — safe to call every time
        } else if (!configLoaded) {
          // Config hasn't arrived yet — remember to retry once it does
          pendingShow = true;
          console.log('[crossell] pendingShow set (config not yet loaded)');
        }
      } else {
        prevCount = current;
      }

      updatePromoDisclaimer();
    }, 1000);

    setTimeout(function () { clearInterval(pollTimer); }, 60000);

    // Load live config (or session cache) and populate runtime state.
    // After loading, retry the popup if an item was added during the fetch,
    // and render the in-cart cross-sell widget now that generic config is available.
    loadConfig().then(function (config) {
      if (config) {
        if (config.categoryCrossSells && config.categoryCrossSells.length) {
          CATEGORYCROSSSELLS = config.categoryCrossSells;
        }
        if (config.genericCrossSells && config.genericCrossSells.length) {
          GENERICCROSSSELLS = config.genericCrossSells;
        }
      }
      configLoaded = true;
      console.log('[crossell] config loaded —',
        CATEGORYCROSSSELLS.length, 'category cross-sell(s):',
        CATEGORYCROSSSELLS.map(function(c){ return c.primaryCategory + ' (' + c.parentCategories.join(', ') + ')'; }),
        '|', GENERICCROSSSELLS.length, 'generic cross-sell(s)'
      );
      // Always check for a matching cart item after config loads.
      // Covers two cases:
      //   (a) pendingShow — item was added before config fetch completed
      //   (b) pre-existing cart items — items were already in cart on page load
      // showPopup() guards against re-showing via alreadyShownFor(cs).
      pendingShow = false;
      var cs = findActiveCrossSell();
      if (cs) showPopup(cs);

      updatePromoDisclaimer();
      renderCartCrossSell(); // show in-cart widget now that generic config is loaded
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

})();
