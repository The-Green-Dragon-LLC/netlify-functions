/**
 * manage-subscriptions.js  —  Green Dragon customer-portal enhancements
 * ─────────────────────────────────────────────────────────────────────────────
 * Loaded from Netlify and referenced by a small <script src> tag inside the
 * Webflow "Manage Subscriptions" page (the page Foxy's Customer Portal URL
 * points at). It enhances the embedded <foxy-customer-portal> with a branded
 * action panel: Ship Now, Skip Next, Change Frequency, Change Address, Pause /
 * Resume — plus the existing Modify Items + Cancel controls.
 *
 * Subscription changes are performed by the manage-subscription Netlify function
 * (OAuth + sub_token ownership check). See netlify-functions/functions.
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  /* Netlify function that performs subscription changes server-side (OAuth +
   * sub_token ownership check).
   * Auto-derived from this script's own src so the correct function is called on
   * both the develop deploy and production — no manual URL updates needed
   * (same pattern as crossell-popup.js). */
  var GD_MANAGE_FN = (function () {
    try {
      var s = document.currentScript;
      if (!s) {
        var all = document.getElementsByTagName('script');
        s = all[all.length - 1];
      }
      if (s && s.src) {
        var base = s.src.replace(/\/[^\/]*$/, '');
        return base + '/.netlify/functions/manage-subscription';
      }
    } catch (e) { /* ignore */ }
    return 'https://wondrous-bublanina-d440ec.netlify.app/.netlify/functions/manage-subscription';
  })();

  /* A subscription whose next charge is more than this many days out is treated
   * as "paused" (the pause action pushes the date ~5 years into the future). */
  var PAUSE_DETECT_DAYS = 730;

  /* Frequencies customers may choose (must match the function's allow-list). */
  var FREQ_OPTIONS = [
    { value: '1w', label: 'Weekly' },
    { value: '2w', label: 'Every 2 weeks' },
    { value: '1m', label: 'Monthly' }
  ];

  var portal = null; /* set by boot() once the web component is in the DOM */

  function subTokenFromUrl(href) {
    if (!href) return null;
    try { return new URL(href).searchParams.get('sub_token'); }
    catch (e) {
      var m = /[?&]sub_token=([^&]+)/.exec(href);
      return m ? decodeURIComponent(m[1]) : null;
    }
  }

  /* Days from today until a Foxy date string (negative = past). */
  function daysUntil(dateStr) {
    if (!dateStr) return 0;
    var then = new Date(dateStr.slice(0, 10) + 'T00:00:00Z').getTime();
    var now  = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    return Math.round((then - now) / 86400000);
  }

  /* ════════════════════════════════════════════════════════════════════════
   * deepQueryAll — cross-shadow-DOM querySelectorAll
   *
   * portal.shadowRoot.querySelectorAll() does NOT pierce into nested web
   * component shadow roots.  foxy-subscription-card lives at least 2 levels
   * deep (portal → foxy-collection-pages → foxy-collection-page → card).
   * This helper recurses into every open shadow root it finds.
   * ════════════════════════════════════════════════════════════════════════ */
  function deepQueryAll(root, selector) {
    if (!root) return [];
    var found = Array.prototype.slice.call(root.querySelectorAll(selector));
    Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function (el) {
      if (el.shadowRoot) found = found.concat(deepQueryAll(el.shadowRoot, selector));
    });
    return found;
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 1. EDIT PANEL — read data from rendered subscription cards
   *
   *    sub_token is NOT a top-level property.  FoxyCart exposes the fully
   *    formed cart URL in _links['fx:sub_token_url'].href — use that directly.
   * ════════════════════════════════════════════════════════════════════════ */
  var _panelBuilt = false;

  function readCardsAndRenderPanel() {
    if (!portal.shadowRoot) return;

    var cards = deepQueryAll(portal.shadowRoot, 'foxy-subscription-card');
    if (!cards.length) return;

    /* Wait until EVERY native card has loaded its data before building the panel
     * and hiding the native list. hideNativeSubscriptions() hides the whole
     * collection container, so a card that hadn't loaded yet would be hidden
     * without ever appearing in the branded panel — dropping a subscription. */
    var allLoaded = cards.every(function (c) { return !!c.data; });
    if (!allLoaded) return;

    var panelItems = [];
    var handledCards = [];

    cards.forEach(function (card) {
      var d = card.data;
      if (!d) return; /* not yet loaded */

      /* Status buckets:
       *   inactive — already ended (is_active === false). Not manageable.
       *   ending   — still active but a future end_date is set (pending cancel).
       *   (cancelled = either of the above; used to gate management actions). */
      var isInactive  = d.is_active === false;
      var isEnding    = !isInactive && d.end_date && !d.end_date.startsWith('0000');
      var isCancelled = isInactive || isEnding;

      var editUrl = d._links &&
                    d._links['fx:sub_token_url'] &&
                    d._links['fx:sub_token_url'].href;

      /* Active subs with no edit URL are unexpected — skip them */
      if (!isCancelled && !editUrl) return;

      var cancelUrl = editUrl ? editUrl + '&sub_cancel=1' : null;

      /* Self link + token drive the manage-subscription function. */
      var subUri   = d._links && d._links.self && d._links.self.href;
      var subToken = subTokenFromUrl(editUrl);

      /* Paused = active, not cancelled, but next charge pushed far out. */
      var isPaused = !isCancelled &&
                     d.next_transaction_date &&
                     daysUntil(d.next_transaction_date) > PAUSE_DETECT_DAYS;

      /* Product name from transaction template items */
      var name    = 'Your Subscription';
      var endDate = d.end_date ? formatDate(d.end_date) : null;
      var nextDate = (!isCancelled && !isPaused && d.next_transaction_date)
                     ? formatDate(d.next_transaction_date) : '—';

      var tmpl      = d._embedded && d._embedded['fx:transaction_template'];
      var tmplItems = (tmpl && tmpl._embedded && tmpl._embedded['fx:items']) || [];
      var dirItems  = (d._embedded && d._embedded['fx:items']) || [];
      var firstItem = tmplItems[0] || dirItems[0];
      if (firstItem && firstItem.name) name = firstItem.name;

      /* Current shipping address (from the transaction template) to prefill the
       * address form. Fields fall back to empty strings. */
      var addr = {
        first_name:  (tmpl && tmpl.shipping_first_name)  || '',
        last_name:   (tmpl && tmpl.shipping_last_name)   || '',
        address1:    (tmpl && tmpl.shipping_address1)    || '',
        address2:    (tmpl && tmpl.shipping_address2)    || '',
        city:        (tmpl && tmpl.shipping_city)        || '',
        region:      (tmpl && tmpl.shipping_state)       || '',
        postal_code: (tmpl && tmpl.shipping_postal_code) || '',
        country:     (tmpl && tmpl.shipping_country)     || ''
      };

      panelItems.push({
        editUrl:     isCancelled ? null : editUrl,
        cancelUrl:   isCancelled ? null : cancelUrl,
        subUri:      subUri,
        subToken:    subToken,
        frequency:   d.frequency || '',
        name:        name,
        nextDate:    nextDate,
        cancelled:   isCancelled,
        inactive:    isInactive,
        ending:      isEnding,
        paused:      isPaused,
        endDate:     endDate,
        address:     addr
      });
      handledCards.push(card); /* hide the native card once its data is read */
    });

    if (panelItems.length) {
      renderPanel(panelItems);
      _panelBuilt = true;
      /* The branded panel now mirrors every native subscription card, so hide
       * the native list to avoid showing each subscription twice. */
      hideNativeSubscriptions(handledCards);
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 1b. HIDE THE NATIVE SUBSCRIPTIONS LIST
   *
   *    The branded panel duplicates every native card, so collapse the native
   *    list. We hide (display:none) rather than remove so the cards stay in the
   *    DOM and keep their fetched .data available to the panel.
   *
   *    Hiding just the inner card empties it but leaves its bordered wrapper +
   *    the collection/pagination chrome behind as empty boxes. So we also hide
   *    the enclosing <foxy-collection-pages> (portal → foxy-collection-pages →
   *    foxy-collection-page → card). Order history is already removed from this
   *    page via hiddencontrols (customer:transactions), so the subscriptions
   *    collection is the only foxy-collection-pages present — we can hide it
   *    directly without a fragile card-detection check (that check failed when
   *    the cards are slotted rather than living in the collection's shadow root).
   *
   *    Belt-and-suspenders: also climb each card's ancestors and hide any
   *    foxy-collection-* wrapper, covering portal layouts that differ.
   * ════════════════════════════════════════════════════════════════════════ */
  function hideNativeSubscriptions(cards) {
    (cards || []).forEach(function (card) {
      card.style.display = 'none';
      /* Climb through parent elements and shadow-root hosts, hiding any
       * Foxy collection wrapper so no empty bordered box is left behind. */
      var node = card;
      for (var i = 0; i < 10 && node && node !== document; i++) {
        var tag = (node.tagName || '').toLowerCase();
        if (tag.indexOf('foxy-collection') === 0 && node.style) {
          node.style.display = 'none';
        }
        var next = node.parentElement;
        if (!next) {
          var root = node.getRootNode && node.getRootNode();
          next = root && root.host;
        }
        node = next;
      }
    });

    if (!portal.shadowRoot) return;
    deepQueryAll(portal.shadowRoot, 'foxy-collection-pages').forEach(function (coll) {
      coll.style.display = 'none';
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 2. POPUP STYLING — inject into the shadow root that contains the form
   *
   *    foxy-subscription-form lives inside a nested shadow root.
   *    form.getRootNode() gives us exactly that shadow root — injecting CSS
   *    there targets the positioned panel that wraps the form directly,
   *    regardless of which Tailwind classes FoxyCart uses.
   * ════════════════════════════════════════════════════════════════════════ */
  function styleDetailPanel() {
    /* foxy-subscription-form lives inside foxy-dialog-window which is
     * appended to document.body — outside the portal's shadow DOM.
     * Search from document.body so we can find it. */
    deepQueryAll(document.body, 'foxy-subscription-form').forEach(function (form) {
      var formRoot = form.getRootNode();
      if (!(formRoot instanceof ShadowRoot) || formRoot._dgcStyled) return;
      formRoot._dgcStyled = true;

      var s = document.createElement('style');
      s.textContent = [
        /* Panel wrapper: override ml-auto right-alignment → centered fixed modal.
         * Must override both width AND max-width — sm-max-w-modal sets max-width
         * which would otherwise clamp the panel regardless of the width rule. */
        '[class~="sm-max-w-modal"] {',
        '  position:fixed!important; inset:auto!important;',
        '  top:50%!important; left:50%!important;',
        '  transform:translate(-50%,-50%)!important;',
        '  height:85vh!important;',
        '  width:min(720px,92vw)!important;',
        '  max-width:min(720px,92vw)!important;',
        '  margin:0!important; z-index:9999!important;',
        '}',
        /* Content box: nicer radius and shadow now that it's centered */
        '[class~="bg-base"][class~="rounded-t-l"] {',
        '  border-radius:12px!important;',
        '  box-shadow:0 25px 65px rgba(0,0,0,.22)!important;',
        '}',
      ].join('\n');
      formRoot.appendChild(s);

      console.log('[DGC] Popup styles injected. Shadow host:', formRoot.host && formRoot.host.tagName);
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 3. RELABEL DIALOG BUTTONS
   *    foxy-subscription-form renders "End membership" inside its own shadow
   *    DOM.  Walk every text node inside foxy-dialog-window and swap the label.
   * ════════════════════════════════════════════════════════════════════════ */
  function relabelDialogButtons() {
    document.querySelectorAll('foxy-dialog-window').forEach(function (dialog) {
      if (!dialog.shadowRoot) return;
      /* Walk all text nodes anywhere in this shadow tree */
      (function walk(root) {
        var iter = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while ((node = iter.nextNode())) {
          if (node.nodeValue && node.nodeValue.trim() === 'End membership') {
            node.nodeValue = node.nodeValue.replace('End membership', 'Cancel subscription');
          }
        }
        /* Recurse into nested shadow roots */
        root.querySelectorAll('*').forEach(function (el) {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      })(dialog.shadowRoot);
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 4. LABEL CANCELLED TRANSACTIONS IN ORDER HISTORY
   *    FoxyCart creates a $0 transaction of type 'subscription_cancellation'
   *    when a subscription is cancelled.  We inject a red "CANCELLED" badge
   *    into each such transaction card's shadow root.
   * ════════════════════════════════════════════════════════════════════════ */
  function labelCancelledTransactions() {
    if (!portal.shadowRoot) return;
    deepQueryAll(portal.shadowRoot, 'foxy-transaction-card').forEach(function (card) {
      if (card._dgcTxLabelled) return;
      var d = card.data;
      if (!d || d.type !== 'subscription_cancellation') return;
      if (!card.shadowRoot) return;
      card._dgcTxLabelled = true;

      var s = document.createElement('style');
      s.textContent = ':host{position:relative!important;} .dgc-tx-badge{position:absolute;top:10px;right:10px;background:#c62828;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.6px;padding:2px 7px;border-radius:3px;text-transform:uppercase;font-family:Lato,sans-serif;pointer-events:none;z-index:5;}';
      card.shadowRoot.appendChild(s);

      var badge = document.createElement('div');
      badge.className = 'dgc-tx-badge';
      badge.textContent = 'Cancelled';
      card.shadowRoot.appendChild(badge);
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 5. CLICK LISTENERS ON SUBSCRIPTION CARDS
   *    foxy-subscription-form only enters the DOM after the user clicks a
   *    subscription card.  We attach a click listener to each card so we can
   *    run styleDetailPanel right after the click (with a short delay to let
   *    Lit render the form into the shadow root first).
   * ════════════════════════════════════════════════════════════════════════ */
  var _cardListenersAttached = false;

  function attachCardClickListeners() {
    if (!portal.shadowRoot) return;
    var cards = deepQueryAll(portal.shadowRoot, 'foxy-subscription-card');
    if (!cards.length || _cardListenersAttached) return;
    _cardListenersAttached = true;
    cards.forEach(function (card) {
      card.addEventListener('click', function () {
        /* Lit needs a tick to render the form into shadow DOM after click */
        setTimeout(function () { styleDetailPanel(); relabelDialogButtons(); }, 50);
        setTimeout(function () { styleDetailPanel(); relabelDialogButtons(); }, 200);
        setTimeout(function () { styleDetailPanel(); relabelDialogButtons(); }, 500);
      });
    });
    console.log('[DGC] Click listeners attached to', cards.length, 'subscription card(s).');
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 6. POLLING LOOP
   *    Runs every 500 ms for up to 60 s.  Stops building the panel once
   *    data is found; keeps styleDetailPanel running in case the form was
   *    already open when the listener attached.
   * ════════════════════════════════════════════════════════════════════════ */
  function startPolling() {
    var _tick = 0;
    var _poll = setInterval(function () {
      if (++_tick > 120) { clearInterval(_poll); return; }
      if (!_panelBuilt) readCardsAndRenderPanel();
      if (!_cardListenersAttached) attachCardClickListeners();
      styleDetailPanel();
      relabelDialogButtons();
      labelCancelledTransactions();
    }, 500);
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 7. RENDER EDIT PANEL CARDS
   * ════════════════════════════════════════════════════════════════════════ */
  function renderPanel(items) {
    var panel = document.getElementById('dgc-sub-edit-panel');
    if (!panel) return;

    var heading = panel.querySelector('h3');
    panel.innerHTML = '';
    if (heading) panel.appendChild(heading);

    if (!items.length) { panel.style.display = 'none'; return; }

    items.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'dgc-sub-card' +
        (item.cancelled ? ' dgc-sub-card--cancelled' : '') +
        (item.paused ? ' dgc-sub-card--paused' : '');

      /* Stash the data the action handlers need on the card element itself. */
      if (item.subUri)   card.dataset.subUri = item.subUri;
      if (item.subToken) card.dataset.subToken = item.subToken;
      card.dataset.frequency = item.frequency || '';
      card.dataset.address   = JSON.stringify(item.address || {});

      var badge =
        item.inactive ? '<span class="dgc-sub-badge-cancelled">Inactive</span>' :
        item.ending   ? '<span class="dgc-sub-badge-cancelled">Ending Soon</span>' :
        item.paused   ? '<span class="dgc-sub-badge-paused">Paused</span>' : '';

      var nameRow =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
          '<p class="dgc-sub-card-name" style="margin:0;">' + esc(item.name) + '</p>' +
          badge +
        '</div>';

      var freqText = formatFrequency(item.frequency);

      var dateRow;
      if (item.inactive) {
        dateRow = '<p class="dgc-sub-card-end">Ended' + (item.endDate ? ' on ' + esc(item.endDate) : '') + '</p>';
      } else if (item.ending && item.endDate) {
        dateRow = '<p class="dgc-sub-card-end">Ends on ' + esc(item.endDate) +
                  (freqText ? ' &middot; ' + esc(freqText) : '') + '</p>';
      } else if (item.paused) {
        dateRow = '<p class="dgc-sub-card-paused-note">Paused — you won\'t be charged until you resume.' +
                  (freqText ? ' Normal schedule: ' + esc(freqText) + '.' : '') + '</p>';
      } else {
        dateRow = '<p class="dgc-sub-card-next">Next payment: ' + esc(item.nextDate) +
                  (freqText ? ' &middot; ' + esc(freqText) : '') + '</p>';
      }

      var actions;
      if (item.cancelled) {
        actions = '';
      } else if (item.paused) {
        /* Paused: offer Resume (+ keep Cancel available). */
        actions =
          '<div class="dgc-sub-card-actions">' +
            '<button class="dgc-btn-action dgc-btn-resume" data-action="resume">Resume Subscription</button>' +
            '<button class="dgc-btn-cancel" data-action="cancel-prompt">Cancel Subscription</button>' +
          '</div>';
      } else {
        /* Active: full set of self-service controls.
         * Cancel uses a data attribute (not <a href>) so FoxyCart's sidecart JS
         * cannot intercept the navigation. */
        actions =
          '<div class="dgc-sub-card-actions">' +
            '<button class="dgc-btn-action" data-action="ship-now">Ship Now</button>' +
            '<button class="dgc-btn-action" data-action="skip">Skip Next</button>' +
            '<button class="dgc-btn-action" data-action="change-frequency">Change Frequency</button>' +
            '<button class="dgc-btn-action" data-action="change-address">Change Address</button>' +
            '<button class="dgc-btn-action" data-action="pause">Pause</button>' +
            '<a href="' + esc(item.editUrl) + '" class="dgc-btn-edit">Modify Items</a>' +
            '<button class="dgc-btn-cancel" data-action="cancel-prompt">Cancel Subscription</button>' +
          '</div>';
      }

      card.innerHTML = nameRow + dateRow + actions +
        '<div class="dgc-sub-inline" style="display:none;"></div>' +
        '<div class="dgc-sub-msg-slot"></div>';
      panel.appendChild(card);
    });

    panel.style.display = 'block';
  }

  /* ════════════════════════════════════════════════════════════════════════
   * 8. ACTION HANDLERS
   * ════════════════════════════════════════════════════════════════════════ */
  var CONFIRMS = {
    'ship-now': 'Send your next order now? Your saved card will be charged and it will ship on our next run (usually within 1 business day). Your normal schedule then continues from this shipment.',
    'skip':     'Skip your next shipment? Your next charge will move forward by one cycle.',
    'pause':    'Pause this subscription? You won\'t be charged again until you choose to resume it.',
    'resume':   'Resume this subscription? Your next order will ship within 1 business day.'
  };

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;

    var actionBtn = el.closest('[data-action]');
    if (!actionBtn) return;

    var card = actionBtn.closest('.dgc-sub-card');
    if (!card) return;
    var action = actionBtn.getAttribute('data-action');

    /* Inline-form openers ----------------------------------------------- */
    if (action === 'change-frequency') { openFrequencyForm(card); return; }
    if (action === 'change-address')   { openAddressForm(card); return; }
    if (action === 'cancel-prompt')    { openCancelConfirm(card); return; }
    if (action === 'inline-cancel')    { closeInline(card); return; }

    if (action === 'confirm-cancel')   { doAction(card, 'cancel', {}); return; }

    if (action === 'apply-frequency') {
      var sel = card.querySelector('.dgc-sub-inline select');
      var freq = sel && sel.value;
      if (freq) doAction(card, 'set-frequency', { frequency: freq });
      return;
    }

    if (action === 'apply-address') {
      var address = readAddressForm(card);
      if (address) doAction(card, 'change-address', { address: address });
      return;
    }

    /* Direct actions ----------------------------------------------------- */
    if (CONFIRMS[action]) {
      if (!window.confirm(CONFIRMS[action])) return;
      doAction(card, action, {});
    }
  });

  function openFrequencyForm(card) {
    var inline = card.querySelector('.dgc-sub-inline');
    if (!inline) return;
    var current = card.dataset.frequency || '';
    var opts = FREQ_OPTIONS.map(function (o) {
      var selected = (o.value === current) ? ' selected' : '';
      return '<option value="' + esc(o.value) + '"' + selected + '>' + esc(o.label) + '</option>';
    }).join('');
    inline.innerHTML =
      '<label>How often should it ship?</label>' +
      '<select>' + opts + '</select>' +
      '<div class="dgc-sub-card-actions">' +
        '<button class="dgc-btn-action dgc-btn-resume" data-action="apply-frequency">Save</button>' +
        '<button class="dgc-btn-action" data-action="inline-cancel">Cancel</button>' +
      '</div>';
    inline.style.display = 'block';
  }

  function openAddressForm(card) {
    var inline = card.querySelector('.dgc-sub-inline');
    if (!inline) return;
    var a = {};
    try { a = JSON.parse(card.dataset.address || '{}'); } catch (e) { a = {}; }

    function field(name, label, full) {
      return '<div' + (full ? ' class="dgc-addr-full"' : '') + '>' +
        '<label>' + esc(label) + '</label>' +
        '<input type="text" data-addr="' + name + '" value="' + esc(a[name] || '') + '" />' +
        '</div>';
    }

    inline.innerHTML =
      '<label style="font-size:13px;margin-bottom:10px;">Update the shipping address for this subscription</label>' +
      '<div class="dgc-addr-grid">' +
        field('first_name', 'First name') +
        field('last_name', 'Last name') +
        field('address1', 'Address', true) +
        field('address2', 'Apt / Suite (optional)', true) +
        field('city', 'City') +
        field('region', 'State') +
        field('postal_code', 'ZIP') +
        field('country', 'Country') +
      '</div>' +
      '<div class="dgc-sub-card-actions">' +
        '<button class="dgc-btn-action dgc-btn-resume" data-action="apply-address">Save Address</button>' +
        '<button class="dgc-btn-action" data-action="inline-cancel">Cancel</button>' +
      '</div>';
    inline.style.display = 'block';
  }

  function readAddressForm(card) {
    var inputs = card.querySelectorAll('.dgc-sub-inline input[data-addr]');
    if (!inputs.length) return null;
    var address = {};
    inputs.forEach(function (inp) {
      address[inp.getAttribute('data-addr')] = inp.value.trim();
    });
    if (!address.address1 || !address.city || !address.postal_code) {
      showMsg(card, 'Please fill in at least the address, city and ZIP.', false);
      return null;
    }
    return address;
  }

  function openCancelConfirm(card) {
    var inline = card.querySelector('.dgc-sub-inline');
    if (!inline) return;
    inline.innerHTML =
      '<p style="margin:0 0 12px;font-size:13px;color:#444;line-height:1.5;">' +
      'Are you sure you want to cancel? You can ' +
      '<strong>pause anytime</strong> or <strong>change how often it ships</strong> instead — ' +
      'no need to start over later.</p>' +
      '<div class="dgc-sub-card-actions">' +
        '<button class="dgc-btn-action dgc-btn-resume" data-action="pause">Pause instead</button>' +
        '<button class="dgc-btn-action" data-action="change-frequency">Change frequency instead</button>' +
        '<button class="dgc-btn-cancel" data-action="confirm-cancel">Yes, cancel subscription</button>' +
        '<button class="dgc-btn-action" data-action="inline-cancel">Keep my subscription</button>' +
      '</div>';
    inline.style.display = 'block';
  }

  function closeInline(card) {
    var inline = card.querySelector('.dgc-sub-inline');
    if (inline) { inline.style.display = 'none'; inline.innerHTML = ''; }
  }

  function doAction(card, action, extra) {
    var subUri   = card.dataset.subUri;
    var subToken = card.dataset.subToken;
    if (!subUri || !subToken) {
      showMsg(card, 'Sorry — we couldn\'t identify this subscription. Please refresh and try again.', false);
      return;
    }

    card.classList.add('dgc-busy');
    showMsg(card, 'Working…', true);

    var payload = { action: action, subscription_uri: subUri, sub_token: subToken };
    if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });

    fetch(GD_MANAGE_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, json: j };
      });
    })
    .then(function (res) {
      if (res.ok && res.json && res.json.success) {
        showMsg(card, 'Done! Refreshing your subscription…', true);
        setTimeout(function () { window.location.reload(); }, 1400);
      } else {
        card.classList.remove('dgc-busy');
        var err = (res.json && res.json.error) || 'Something went wrong. Please try again.';
        showMsg(card, err, false);
      }
    })
    .catch(function () {
      card.classList.remove('dgc-busy');
      showMsg(card, 'Network error. Please try again.', false);
    });
  }

  function showMsg(card, text, ok) {
    var slot = card.querySelector('.dgc-sub-msg-slot');
    if (!slot) return;
    slot.innerHTML = '<p class="dgc-sub-msg ' + (ok ? 'dgc-sub-msg--ok' : 'dgc-sub-msg--err') + '">' + esc(text) + '</p>';
  }

  /* ════════════════════════════════════════════════════════════════════════
   * HELPERS
   * ════════════════════════════════════════════════════════════════════════ */
  /* Foxy frequency code (e.g. 1w, 2w, 1m, .5m, 7d) → human-readable text. */
  function formatFrequency(freq) {
    if (!freq) return '';
    if (freq === '.5m') return 'Twice a month';
    var m = /^(\d+)([dwmy])$/.exec(freq);
    if (!m) return freq;
    var n = parseInt(m[1], 10);
    var units = { d: 'day', w: 'week', m: 'month', y: 'year' };
    var unit = units[m[2]] || m[2];
    return n === 1 ? 'Every ' + unit : 'Every ' + n + ' ' + unit + 's';
  }

  function formatDate(str) {
    if (!str) return '—';
    try {
      return new Date(str).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
      });
    } catch (e) { return str; }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  /* ════════════════════════════════════════════════════════════════════════
   * BOOTSTRAP — wait for <foxy-customer-portal> to exist, then start.
   *   When loaded via <script src> in the Webflow footer, the element is
   *   usually present already; the retry covers slower module/component loads.
   * ════════════════════════════════════════════════════════════════════════ */
  function boot() {
    portal = document.querySelector('foxy-customer-portal');
    if (!portal) return false;
    startPolling();
    return true;
  }

  if (!boot()) {
    var tries = 0;
    var bp = setInterval(function () {
      if (boot() || ++tries > 60) clearInterval(bp);
    }, 250);
  }

})();
