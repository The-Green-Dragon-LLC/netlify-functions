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
 * Detection: the ONLY trigger is FoxyCart's `add.done` event, which fires when
 * an add-to-cart request completes — never on a plain page load. We diff
 * FC.json against the previous snapshot only to name the item that was added;
 * the event itself is the signal that an add happened, so we always fire on it.
 *
 *   IMPORTANT: do NOT fire on `loaded.done` or a poll. Those run on every page
 *   load (FoxyCart re-fetches the cart), so firing on them reports every
 *   pre-existing cart item as a new add on every page. `loaded.done` is used
 *   here only to silently keep the baseline snapshot current.
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

  var prev = {}; // last-seen qty-by-key; only used to identify the added line

  // Silently refresh the baseline (page load, cart reload, removals). Never fires.
  function syncBaseline() {
    var json = window.FC && FC.json;
    if (json) prev = snapshot(itemsArray(json.items));
  }

  // Called ONLY from add.done — an add definitely happened, so always fire.
  function onAddDone() {
    var json = window.FC && FC.json;
    if (!json) return;

    var arr = itemsArray(json.items);
    var cur = snapshot(arr);

    // Best-effort: the line whose qty rose since the last snapshot is the add.
    var addedKey = null;
    for (var k in cur) {
      if (cur[k] > (prev[k] || 0)) addedKey = k;
    }
    prev = cur;

    var addedObj = null;
    if (addedKey) {
      for (var i = 0; i < arr.length; i++) {
        if (itemKey(arr[i]) === addedKey) { addedObj = arr[i]; break; }
      }
    }

    var common = cartCommon(json);
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'om_add_to_cart',
      om_cart: {
        cartID: common.cartID,
        value: common.value,
        currency: common.currency,
        abandonedCheckoutURL: common.abandonedCheckoutURL,
        addedItem: addedObj ? buildItem(addedObj) : undefined,  // Tag 4 falls back to lineItems[0]
        lineItems: arr.map(buildItem)
      }
    });
  }

  function attach() {
    if (!window.FC || !FC.client || typeof FC.client.on !== 'function') {
      setTimeout(attach, 150);
      return;
    }

    syncBaseline(); // seed baseline from whatever is loaded so far

    try { FC.client.on('add.done', onAddDone); } catch (e) {}
    // Keep the baseline fresh on cart (re)loads WITHOUT firing — this is what
    // prevents the "fires on every page" bug.
    try { FC.client.on('loaded.done', syncBaseline); } catch (e) {}
    try { FC.client.on('ready.done', syncBaseline); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
}());
