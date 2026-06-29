/**
 * omnisend-started-checkout.js
 *
 * Fires the `om_begin_checkout` dataLayer event when the FoxyCart checkout page
 * opens, so the GTM "Omnisend – Started Checkout" tag (Tag 5 in
 * GTM-Omnisend-Setup.md) can send Omnisend's `started checkout` event — which
 * CANCELS the cart-abandonment automation for shoppers who reach checkout.
 *
 * Where to load: on the FoxyCart checkout (custom-checkout-template.html), the
 * same place the Omnisend base snippet and omnisend-identify.js run. Reads the
 * live cart from FoxyCart's FC.json (available on the checkout domain).
 *
 * Why here and not on the cart's "Proceed to Checkout" click: that click is a
 * full page navigation (target="_top"), which can cut off the tracking beacon
 * before it sends. Firing on the loaded checkout page has no such race.
 *   → If GTM/the Omnisend snippet do NOT run on the FoxyCart checkout domain,
 *     move this to the storefront and fire it on the checkout hand-off instead;
 *     the server-side `placed order` (foxy-order-sync) still closes the loop.
 *
 * Units: cart-event amounts are DECIMAL DOLLARS (e.g. 49.99) per Omnisend's
 * cart-event API — do not convert to cents here.
 *
 * Fires once per cart session (sessionStorage-guarded) so a reload or a
 * step-back on checkout doesn't re-send.
 */
(function () {
  'use strict';

  var FIRED_PREFIX = 'om_begin_checkout_';

  function itemsArray(items) {
    if (!items) return [];
    return Array.isArray(items)
      ? items
      : Object.keys(items).map(function (k) { return items[k]; });
  }

  function buildLineItems(items) {
    return itemsArray(items).map(function (it) {
      return {
        productID: String(it.code || it.id || ''),
        productTitle: it.name,
        productPrice: Number(it.price) || 0,            // dollars
        productQuantity: parseInt(it.quantity, 10) || 1,
        productImageURL: it.image || undefined,
        productURL: it.url || undefined
      };
    });
  }

  function fire() {
    var json = window.FC && FC.json;
    if (!json) return false;                            // FoxyCart not ready yet

    var items = json.items;
    if (itemsArray(items).length === 0) return false;   // nothing to report

    var domain   = (json.config && json.config.store_domain) || window.location.hostname;
    var sessName = json.session_name || '';
    var sessId   = json.session_id || '';
    var cartID   = String(sessId || json.id || '');

    // Fire once per cart session.
    var firedKey = FIRED_PREFIX + cartID;
    try { if (sessionStorage.getItem(firedKey)) return true; } catch (e) {}

    // The link that restores THIS cart — Omnisend's abandonedCheckoutURL.
    var recoverURL = 'https://' + domain + '/cart?' +
      (sessName && sessId
        ? encodeURIComponent(sessName) + '=' + encodeURIComponent(sessId)
        : '');

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'om_begin_checkout',
      om_cart: {
        cartID: cartID,
        value: Number(json.total_order || json.total_item_price || 0) || 0,
        currency: json.currency_code || 'USD',
        abandonedCheckoutURL: recoverURL,
        lineItems: buildLineItems(items)
      }
    });

    try { sessionStorage.setItem(firedKey, '1'); } catch (e) {}
    return true;
  }

  function init() {
    if (fire()) return;

    // FC.json may not be populated at DOMContentLoaded — retry briefly and also
    // bind to FoxyCart's own cart-ready events.
    var tries = 0;
    var poll = setInterval(function () {
      if (fire() || ++tries > 50) clearInterval(poll);  // ~10s max
    }, 200);

    if (window.FC && FC.client && typeof FC.client.on === 'function') {
      try { FC.client.on('ready.done', fire); } catch (e) {}
      try { FC.client.on('loaded.done', fire); } catch (e) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
