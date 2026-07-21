/**
 * BACK-IN-STOCK WIDGET  (hosted on Netlify, embedded on the Webflow product template)
 * ─────────────────────────────────────────────────────────────────────────────
 * Shows a "Notify me when it's back in stock" email capture ONLY when the product
 * (or a chosen variant) is out of stock, and POSTs the signup to the
 * back-in-stock-subscribe Netlify function.
 *
 * Runs only on product detail pages (/product/... and /products-wholesale/...).
 * It reads the same hidden CMS data nodes that quickview-multivariants.js reads
 * (.foxy_product_item_* and .foxy_variant_item .foxy_variants_item-*), so it needs
 * no changes to that script; it also listens for the `dgc:variantSelected` /
 * `dgc:variantCleared` events that script already dispatches to pre-select the
 * shopper's chosen option.
 *
 * Placement: put an empty <div id="gd-back-in-stock"></div> in the product template
 * where the form should appear (see back-in-stock-webflow-embed.html). If the div is
 * absent the widget injects itself just after the Foxy add-to-cart form (#foxy-form).
 *
 * Out-of-stock rule (mirrors quickview): inventory <= 0 AND backorders not allowed.
 * Cases handled:
 *   • no variants, product OOS            → email form for the product
 *   • variants, ALL OOS                   → email form for the product
 *   • variants, SOME OOS                  → a chooser of the sold-out options + email
 *                                           (works whether or not the option is selectable)
 */
