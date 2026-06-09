/**
 * crossell-popup.js
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Green Dragon CBD â€” THC Cross-Sell Popup (Ferris Wheel Euphoric)
 *
 * â€¢ Shows a one-time-per-session popup when a THC-category item is added.
 * â€¢ Offers Ferris Wheel Euphoric products at 40% off, up to 3 units total.
 * â€¢ Units 4+ are automatically added as a separate line item at full price.
 * â€¢ Price tampering is blocked server-side by the pre-payment webhook
 *   (crossell-validate.js) before any card is ever charged.
 *
 * â”€â”€â”€ SETUP CHECKLIST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *
 *  1. Fill in CROSSELL_PRODUCTS below (name, code, regularPrice, image, url).
 *
 *  2. Confirm THC_CATEGORY matches your Foxy product-category code for THC.
 *
 *  3. In Foxy Admin â†' Products â†' Categories, create:
 *       Code: CROSSELL_PROMO   Name: Cross-sell Promo
 *
 *  4. For every coupon in Foxy Admin â†' Advanced â†' Product Category Restrictions:
 *     whitelist only the categories the coupon should apply to, leaving
 *     CROSSELL_PROMO off the list.
 *
 *  5. Deploy crossell-validate.js as a Netlify function and register its URL
 *     in Foxy Admin â†' Store â†' Advanced â†' Pre-payment webhook URL.
 *
 *  6. In Webflow Site Settings â†' Custom Code â†' Footer Code, paste this file's
 *     contents wrapped in <script>â€¦< / script>.
 *
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 */

