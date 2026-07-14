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
      '#gd-back-in-stock .gd-bis{border:1px solid #e2e2e2;border-radius:10px;padding:16px 18px;margin:16px 0;background:#fafafa;font-family:inherit}' +
      '#gd-back-in-stock .gd-bis-title{font-weight:700;margin:0 0 4px;font-size:1.05rem}' +
      '#gd-back-in-stock .gd-bis-sub{margin:0 0 12px;color:#555;font-size:.9rem}' +
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

  /* Render the widget. `targets` is a list of {code,label,name,image,price,itemType}.
   * One target → simple email form. Many → a chooser of the sold-out options. */
  function render(targets, subtitle) {
    var c = container();
    if (!c || !targets.length) return;
    injectStyles();

    var many = targets.length > 1;
    var optionsHtml = '';
    if (many) {
      optionsHtml = '<select id="gd-bis-target" aria-label="Choose a sold-out option">' +
        '<option value="" disabled selected>Choose an option…</option>' +
        targets.map(function (t, i) {
          return '<option value="' + i + '">' + escapeHtml(t.label || t.name) + '</option>';
        }).join('') + '</select>';
    }

    c.innerHTML =
      '<div class="gd-bis">' +
        '<p class="gd-bis-title">Out of stock — get notified</p>' +
        '<p class="gd-bis-sub">' + escapeHtml(subtitle || "Enter your email and we'll let you know the moment it's back.") + '</p>' +
        '<form class="gd-bis-form" novalidate>' +
          '<div class="gd-bis-row">' +
            optionsHtml +
            '<input type="email" id="gd-bis-email" placeholder="you@email.com" autocomplete="email" required>' +
            '<button type="submit" id="gd-bis-submit">Notify me</button>' +
          '</div>' +
          '<label class="gd-bis-consent"><input type="checkbox" id="gd-bis-optin">' +
            '<span>Also email me about news &amp; offers from The Green Dragon.</span></label>' +
          '<div class="gd-bis-msg" id="gd-bis-msg" role="status"></div>' +
        '</form>' +
      '</div>';
    c.style.display = '';

    var form = c.querySelector('.gd-bis-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submit(c, targets, many);
    });

    // If the shopper picks a variant in the product's own selector, pre-select the
    // matching sold-out option here (progressive enhancement; no-op if it never fires).
    c._targets = targets;
    c._preselect = function (code) {
      var sel = c.querySelector('#gd-bis-target');
      if (!sel) return;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].code === code) { sel.value = String(i); break; }
      }
    };
  }

  function hide() {
    var c = document.getElementById('gd-back-in-stock');
    if (c) { c.style.display = 'none'; c.innerHTML = ''; }
  }

  function submit(c, targets, many) {
    var msg = c.querySelector('#gd-bis-msg');
    var btn = c.querySelector('#gd-bis-submit');
    var email = (c.querySelector('#gd-bis-email').value || '').trim();
    var optIn = c.querySelector('#gd-bis-optin').checked;

    var target = targets[0];
    if (many) {
      var idx = c.querySelector('#gd-bis-target').value;
      if (idx === '') { setMsg(msg, 'err', 'Please choose which option you want.'); return; }
      target = targets[Number(idx)];
    }
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
    var variants = readVariants();

    var toTarget = {
      product: {
        code: product.sku, label: product.name, name: product.name,
        image: productImage(), price: product.price, itemType: 'Product',
      },
      variant: function (v) {
        return { code: v.code, label: v.label, name: product.name, image: v.image, price: v.price, itemType: 'Variant' };
      },
    };

    if (!variants.length) {
      if (isOOS(product)) render([toTarget.product]);
      return;
    }

    var oos = variants.filter(isOOS);
    if (!oos.length) { hide(); return; }             // everything available

    if (oos.length === variants.length) {            // whole product sold out
      render([toTarget.product], "This product is sold out. Enter your email and we'll let you know when it's restocked.");
      return;
    }

    // Some options sold out — offer a chooser of just those.
    render(oos.map(toTarget.variant),
      "Some options are sold out. Pick one and we'll email you when it's back.");

    // Sync the chooser with the product's own variant selector when possible.
    document.addEventListener('dgc:variantSelected', function (e) {
      var v = e && e.detail && e.detail.variant;
      var c = document.getElementById('gd-back-in-stock');
      if (v && v.code && c && c._preselect) c._preselect(v.code);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