(function () {
  'use strict';

  var PATH = window.location.pathname;
  var isProductPage = /\/product\//.test(PATH) || PATH.indexOf('/products-wholesale/') !== -1;
  if (!isProductPage) return;

  // Netlify function endpoint. DEVELOP for staging; swap to prod on go-live:
  //   prod: https://wondrous-bublanina-d440ec.netlify.app/.netlify/functions/back-in-stock-subscribe
  var FN_URL = 'https://develop--wondrous-bublanina-d440ec.netlify.app/.netlify/functions/back-in-stock-subscribe';

  var VARIANT_ATTRS = ['strain', 'size', 'flavor', 'strength', 'type'];
  var BRAND = '#37b772';

  function txt(root, sel) { var el = root.querySelector(sel); return el ? (el.textContent || '').trim() : ''; }
  function isOOS(item) { return Number(item.inventory) <= 0 && item.allowBackorders !== 'true'; }
  // Discontinued items never come back, so we never offer a notify signup for them.
  // Webflow renders the CMS checkbox as the text "true"/"false"; an unexposed field
  // is empty → treated as not discontinued (no effect).
  function isDiscontinued(item) {
    return String((item && item.discontinued) || '').trim().toLowerCase() === 'true';
  }

  // The product page ALSO renders related-product cards (each wrapped in
  // .foxy_product_collection-item) that carry their own .foxy_product_item_info
  // and .foxy_variant_item nodes. We must read ONLY the current (main) product,
  // so every read excludes anything inside a related-product card.
  function mainNodes(selector) {
    return Array.prototype.filter.call(
      document.querySelectorAll(selector),
      function (el) { return !el.closest('.foxy_product_collection-item'); }
    );
  }

  function readProduct() {
    var infos = mainNodes('.foxy_product_item_info');
    if (!infos.length) return null;
    var root = infos[infos.length - 1]; // main product's bound data (last, like quickview)
    return {
      name: txt(root, '.foxy_product_item_name'),
      sku: txt(root, '.foxy_product_item_sku'),
      inventory: txt(root, '.foxy_product_item_inventory') || '0',
      allowBackorders: txt(root, '.foxy_product_item_allow-backorders'),
      discontinued: txt(root, '.foxy_product_item_discontinued'),
      price: txt(root, '.foxy_product_item_sale-price') || txt(root, '.foxy_product_item_price'),
    };
  }

  function readVariants() {
    var out = [];
    mainNodes('.foxy_variant_item').forEach(function (el) {
      var v = {
        code: txt(el, '.foxy_variants_item-sku'),
        name: txt(el, '.foxy_variants_item-name'),
        inventory: txt(el, '.foxy_variants_item-inventory') || '0',
        allowBackorders: txt(el, '.foxy_variants_item-allow-backorders'),
        discontinued: txt(el, '.foxy_variants_item-discontinued'),
        image: (el.querySelector('.foxy_variants_item-image') || {}).src || '',
        price: txt(el, '.foxy_variants_item-sale-price') || txt(el, '.foxy_variants_item-price'),
      };
      var label = '';
      for (var i = 0; i < VARIANT_ATTRS.length; i++) {
        var a = txt(el, '.foxy_variants_item-' + VARIANT_ATTRS[i]);
        if (a) { label = a; break; }
      }
      v.label = label || v.name;
      if (v.code) out.push(v);
    });
    return out;
  }

  function productImage() {
    var img = document.querySelector('#foxy-image');
    return img ? img.src : '';
  }

  function pageUrl() { return window.location.origin + window.location.pathname; }

  /* ─── UI ─────────────────────────────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('gd-bis-styles')) return;
    var css =
      '#gd-back-in-stock .gd-bis{border:2px solid ' + BRAND + ';border-left:6px solid ' + BRAND + ';border-radius:10px;padding:18px 20px;margin:20px 0;background:#eefaf2;box-shadow:0 2px 10px rgba(55,183,114,.18);font-family:inherit}' +
      '#gd-back-in-stock .gd-bis-title{font-weight:800;margin:0 0 4px;font-size:1.2rem;color:' + BRAND + ';display:flex;align-items:center;gap:8px}' +
      '#gd-back-in-stock .gd-bis-title::before{content:"";flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:' + BRAND + ';box-shadow:0 0 0 4px rgba(55,183,114,.25)}' +
      '#gd-back-in-stock .gd-bis-sub{margin:0 0 12px;color:#3a3a3a;font-size:.92rem}' +
      '#gd-back-in-stock .gd-bis-row{display:flex;flex-wrap:wrap;gap:8px}' +
      '#gd-back-in-stock select,#gd-back-in-stock input[type=email]{flex:1 1 220px;min-width:0;padding:10px 12px;border:1px solid #ccc;border-radius:8px;font-size:1rem;background:#fff}' +
      '#gd-back-in-stock button{background:' + BRAND + ';color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:1rem;font-weight:600;cursor:pointer}' +
      '#gd-back-in-stock button:disabled{opacity:.6;cursor:default}' +
      '#gd-back-in-stock .gd-bis-consent{display:flex;align-items:flex-start;gap:8px;margin-top:10px;color:#555;font-size:.85rem}' +
      '#gd-back-in-stock .gd-bis-consent input{margin-top:3px}' +
      '#gd-back-in-stock .gd-bis-msg{margin-top:10px;font-size:.9rem}' +
      '#gd-back-in-stock .gd-bis-msg.ok{color:' + BRAND + '}' +
      '#gd-back-in-stock .gd-bis-msg.err{color:#c0392b}';
    var s = document.createElement('style');
    s.id = 'gd-bis-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function container() {
    var c = document.getElementById('gd-back-in-stock');
    if (c) return c;
    // Fallback: inject after the Foxy add-to-cart form.
    var form = document.querySelector('#foxy-form');
    if (!form) return null;
    c = document.createElement('div');
    c.id = 'gd-back-in-stock';
    form.parentNode.insertBefore(c, form.nextSibling);
    return c;
  }

  /* Render the notify box for ONE out-of-stock target
   * ({code,label,name,image,price,itemType}). Re-rendering replaces any prior box,
   * so it's safe to call again whenever the shopper switches variants. */
  function render(target, subtitle) {
    var c = container();
    if (!c || !target) return;
    injectStyles();

    // NB: this widget can be embedded inside another <form> (Foxy's #foxy-form add-to-cart
    // form, or a Webflow Form Block). HTML forbids nested <form> elements, so we must NOT
    // render our own <form> — the browser silently drops it, hoisting our fields into the
    // surrounding form and making a type=submit button submit THAT form (Foxy's "re-select
    // your variant" popup, or Webflow's "Thank you! Your submission has been received!").
    // So: a plain <div>, a type=button button, and submission wired by hand (click + Enter).
    c.innerHTML =
      '<div class="gd-bis">' +
        '<p class="gd-bis-title">Out of stock — get notified</p>' +
        '<p class="gd-bis-sub">' + escapeHtml(subtitle || "Enter your email and we'll let you know the moment it's back.") + '</p>' +
        '<div class="gd-bis-form">' +
          '<div class="gd-bis-row">' +
            '<input type="email" id="gd-bis-email" placeholder="you@email.com" autocomplete="email" required>' +
            '<button type="button" id="gd-bis-submit">Notify me</button>' +
          '</div>' +
          '<label class="gd-bis-consent"><input type="checkbox" id="gd-bis-optin">' +
            '<span>Also email me about news &amp; offers from The Green Dragon.</span></label>' +
          '<div class="gd-bis-msg" id="gd-bis-msg" role="status"></div>' +
        '</div>' +
      '</div>';
    c.style.display = '';
    // Sold out → there's nothing to buy, so hide the purchase options (subscription +
    // one-time, both inside #dgc-sub-widget) while the notify box is shown.
    setPurchaseOptions(false);

    function go(e) { if (e) e.preventDefault(); submit(c, target); }
    var btn = c.querySelector('#gd-bis-submit');
    if (btn) btn.addEventListener('click', go);
    // Enter in the email field submits our widget; preventDefault stops it bubbling up
    // as an implicit submit of any surrounding Foxy / Webflow form.
    var emailEl = c.querySelector('#gd-bis-email');
    if (emailEl) emailEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) go(e);
    });
  }

  function hide() {
    var c = document.getElementById('gd-back-in-stock');
    if (c) { c.style.display = 'none'; c.innerHTML = ''; }
    // Back in (or never out of) stock → restore the normal purchase options.
    setPurchaseOptions(true);
  }

  // Show/hide the product's purchase options (subscription + one-time purchase),
  // which live together in #dgc-sub-widget. Passing false hides them (item sold out),
  // true restores them (revert to the element's CSS default display).
  function setPurchaseOptions(visible) {
    var w = document.getElementById('dgc-sub-widget');
    if (w) w.style.display = visible ? '' : 'none';
  }

  function submit(c, target) {
    var msg = c.querySelector('#gd-bis-msg');
    var btn = c.querySelector('#gd-bis-submit');
    var email = (c.querySelector('#gd-bis-email').value || '').trim();
    var optIn = c.querySelector('#gd-bis-optin').checked;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg(msg, 'err', 'Please enter a valid email.'); return; }

    btn.disabled = true;
    setMsg(msg, '', 'Saving…');

    fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        code: target.code,
        name: target.name,
        variantLabel: target.itemType === 'Variant' ? target.label : '',
        url: pageUrl(),
        image: target.image || productImage(),
        price: target.price,
        itemType: target.itemType,
        optIn: optIn,
      }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) {
          c.querySelector('.gd-bis-row').style.display = 'none';
          c.querySelector('.gd-bis-consent').style.display = 'none';
          setMsg(msg, 'ok', res.j.already
            ? "You're already on the list — we'll email you when it's back."
            : "You're on the list! We'll email you the moment it's back in stock.");
        } else {
          btn.disabled = false;
          setMsg(msg, 'err', (res.j && res.j.error) || 'Something went wrong. Please try again.');
        }
      })
      .catch(function () {
        btn.disabled = false;
        setMsg(msg, 'err', 'Network error. Please try again.');
      });
  }

  function setMsg(el, cls, text) { el.className = 'gd-bis-msg' + (cls ? ' ' + cls : ''); el.textContent = text; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  /* ─── Decide what (if anything) to show ───────────────────────────────────── */
  function init() {
    var product = readProduct();
    if (!product) return;

    // Discontinued products are never coming back — never offer a notify signup.
    if (isDiscontinued(product)) { hide(); return; }

    var variants = readVariants();

    var productTarget = {
      code: product.sku, label: product.name, name: product.name,
      image: productImage(), price: product.price, itemType: 'Product',
    };
    function variantTarget(v) {
      return { code: v.code, label: v.label, name: product.name, image: v.image, price: v.price, itemType: 'Variant' };
    }

    // No variants: show the product-level form only if the product itself is OOS.
    if (!variants.length) {
      if (isOOS(product)) render(productTarget);
      return;
    }

    // Discontinued individual options are excluded from everything below.
    var live = variants.filter(function (v) { return !isDiscontinued(v); });
    if (!live.length) { hide(); return; }

    var oos = live.filter(isOOS);
    if (!oos.length) { hide(); return; }             // every live option available

    if (oos.length === live.length) {                // every live option sold out
      render(productTarget, "This product is sold out. Enter your email and we'll let you know when it's restocked.");
      return;
    }

    // SOME live options sold out, others available. Don't list the sold-out options in a
    // dropdown of our own — instead follow the shopper's OWN variant selector: reveal
    // the notify box only when the option they've selected is out of stock (targeting
    // exactly that option), and hide it the moment they pick an in-stock option or
    // clear the selection. quickview dispatches these events on every change.
    //
    // quickview's event object does NOT carry the discontinued flag (or a normalized
    // label), so match the selected code back to our own readVariants() data by SKU.
    var byCode = {};
    variants.forEach(function (v) { if (v.code) byCode[v.code] = v; });

    document.addEventListener('dgc:variantSelected', function (e) {
      var sel = e && e.detail && e.detail.variant;
      var v = (sel && sel.code) ? byCode[sel.code] : null;
      if (v && isOOS(v) && !isDiscontinued(v)) {
        render(variantTarget(v), '"' + (v.label || 'This option') +
          '" is sold out — enter your email and we\'ll let you know when it\'s back.');
      } else {
        hide();
      }
    });
    document.addEventListener('dgc:variantCleared', hide);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
