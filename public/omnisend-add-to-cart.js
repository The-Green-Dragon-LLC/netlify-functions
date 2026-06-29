/**
 * omnisend-add-to-cart.js
 *
 * Fires the `om_add_to_cart` dataLayer event whenever an item is added to the
 * FoxyCart cart, so the GTM "Omnisend – Added To Cart" tag (Tag 4 in
 * GTM-Omnisend-Setup.md) can send Omnisend's `added product to cart` event —
 * which STARTS the cart-abandonment automation clock.
 *
 * Where to load: site-wide, in the Webflow footer (same place as
 * crossell-popup.js). Adds happen on product pages, the sidecart, and the
 * cross-sell popup — a site-wide listener catches them all.
 *
 * Detection: binds FoxyCart's `add.done` event and also runs a short backup
 * poll, diffing FC.json against the previous snapshot to find what was just
 * added. (FoxyCart's add event doesn't hand us the item, so we diff — the same
 * approach crossell-popup.js uses.) prev is updated on every detection, so the
 * event path and the poll can't double-fire the same add.
 *
 * Units: cart-event amounts are DECIMAL DOLLARS (e.g. 49.99) per Omnisend's
 * cart-event API — do not convert to cents here.
 */
(function () {
  'use strict';

  function itemsArray(items) {
    if (!items) return [];
    return Array.isArray(items)
      ? items
      : Object.keys(items).map(function (k) { return items[k]; });
  }

  // Stable key for an item line (variant code preferred, then Foxy item id).
  function itemKey(it) {
    return String(it.code || it.id || '');
  }

  function qtyOf(it) {
    return parseInt(it && it.quantity, 10) || 0;
  }

  function buildItem(it) {
    return {
      productID: itemKey(it),
      productTitle: it.name,
      productPrice: Number(it.price) || 0,            // dollars
      productImageURL: it.image || undefined,
      productURL: it.url || undefined,
      productQuantity: qtyOf(it) || 1
    };
  }

  // The cart-level fields shared by every cart event.
  function cartCommon(json) {
    var domain   = (json.config && json.config.store_domain) || window.location.hostname;
    var sessName = json.session_name || '';
    var sessId   = json.session_id || '';
    var recover  = 'https://' + domain + '/cart?' +
      (sessName && sessId
        ? encodeURIComponent(sessName) + '=' + encodeURIComponent(sessId)
        : '');
    return {
      cartID: String(sessId || json.id || ''),
      value: Number(json.total_order || json.total_item_price || 0) || 0,
      currency: json.currency_code || 'USD',
      abandonedCheckoutURL: recover
    };
  }

  // Map of itemKey -> total quantity for the current cart.
  function snapshot(arr) {
    var map = {};
    for (var i = 0; i < arr.length; i++) {
      var k = itemKey(arr[i]);
      map[k] = (map[k] || 0) + qtyOf(arr[i]);
    }
    return map;
  }

  var prev = null; // baseline qty-by-key; null until first read

  function detectAndFire() {
    var json = window.FC && FC.json;
    if (!json) return;

    var arr = itemsArray(json.items);
    var cur = snapshot(arr);

    if (prev === null) { prev = cur; return; } // baseline: ignore pre-existing items

    // Keys whose quantity increased since last snapshot = what was just added.
    var addedKeys = [];
    for (var k in cur) {
      if (cur[k] > (prev[k] || 0)) addedKeys.push(k);
    }
    prev = cur;
    if (!addedKeys.length) return;

    // Use the last increased line as the "added item"; full cart goes in lineItems.
    var addedKey = addedKeys[addedKeys.length - 1];
    var addedObj = null;
    for (var i = 0; i < arr.length; i++) {
      if (itemKey(arr[i]) === addedKey) { addedObj = arr[i]; break; }
    }

    var common = cartCommon(json);
    var omCart = {
      cartID: common.cartID,
      value: common.value,
      currency: common.currency,
      abandonedCheckoutURL: common.abandonedCheckoutURL,
      addedItem: addedObj ? buildItem(addedObj) : undefined,
      lineItems: arr.map(buildItem)
    };

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: 'om_add_to_cart', om_cart: omCart });
  }

  function attach() {
    if (!window.FC || !FC.json) {
      setTimeout(attach, 150);
      return;
    }

    // Establish the baseline so items already in the cart on load don't fire.
    detectAndFire();

    // Primary: FoxyCart's add event. (FC.json is updated by the time it fires.)
    if (FC.client && typeof FC.client.on === 'function') {
      try { FC.client.on('add.done', detectAndFire); } catch (e) {}
      try { FC.client.on('loaded.done', detectAndFire); } catch (e) {}
    }

    // Backup: brief poll catches adds the event path may miss. prev-tracking
    // means this can't re-fire an add already reported by the event.
    var tries = 0;
    var poll = setInterval(function () {
      detectAndFire();
      if (++tries > 120) clearInterval(poll); // ~60s, mirrors crossell-popup.js
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
}());
