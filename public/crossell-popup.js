/**
 * crossell-popup.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Green Dragon CBD — THC Cross-Sell Popup (Ferris Wheel Euphoric)
 *
 * • Shows a one-time-per-session popup when a THC-category item is added.
 * • Offers Ferris Wheel Euphoric products at 40% off, up to 3 units total.
 * • Units 4+ are automatically added as a separate line item at full price.
 * • Price tampering is blocked server-side by the pre-payment webhook
 *   (crossell-validate.js) before any card is ever charged.
 *
 * ─── SETUP CHECKLIST ────────────────────────────────────────────────────────
 *
 *  1. Fill in CROSSELL_PRODUCTS below (name, code, regularPrice, image, url).
 *
 *  2. Confirm THC_CATEGORY matches your Foxy product-category code for THC.
 *
 *  3. In Foxy Admin → Products → Categories, create:
 *       Code: CROSSELL_PROMO   Name: Cross-sell Promo
 *
 *  4. For every coupon in Foxy Admin → Advanced → Product Category Restrictions:
 *     whitelist only the categories the coupon should apply to, leaving
 *     CROSSELL_PROMO off the list.
 *
 *  5. Deploy crossell-validate.js as a Netlify function and register its URL
 *     in Foxy Admin → Store → Advanced → Pre-payment webhook URL.
 *
 *  6. In Webflow Site Settings → Custom Code → Footer Code, paste this file's
 *     contents wrapped in <script>…< / script>.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════════
     1.  CONFIGURATION — update these values
     ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * URL of the Netlify function that returns live config from Airtable.
   * Update to your production URL when going live.
   */
  var CONFIG_URL = 'https://develop--wondrous-bublanina-d440ec.netlify.app/.netlify/functions/crossell-config';

  /**
   * sessionStorage key for caching the Airtable config so it's only
   * fetched once per browser session.
   */
  var CONFIG_CACHE_KEY = 'tgd_crossell_config';

  /**
   * Fallback THC categories used if the Airtable config fetch fails.
   * These are the Foxy product-category codes — comparisons are case-insensitive.
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
   * pre-payment webhook (crossell-validate.js — keep both files in sync).
   */
  var PROMO_CATEGORY = 'CROSSELL_PROMO';

  /** Maximum units any customer can purchase at the promotional price. */
  var PROMO_LIMIT = 3;

  /** Fallback Foxy store domain (auto-detected from FC.json when available). */
  var STORE_DOMAIN = 'thegreendragoncbd.foxycart.com';

  /**
   * sessionStorage key — popup shows only once per browser session.
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

  /* ═══════════════════════════════════════════════════════════════════════════
     2.  HELPERS
     ═══════════════════════════════════════════════════════════════════════════ */

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

  /** Sum of quantities for all CROSSELL_PROMO items currently in the cart. */
  function getPromoQty() {
    var items = window.FC && FC.json && FC.json.items;
    if (!items) return 0;
    var total = 0;
    for (var id in items) {
      if (Object.prototype.hasOwnProperty.call(items, id)) {
        if ((items[id].category || '').toUpperCase() === PROMO_CATEGORY.toUpperCase()) {
          total += (items[id].quantity || 0);
        }
      }
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
   * FC.client.request() is FoxyCart's own internal AJAX method — the same one
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
        }).join('') : '');

    // Always include the session ID so the item attaches to the existing cart.
    if (sessName && sessId) {
      cartUrl += '&' + encodeURIComponent(sessName) + '=' + encodeURIComponent(sessId);
    }

    // Two different mechanisms depending on context:
    //
    // FULL-PAGE CART (on a Foxy domain — tgd-test.foxycart.com, etc.):
    //   link.click() is intercepted by Foxy but silently fails to add items on
    //   the full-page cart.  Direct navigation works: Foxy processes the add-to-cart
    //   URL and reloads the cart page with the new item present.
    //   domain is now correct (FC.json.config.store_domain) so this stays on the
    //   right store (test vs production).
    //
    // SIDECART (on a Webflow domain):
    //   Foxy intercepts the link click via AJAX → item added without page navigation.
    var onFoxyDomain = window.location.hostname.indexOf('foxycart') !== -1 ||
                       window.location.hostname.indexOf('foxy.io')  !== -1;

    if (onFoxyDomain) {
      window.location.href = cartUrl;
    } else {
      var link = document.createElement('a');
      link.style.display = 'none';
      link.href = cartUrl;
      document.body.appendChild(link);
      link.click();
      setTimeout(function () { document.body.removeChild(link); }, 200);
    }
  }

  /** True if popup has already been shown this browser session. */
  function alreadyShown() {
    try { return !!sessionStorage.getItem(SESSION_KEY); } catch (e) { return false; }
  }

  function markShown() {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { /* ignore */ }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     3.  CART QUANTITY LIMIT ENFORCEMENT
     ═══════════════════════════════════════════════════════════════════════════ */

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

      // Only intercept CROSSELL_PROMO items
      if ((cartItem.category || '').toUpperCase() !== PROMO_CATEGORY.toUpperCase()) return;

      // If still under the limit, let Foxy handle it normally
      if (getPromoQty() < PROMO_LIMIT) return;

      // AT LIMIT — intercept and add 1 at full price instead
      e.stopPropagation();
      e.preventDefault();

      var product = getProductByCode(cartItem.code);
      if (product) {
        // Determine the correct price — variant price if this is a variant item
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
          cartItem.name,   // already includes variant (e.g. "Ferris Wheel…-   Blue Razz")
          overflowPrice,
          overflowCode,
          'DEFAULT',
          1,
          overflowImage,
          product.url,
          overflowOpts.length ? overflowOpts : undefined
        );
      }
    }, true); // capture phase — runs before Foxy's bubble-phase listeners
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     4.  STYLES
     ═══════════════════════════════════════════════════════════════════════════ */

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
    '#tgd-crossell .cs-product img{width:100%;height:160px;object-fit:cover;display:block;}',
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
    '#tgd-crossell .cs-decline{display:block;width:100%;background:none;border:none;color:#bbb;font-size:12px;text-decoration:underline;cursor:pointer;padding:2px 0 0;text-align:center;font-family:Lato,sans-serif;}',
    '#tgd-crossell .cs-decline:hover{color:#888;}',
    '@media(max-width:479px){#tgd-crossell .cs-product{flex:1 1 100%;}#tgd-crossell .cs-box{padding:22px 14px 18px;}#tgd-crossell .cs-title{font-size:18px;}}'
  ].join('');

  /* ═══════════════════════════════════════════════════════════════════════════
     5.  POPUP HTML
     ═══════════════════════════════════════════════════════════════════════════ */

  function productCardHTML(p) {
    var sale      = salePrice(p.regularPrice);
    var hasVars   = p.variants && p.variants.length > 0;
    var varLabel  = p.variantsLabel || 'Option';

    // Build variant dropdown (disabled Add to Cart until selection is made)
    var variantSelect = '';
    if (hasVars) {
      variantSelect = '<select class="cs-variant-select" data-product-code="' + p.code + '">'
        + '<option value="">— Select ' + varLabel + ' —</option>'
        + p.variants.map(function (v) {
            var vSale    = salePrice(v.price || p.regularPrice);
            var vOrig    = Number(v.price || p.regularPrice).toFixed(2);
            var dispName = v.displayName || v.name; // short: "Blue Razz"
            var fullName = v.name;                  // full: "Ferris Wheel…-   Blue Razz"
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
      + '<p class="cs-eyebrow">🎡 Exclusive One-Time Offer</p>'
      + '<h2 id="cs-title" class="cs-title">Try Our New Euphoric Products &mdash; 40% Off!</h2>'
      + '<p class="cs-subtitle">This special price is available <strong>today only</strong> and won\'t appear anywhere else on our site. Limited to ' + PROMO_LIMIT + ' units per customer at the discounted price.</p>'
      + '<div class="cs-products">' + CROSSELL_PRODUCTS.map(productCardHTML).join('') + '</div>'
      + '<button class="cs-decline">No thanks, I\'ll skip this offer</button>'
      + '</div></div>';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     6.  SHOW / CLOSE
     ═══════════════════════════════════════════════════════════════════════════ */

  function closePopup() {
    var el = document.getElementById('tgd-crossell');
    if (el) el.style.display = 'none';
  }

  /**
   * Handle "Add to Cart" clicks inside the popup.
   * Respects the PROMO_LIMIT:
   *   - If space remains under the limit → add at promo price (CROSSELL_PROMO)
   *   - If limit already reached         → add at full price (DEFAULT category)
   *   - If partially under limit         → add the remaining allowance at promo,
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

      // Full name used as cart item name (e.g. "Ferris Wheel…-   Blue Razz")
      var variantFullName  = selectedOpt.getAttribute('data-fullname')    || selectedOpt.text;
      // Display name used as option value (e.g. "Blue Razz")
      var variantDispName  = selectedOpt.getAttribute('data-displayname') || variantFullName;
      var variantImg       = selectedOpt.getAttribute('data-image')       || '';
      var variantPrice     = parseFloat(selectedOpt.getAttribute('data-price') || '0');

      if (variantImg)          useImage = variantImg;
      if (variantPrice > 0)    usePrice = variantPrice;
      if (variantFullName)     useName  = variantFullName; // show "Ferris Wheel…- Blue Razz" in cart

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

  /* ═══════════════════════════════════════════════════════════════════════════
     7.  FOXY EVENT HOOK
     ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Normalise an option name for loose comparison — removes spaces, underscores,
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

  /* ═══════════════════════════════════════════════════════════════════════════
     8.  AIRTABLE CONFIG LOADER
     ═══════════════════════════════════════════════════════════════════════════ */

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

  /* ═══════════════════════════════════════════════════════════════════════════
     9.  FOXY EVENT HOOK
     ═══════════════════════════════════════════════════════════════════════════ */

  function attach() {
    if (!window.FC || !FC.client || typeof FC.client.on !== 'function') {
      setTimeout(attach, 100); // Poll frequently — Foxy loads async
      return;
    }

    // Load config from Airtable (or session cache), then wire up cart listeners
    loadConfig().then(function (config) {
      // Apply live data if fetch succeeded; otherwise keep hardcoded fallbacks
      if (config) {
        if (config.categories && config.categories.length) {
          THC_CATEGORIES = config.categories;
        }
        if (config.products && config.products.length) {
          CROSSELL_PRODUCTS = config.products;
        }
      }

      // Register event listeners (try multiple event names across FC versions)
      FC.client.on('loaded.done', checkAndShow);
      try { FC.client.on('add.done',    checkAndShow); } catch (e) {}
      try { FC.client.on('cart-loaded', checkAndShow); } catch (e) {}

      // Immediate check — catches full-page cart where loaded.done already fired
      checkAndShow();
      setTimeout(checkAndShow, 300);
      setTimeout(checkAndShow, 800);

      attachCartPlusInterceptor();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

})();
