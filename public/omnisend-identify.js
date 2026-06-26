/**
 * omnisend-identify.js
 *
 * Fires an `om_identify` dataLayer event as soon as the customer's email
 * (and optionally phone) is known, so the GTM "Omnisend - Identify Contact"
 * Custom HTML tag can call omnisend.identifyContact({ email, phone }).
 *
 * Four ways it identifies:
 *   1. Manual  — call window.omIdentify(email, phone) from anywhere you already
 *                have the email (e.g. an SSO callback or account page).
 *   2. Known   — reads the signed-in FoxyCart customer from localStorage
 *                (`fx.customer.details`), so returning/SSO customers are
 *                identified even when the email field is hidden/pre-filled.
 *   3. Checkout — wires the FoxyCart checkout email field (#customer_email) and
 *                fires once a valid address is entered or the field is pre-filled
 *                for a returning customer.
 *   4. Login   — wires any credential form (a form containing both an email field
 *                and a password field) and fires identify on submit. This catches
 *                the login page without needing its exact markup. Override the
 *                selectors via window.OM_IDENTIFY before this script loads, e.g.
 *                   <script>window.OM_IDENTIFY = {
 *                     emailSelector: '#login-email', formSelector: '#login-form'
 *                   };</script>
 *
 * Notes:
 *   - At least one of email/phone is required (Omnisend rule).
 *   - Phone must be E.164 (e.g. +13145551234); anything else is dropped.
 *   - Identical (email, phone) pairs are de-duped so we don't re-fire on every
 *     keystroke/blur.
 *
 * Load this wherever the email becomes known:
 *   - FoxyCart checkout (custom-checkout-template.html) — for checkout email
 *   - The Webflow login page — auto-wired via the credential-form heuristic
 *   - Any account page — then call omIdentify(...) with the email
 */
(function () {
  'use strict';

  var lastKey = '';

  function isEmail(v) {
    return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  }

  // Returns the value only if it's valid E.164, else '' (so we never send junk).
  function toE164(v) {
    if (!v) return '';
    var s = String(v).trim();
    return /^\+[1-9]\d{6,14}$/.test(s) ? s : '';
  }

  function omIdentify(email, phone) {
    email = isEmail(email) ? email.trim().toLowerCase() : '';
    phone = toE164(phone);
    if (!email && !phone) return;          // need at least one identifier

    var key = email + '|' + phone;
    if (key === lastKey) return;           // already identified with this data
    lastKey = key;

    var payload = { event: 'om_identify' };
    if (email) payload.om_email = email;
    if (phone) payload.om_phone = phone;

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
  }

  // Expose for manual identification (account pages, SSO callbacks, etc.).
  window.omIdentify = omIdentify;

  var CFG = window.OM_IDENTIFY || {};

  // ── Auto-wire: FoxyCart checkout email field ────────────────────────────────
  // <input type="email" id="customer_email" name="customer_email">
  function wireCheckoutEmail() {
    var sel = CFG.checkoutSelector || '#customer_email';
    var input = document.querySelector(sel);
    if (!input) return;

    var fire = function () { omIdentify(input.value); };
    input.addEventListener('change', fire);
    input.addEventListener('blur', fire);

    // Returning customer / pre-filled email: capture it on load.
    if (input.value) fire();
  }

  // ── Auto-wire: known FoxyCart customer (checkout / logged in) ───────────────
  // FoxyCart stores the signed-in customer in localStorage as
  // `fx.customer.details`. This identifies returning/SSO customers whose email
  // is known even when the email field is hidden or pre-filled.
  function wireKnownCustomer() {
    try {
      var raw = localStorage.getItem('fx.customer.details');
      if (!raw) return;
      var details = JSON.parse(raw);
      if (details && details.email) omIdentify(details.email, details.phone);
    } catch (e) { /* ignore */ }
  }

  // ── Auto-wire: login page ───────────────────────────────────────────────────
  // Identify on submit of any credential form. A "credential form" is one that
  // contains both an email field and a password field — which reliably matches
  // the login page regardless of its Webflow markup. Override with
  // window.OM_IDENTIFY.{formSelector, emailSelector} if your form differs.
  function wireLoginForms() {
    var forms;
    if (CFG.formSelector) {
      forms = document.querySelectorAll(CFG.formSelector);
    } else {
      forms = Array.prototype.filter.call(
        document.querySelectorAll('form'),
        function (f) { return f.querySelector('input[type="password"]'); }
      );
    }

    Array.prototype.forEach.call(forms, function (form) {
      form.addEventListener('submit', function () {
        var emailEl = form.querySelector(
          CFG.emailSelector || 'input[type="email"], input[name="email"]'
        );
        if (emailEl) omIdentify(emailEl.value);
      });
    });
  }

  function init() {
    wireKnownCustomer();
    wireCheckoutEmail();
    wireLoginForms();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