(function () {
  'use strict';

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     1.  CONFIGURATION â€” update these values
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  /**
   * URL of the Netlify function that returns live config from Airtable.
   * Update to your production URL when going live.
   */
  var CONFIG_URL = 'https://wondrous-bublanina-d440ec.netlify.app/.netlify/functions/crossell-config';

  /**
   * sessionStorage key for caching the Airtable config so it's only
   * fetched once per browser session.
   */
  var CONFIG_CACHE_KEY = 'tgd_crossell_config';

  /**
   * Fallback THC categories used if the Airtable config fetch fails.
   * These are the Foxy product-category codes â€” comparisons are case-insensitive.
   */
  var THC_CATEGORIES = [
    'Vape Kits',
    'Delta 8',
    'Delta 9',
    'THCa',
    'Delta 10',
    'Delta 11 (HXY-11)',
    'Delta 6',
    'Live Resin',
    'THCP',
    'THC-V',
    'THCh',
    'THCjd'
  ];

  /**
   * Foxy product-category code for cross-sell promo items.
   * Used to exclude items from coupon codes and to validate pricing in the
   * pre-payment webhook (crossell-validate.js â€” keep both files in sync).
   */
  var PROMO_CATEGORY = 'CROSSELL_PROMO';

  /** Maximum units any customer can purchase at the promotional price. */
  var PROMO_LIMIT = 3;

  /** Fallback Foxy store domain (auto-detected from FC.json when available). */
  var STORE_DOMAIN = 'thegreendragoncbd.foxycart.com';

  /**
   * sessionStorage key â€” popup shows only once per browser session.
   * Clears automatically when the user closes their browser or tab.
   */
  var SESSION_KEY = 'tgd_crossell_shown';

  /**
   * Fallback cross-sell products used if the Airtable config fetch fails.
   * In normal operation these are replaced by live data from Airtable
   * (products with the "Cross-sell Promo" checkbox checked).
   */
  var CROSSELL_PRODUCTS = [
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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     2.  HELPERS
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  /** 40% off = pay 60%.  Returns a string like "23.99". */
  function salePrice(regular) {
    return (Math.round(regular * 60) / 100).toFixed(2);
  }

  /**
   * Look up a product config by its Foxy product code.
   * Searches both parent codes and variant codes so variant cart items
   * (whose code is the variant record ID) are still found.
   * Returns the parent product object in both cases.
   */
  function getProductByCode(code) {
    for (var i = 0; i < CROSSELL_PRODUCTS.length; i++) {
      if (CROSSELL_PRODUCTS[i].code === code) return CROSSELL_PRODUCTS[i];
      var vars = CROSSELL_PRODUCTS[i].variants || [];
      for (var j = 0; j < vars.length; j++) {
        if (vars[j].code === code) return CROSSELL_PRODUCTS[i];
      }
    }
    return null;
  }

  /**
   * Given a cart item code (may be a variant code), return the matching
   * variant object or null if it's a parent code or not found.
   */
  function getVariantByCode(code) {
    for (var i = 0; i < CROSSELL_PRODUCTS.length; i++) {
      var vars = CROSSELL_PRODUCTS[i].variants || [];
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
      if (n === 'crossell_promo' && opts[i].value === 'true') {
        return true;
      }
    }
    // Fallback: category check (works when Foxy correctly assigns CROSSELL_PROMO)
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

  /** Find a cart item from FC.json by its Foxy item ID (the data-fc-item-id value). */
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
   * Add an item to the Foxy cart without page navigation.
   *
   * FC.client.request() is FoxyCart's own internal AJAX method â€” the same one
   * it uses when intercepting add-to-cart link clicks for the sidecart.
   * Calling it directly works in ALL contexts (sidecart, full-page cart, test,
   * production) because it goes through Foxy's JSONP request pipeline and
   * triggers a cart refresh via the 'loaded.done' event without navigating.
   *
   * Falls back to direct link navigation only if FC.client is somehow
   * unavailable (should never happen once attach() has confirmed it exists).
   */
  /**
   * @param {Array} [customOptions]  e.g. [{name:'Flavor', value:'Watermelon Pucker'}]
   *   Appended to the cart URL as &Flavor=Watermelon+Pucker so Foxy stores
   *   them as item options visible in the cart.
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
      // Hidden marker that travels with the item regardless of Foxy's category assignment.
      // Used by getPromoQty() and attachCartPlusInterceptor() for reliable detection.
      + (category === PROMO_CATEGORY ? '&h:crossell_promo=true' : '');

    // Always include the session ID so the item attaches to the existing cart.
    if (sessName && sessId) {
      cartUrl += '&' + encodeURIComponent(sessName) + '=' + encodeURIComponent(sessId);
    }

    // FC.client.request() is Foxy's own internal AJAX pipeline — the same call
    // Foxy makes when it intercepts an add-to-cart link click on the sidecart.
    // Using it directly works on BOTH the Webflow sidecart and the Foxy
    // full-page cart without any page navigation or domain branching.
    if (window.FC && FC.client && typeof FC.client.request === 'function') {
      FC.client.request(cartUrl);
      return;
    }

    // Fallback (FC.client.request unavailable — should not happen after attach()):
    // Off-screen link click; Foxy's document-level delegation intercepts it.
    var link = document.createElement('a');
    link.style.position = 'absolute';
    link.style.top      = '-9999px';
    link.style.left     = '-9999px';
    link.href = cartUrl;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { document.body.removeChild(link); }, 200);
  }

  /** True if popup has already been shown this browser session. */
  function alreadyShown() {
    try { return !!sessionStorage.getItem(SESSION_KEY); } catch (e) { return false; }
  }

  function markShown() {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { /* ignore */ }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     3.  PROMO LIMIT DISCLAIMER
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  /**
   * Inserts a small notice under each promo item in the cart when either:
   *  a) A full-price overflow line exists for the same product (the customer
   *     clicked + past the limit), or
   *  b) The promo item's qty was set above the limit by typing directly.
   *
   * The notice is re-evaluated on every FC loaded.done event so it stays
   * accurate as the cart changes.
   */
  function updatePromoDisclaimer() {
    setTimeout(function () {
      // Remove stale notices first
      var old = document.querySelectorAll('.cs-promo-limit-notice');
      for (var i = 0; i < old.length; i++) {
        if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
      }

      var items = window.FC && FC.json && FC.json.items;
      if (!items) return;

      var asArray = Array.isArray(items)
        ? items
        : Object.keys(items).map(function (k) { return items[k]; });

      var promoItems = asArray.filter(isPromoItem);
      if (!promoItems.length) return;

      var totalPromoQty = promoItems.reduce(function (sum, it) { return sum + (it.quantity || 0); }, 0);

      // Show if any overflow full-price item exists (same variant code, no marker)
      var hasOverflow = asArray.some(function (it) {
        if (isPromoItem(it)) return false;
        return promoItems.some(function (p) { return p.code === it.code; });
      });

      // Also show if someone typed a qty higher than the limit
      if (!hasOverflow && totalPromoQty <= PROMO_LIMIT) return;

      var msg = '&#9888;&#65039;  The promotional price is limited to '
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
    }, 300); // short delay to let Foxy finish re-rendering the cart DOM
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     4.  CART QUANTITY LIMIT ENFORCEMENT
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  /**
   * Watches the Foxy quantity input for direct edits (mobile keyboard, desktop
   * typing).  Runs in capture phase so we can cap the value before Foxy reads
   * it.  If the typed qty would push promo units over PROMO_LIMIT we:
   *   1. Set input.value to the allowed max (Foxy then submits with that value)
   *   2. Add the overflow units at full price via addToCart
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

      // Max promo units this one item is allowed to have
      var otherPromoQty = getPromoQty() - (cartItem.quantity || 0);
      var maxAllowed    = Math.max(1, PROMO_LIMIT - otherPromoQty);
      if (newQty <= maxAllowed) return; // still within limit â€” allow

      var overflowQty = newQty - maxAllowed;

      // Cap the input â€” Foxy reads input.value in the bubble phase, so it
      // will submit with the capped value rather than the typed value.
      input.value = maxAllowed;

      // Add overflow at full price
      var product = getProductByCode(cartItem.code);
      var variant  = getVariantByCode(cartItem.code);
      if (!product) return;

      var overflowPrice = (variant && variant.price) ? variant.price : product.regularPrice;
      var overflowImage = (variant && variant.image) ? variant.image : product.image;
      var overflowOpts  = (cartItem.options || []).filter(function (o) {
        var n = normaliseOptionName(o.name);
        return n !== 'restrictedshopping' && n !== 'restrictedshippingcode' &&
               n !== 'airtablerecordid'   && n !== 'heavydrink' && n !== 'crossellpromo';
      });

      addToCart(
        cartItem.name,
        overflowPrice,
        cartItem.code,
        'DEFAULT',
        overflowQty,
        overflowImage,
        product.url,
        overflowOpts.length ? overflowOpts : undefined
      );

    }, true); // useCapture â€” runs before Foxy's listeners
  }

  /**
   * Called when a shopper clicks the "+" button on a CROSSELL_PROMO item in the
   * cart and the promo limit has already been reached.
   *
   * Strategy: prevent Foxy from incrementing the promo item's quantity and
   * instead add one unit of the same product at full price as a new line item.
   *
   * Attached in capture phase (useCapture=true) so our handler runs before
   * Foxy's delegated click listeners.
   */
  function attachCartPlusInterceptor() {
    document.addEventListener('click', function (e) {
      // Only care about clicks on the "+" add-item button
      var target = e.target;
      var addBtn = (target.classList && target.classList.contains('add-item-sign'))
        ? target
        : (target.closest ? target.closest('.add-item-sign') : null);

      if (!addBtn) return;

      // Walk up to find the cart item's data-fc-item-id
      var itemContainer = addBtn.closest
        ? addBtn.closest('[data-fc-item-id]')
        : null;
      if (!itemContainer) return;

      var fcItemId = itemContainer.getAttribute('data-fc-item-id');
      var cartItem = getCartItemByFcId(fcItemId);
      if (!cartItem) return;

      // Only intercept cross-sell promo items (detected by marker option or category)
      if (!isPromoItem(cartItem)) return;

      // If still under the limit, let Foxy handle it normally
      if (getPromoQty() < PROMO_LIMIT) return;

      // AT LIMIT â€” intercept and add 1 at full price instead
      e.stopPropagation();
      e.preventDefault();

      var product = getProductByCode(cartItem.code);
      if (product) {
        // Determine the correct price â€” variant price if this is a variant item
        var variant      = getVariantByCode(cartItem.code);
        var overflowPrice = (variant && variant.price) ? variant.price : product.regularPrice;
        var overflowCode  = cartItem.code; // keep the exact variant code already in cart

        // Carry through visible cart options (e.g. Flavor) so the overflow
        // line item shows the same variant. Filter out hidden system options.
        var overflowOpts = (cartItem.options || []).filter(function (o) {
          var n = normaliseOptionName(o.name);
          return n !== 'restrictedshopping' &&
                 n !== 'restrictedshippingcode' &&
                 n !== 'airtablerecordid' &&
                 n !== 'heavydrink';
        });

        // Use variant image if available, fall back to parent image
        var overflowImage = (variant && variant.image) ? variant.image : product.image;

        addToCart(
          cartItem.name,   // already includes variant (e.g. "Ferris Wheelâ€¦-   Blue Razz")
          overflowPrice,
          overflowCode,
          'DEFAULT',
          1,
          overflowImage,
          product.url,
          overflowOpts.length ? overflowOpts : undefined
        );
      }
    }, true); // capture phase â€” runs before Foxy's bubble-phase listeners
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     4.  STYLES
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     5.  POPUP HTML
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function productCardHTML(p) {
    var sale      = salePrice(p.regularPrice);
    var hasVars   = p.variants && p.variants.length > 0;
    var varLabel  = p.variantsLabel || 'Option';

    // Build variant dropdown (disabled Add to Cart until selection is made)
    var variantSelect = '';
    if (hasVars) {
      variantSelect = '<select class="cs-variant-select" data-product-code="' + p.code + '">'
        + '<option value="" selected disabled>Select</option>'
        + p.variants.map(function (v) {
            var vSale    = salePrice(v.price || p.regularPrice);
            var vOrig    = Number(v.price || p.regularPrice).toFixed(2);
            var dispName = v.displayName || v.name; // short: "Blue Razz"
            var fullName = v.name;                  // full: "Ferris Wheelâ€¦-   Blue Razz"
            return '<option value="' + v.code + '"'
              + ' data-displayname="' + dispName.replace(/"/g, '&quot;') + '"'
              + ' data-fullname="'    + fullName.replace(/"/g, '&quot;') + '"'
              + ' data-image="'       + (v.image || '').replace(/"/g, '&quot;') + '"'
              + ' data-price="'       + (v.price || p.regularPrice) + '"'
              + ' data-sale="'        + vSale + '"'
              + ' data-orig="'        + vOrig + '">'
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
      + '<span class="cs-badge">40% OFF</span>'
      + '</div>'
      + variantSelect
      + '<button class="cs-add-btn" data-product-code="' + p.code + '"'
      + (hasVars ? ' disabled' : '') + '>Add to Cart</button>'
      + '</div></div>';
  }

  function popupHTML() {
    return '<div id="tgd-crossell" role="dialog" aria-modal="true" aria-labelledby="cs-title" style="display:none;">'
      + '<div class="cs-backdrop"></div>'
      + '<div class="cs-box">'
      + '<button class="cs-close" aria-label="Close offer">&times;</button>'
      + '<p class="cs-eyebrow">&#127905; Exclusive One-Time Offer</p>'
      + '<h2 id="cs-title" class="cs-title">Try Our New Euphoric Products &mdash; 40% Off!</h2>'
      + '<p class="cs-subtitle">This special price is available <strong>today only</strong> and won\'t appear anywhere else on our site. Limited to ' + PROMO_LIMIT + ' units per customer at the discounted price.</p>'
      + '<div class="cs-products">' + CROSSELL_PRODUCTS.map(productCardHTML).join('') + '</div>'
      + '<p class="cs-disclaimer">This discount cannot be combined with other offers or coupon codes.</p>'
      + '<button class="cs-decline">No thanks, I\'ll skip this offer</button>'
      + '</div></div>';
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     6.  SHOW / CLOSE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function closePopup() {
    var el = document.getElementById('tgd-crossell');
    if (el) el.style.display = 'none';
  }

  /**
   * Handle "Add to Cart" clicks inside the popup.
   * Respects the PROMO_LIMIT:
   *   - If space remains under the limit â†' add at promo price (CROSSELL_PROMO)
   *   - If limit already reached         â†' add at full price (DEFAULT category)
   *   - If partially under limit         â†' add the remaining allowance at promo,
   *                                        nothing extra (qty=1 per click)
   */
  function handlePromoAddClick(productCode) {
    var product = getProductByCode(productCode);
    if (!product) return;

    // Resolve which name / code / image / price / options to use
    var useName    = product.name;
    var useCode    = product.code;
    var useImage   = product.image;
    var usePrice   = product.regularPrice;
    var customOpts = [];

    if (product.variants && product.variants.length > 0) {
      var select = document.querySelector(
        '.cs-variant-select[data-product-code="' + productCode + '"]'
      );
      if (!select || !select.value) return; // button should be disabled, but safety check

      var selectedOpt  = select.options[select.selectedIndex];
      useCode = select.value;

      // Full name used as cart item name (e.g. "Ferris Wheelâ€¦-   Blue Razz")
      var variantFullName  = selectedOpt.getAttribute('data-fullname')    || selectedOpt.text;
      // Display name used as option value (e.g. "Blue Razz")
      var variantDispName  = selectedOpt.getAttribute('data-displayname') || variantFullName;
      var variantImg       = selectedOpt.getAttribute('data-image')       || '';
      var variantPrice     = parseFloat(selectedOpt.getAttribute('data-price') || '0');

      if (variantImg)          useImage = variantImg;
      if (variantPrice > 0)    usePrice = variantPrice;
      if (variantFullName)     useName  = variantFullName; // show "Ferris Wheelâ€¦- Blue Razz" in cart

      // Add the option so it appears in cart details (e.g. Flavor: Blue Razz)
      if (product.variantsLabel && variantDispName) {
        customOpts.push({ name: product.variantsLabel, value: variantDispName });
      }
    }

    var spaceLeft = PROMO_LIMIT - getPromoQty();

    if (spaceLeft > 0) {
      addToCart(useName, salePrice(usePrice), useCode, PROMO_CATEGORY, 1, useImage, product.url, customOpts);
    } else {
      addToCart(useName, usePrice, useCode, 'DEFAULT', 1, useImage, product.url, customOpts);
    }

    setTimeout(closePopup, 400);
  }

  function showPopup() {
    if (alreadyShown()) return;

    // Never show on the Foxy cart / checkout domain.  sessionStorage is
    // origin-scoped, so the "already shown" flag set on www.thegreendragoncbd.com
    // (sidecart) is invisible here (full cart), causing the popup to fire twice.
    if (window.location.hostname.indexOf('foxycart')          !== -1 ||
        window.location.hostname.indexOf('foxy.io')            !== -1 ||
        window.location.hostname === 'secure.thegreendragoncbd.com') return;

    markShown();

    // Inject stylesheet once
    if (!document.getElementById('tgd-crossell-styles')) {
      var s = document.createElement('style');
      s.id = 'tgd-crossell-styles';
      s.textContent = STYLES;
      document.head.appendChild(s);
    }

    // Inject HTML once
    if (!document.getElementById('tgd-crossell')) {
      document.body.insertAdjacentHTML('beforeend', popupHTML());
    }

    var popup = document.getElementById('tgd-crossell');
    popup.style.display = 'flex';

    // Wire up close triggers
    popup.querySelector('.cs-backdrop').addEventListener('click', closePopup);
    popup.querySelector('.cs-close').addEventListener('click', closePopup);
    popup.querySelector('.cs-decline').addEventListener('click', closePopup);

    // Wire up Add to Cart buttons (skip if button is disabled)
    popup.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.cs-add-btn') : null;
      if (btn && !btn.disabled) handlePromoAddClick(btn.getAttribute('data-product-code'));
    });

    // Variant dropdown: enable Add to Cart when a variant is selected,
    // and swap the product card image to the variant-specific image.
    popup.addEventListener('change', function (e) {
      var select = e.target.closest ? e.target.closest('.cs-variant-select') : null;
      if (!select) return;
      var card = select.closest('.cs-product');
      if (!card) return;

      // Enable / disable the Add to Cart button
      var btn = card.querySelector('.cs-add-btn');
      if (btn) btn.disabled = !select.value;

      // Swap product image and update price display when a variant is selected
      if (select.value) {
        var opt    = select.options[select.selectedIndex];
        var varImg = opt.getAttribute('data-image');
        var varSale = opt.getAttribute('data-sale');
        var varOrig = opt.getAttribute('data-orig');

        var cardImg = card.querySelector('.cs-product-img');
        if (varImg && cardImg) cardImg.src = varImg;

        var priceOrig = card.querySelector('.cs-price-orig');
        var priceSale = card.querySelector('.cs-price-sale');
        if (varOrig && priceOrig) priceOrig.textContent = '$' + varOrig;
        if (varSale && priceSale) priceSale.textContent = '$' + varSale;
      }
    });
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     7.  FOXY EVENT HOOK
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  /**
   * Normalise an option name for loose comparison â€” removes spaces, underscores,
   * hyphens and lowercases so "Restricted Shipping Code", "restricted_shipping_code"
   * and "restricted-shipping-code" all compare equal.
   */
  function normaliseOptionName(s) {
    return (s || '').toLowerCase().replace(/[\s_\-]/g, '');
  }

  /**
   * Returns true if the cart item has the hidden Foxy option
   * "Restricted Shipping Code" set to "thc".
   * This option is applied to every THC product via Airtable/Foxy and is
   * more reliable than matching Foxy category codes, which differ between
   * products (e.g. "THCa" vs "thc-p" vs "delta-8").
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

  /** Returns true if the given Foxy category code is in the THC category list. */
  function isTHCCategory(category) {
    var cat = (category || '').toLowerCase();
    for (var i = 0; i < THC_CATEGORIES.length; i++) {
      if (THC_CATEGORIES[i].toLowerCase() === cat) return true;
    }
    return false;
  }

  /**
   * Count THC items in the cart.
   * Primarily uses the "Restricted Shipping Code = thc" option (set on every
   * THC product regardless of its Foxy category code).  Falls back to
   * category-name matching for items that lack that option.
   */
  function countTHCItems() {
    var items = window.FC && FC.json && FC.json.items;
    if (!items) return 0;
    var count   = 0;
    var asArray = Array.isArray(items) ? items : Object.keys(items).map(function (k) { return items[k]; });
    for (var i = 0; i < asArray.length; i++) {
      var item = asArray[i];
      if (itemHasTHCOption(item) || isTHCCategory(item.category)) {
        count += (item.quantity || 1);
      }
    }
    return count;
  }

  function checkAndShow() {
    if (countTHCItems() > 0) showPopup();
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     8.  AIRTABLE CONFIG LOADER
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  /**
   * Fetches live category and product config from the crossell-config Netlify
   * function.  Result is cached in sessionStorage so Airtable is only hit
   * once per browser session.  Falls back to the hardcoded arrays if the
   * fetch fails.
   */
  function loadConfig() {
    // Return cached config if available
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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     9.  FOXY EVENT HOOK
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function attach() {
    if (!window.FC || !FC.client || typeof FC.client.on !== 'function') {
      setTimeout(attach, 100); // Poll frequently - Foxy loads async
      return;
    }

    // Register FC cart event listeners IMMEDIATELY - before the Airtable config
    // fetch - so a product added while the fetch is in flight still triggers the
    // popup (fixes sidecart race condition where loaded.done fired too early).
    var onCartEvent = function () { checkAndShow(); updatePromoDisclaimer(); };
    FC.client.on('loaded.done', onCartEvent);
    try { FC.client.on('add.done',    onCartEvent); } catch (e) {}
    try { FC.client.on('cart-loaded', onCartEvent); } catch (e) {}

    // Attach cart quantity interceptors IMMEDIATELY — before loadConfig() so
    // a customer who opens the cart and clicks "+" before the Airtable fetch
    // completes is still protected.  These listeners read CROSSELL_PRODUCTS at
    // click time, so they work correctly once the config has loaded.
    attachCartPlusInterceptor();
    attachQuantityInputWatcher();

    // Polling fallback - belt-and-suspenders for sidecart setups where FC
    // events don't fire reliably. Checks every 1 s for up to 60 s after page
    // load; stops as soon as the popup has been shown.
    var pollTimer = setInterval(function () {
      if (alreadyShown()) { clearInterval(pollTimer); return; }
      checkAndShow();
    }, 1000);
    setTimeout(function () { clearInterval(pollTimer); }, 60000);

    // Load live config (or session cache), then re-check with accurate
    // categories/products.
    loadConfig().then(function (config) {
      if (config) {
        if (config.categories && config.categories.length) {
          THC_CATEGORIES = config.categories;
        }
        if (config.products && config.products.length) {
          CROSSELL_PRODUCTS = config.products;
        }
      }

      // Re-check now that we have live data; also handles full-page cart
      // where THC items were already present on page load.
      checkAndShow();
      updatePromoDisclaimer();
      setTimeout(function () { checkAndShow(); updatePromoDisclaimer(); }, 300);
      setTimeout(function () { checkAndShow(); updatePromoDisclaimer(); }, 800);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

})();
