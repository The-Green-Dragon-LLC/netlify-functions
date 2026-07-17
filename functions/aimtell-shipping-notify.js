/**
 * AIMTELL SHIPPING ALERT — Order Desk shipment webhook → Aimtell web push
 * ────────────────────────────────────────────────────────────────────────────
 * When an order ships, push the customer their tracking link. The "shipped"
 * signal comes from Order Desk (shipping flows ShipStation → Order Desk → Foxy),
 * so Order Desk POSTs the order (with its shipment + tracking) to this function,
 * which calls Aimtell's REST API to push whichever subscriber holds that email
 * alias. Aimtell silently no-ops if no subscriber matches the email — so guests
 * who never opted into push (or were never aliased) simply get skipped, never a
 * wrong-person send. See Aimtell-Triggered-Notifications-Plan.md, Notification 3B.
 *
 * The email→subscriber alias is captured elsewhere: on www account/newsletter
 * pages, and on the secure receipt via the hidden bridge iframe
 * (www/push/aimtell-bridge). This function only needs the customer email.
 *
 * TRIGGER — point Order Desk at this function, one of two ways:
 *   • Order metadata `ship_notify_url` = this function URL (apply to all orders
 *     via a Rules Engine rule) — Order Desk POSTs the order when a shipment is
 *     added. https://help.orderdesk.com/order-desk-101/how-to-send-shipment-tracking-info-to-customers/
 *   • A Rules Engine rule "on shipment added → Send Webhook" to this URL.
 *   Append the shared secret as a query param: ...?token=YOUR_SECRET
 *
 * REQUEST (POST JSON from Order Desk): the order object, either at the top level
 * or under `order`. Field names vary by Order Desk config — this parser is
 * defensive and logs the raw payload once so you can confirm names on the first
 * real shipment (the plan's "probe the real payload once" step).
 *
 * RESPONSE: always 200 for anything we successfully handled or safely skipped,
 * so Order Desk doesn't retry-storm. 401 only on a bad/missing shared secret.
 *
 * Env (on the netlify-functions site → Environment variables):
 *   AIMTELL_API_KEY          (required) REST API key — Aimtell → Settings.
 *                            https://documentation.aimtell.com/hc/en-us/articles/how-to-find-your-api-key
 *   ORDERDESK_WEBHOOK_SECRET (recommended) shared secret; sent as ?token= or the
 *                            X-Webhook-Token header. If unset, no auth is enforced.
 *   AIMTELL_IDSITE           (optional) www site id; defaults to 30861.
 */

const https = require('https');

const AIMTELL_ENDPOINT = 'https://api.aimtell.com/prod/subscriber/';
const AIMTELL_IDSITE = Number(process.env.AIMTELL_IDSITE) || 30861;

// Push copy — compliant, no medical claims (see plan "Suggested copy").
const PUSH_TITLE = 'Your order is on its way 📦';
const PUSH_BODY = 'Track your Green Dragon delivery here.';
// Where "track" goes when a shipment has no tracking URL/number at all.
const FALLBACK_LINK = 'https://www.thegreendragoncbd.com/account/orders';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ─── HTTPS helper (same shape as the other functions here) ───────────────── */
function httpsReq(url, opts, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: (opts && opts.method) || 'GET',
      headers: (opts && opts.headers) || {},
    };
    const bodyStr = bodyObj !== undefined
      ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj))
      : undefined;
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, json });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function resp(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

/* Case-insensitive header lookup (Netlify lower-cases, but be safe). */
function header(event, name) {
  const h = (event && event.headers) || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

/* Pull the customer email from the likely spots in an Order Desk payload. */
function extractEmail(order) {
  const candidates = [
    order.email,
    order.customer_email,
    order.shipping && order.shipping.email,
    order.customer && order.customer.email,
  ];
  for (const c of candidates) {
    const e = String(c || '').trim().toLowerCase();
    if (EMAIL_RE.test(e)) return e;
  }
  return '';
}

/* Order Desk exposes shipments as an array; the newest is the one just added. */
function extractShipments(order, body) {
  if (Array.isArray(order.shipments)) return order.shipments;
  if (Array.isArray(order.order_shipments)) return order.order_shipments;
  if (order.shipment) return [order.shipment];         // single-shipment payload
  if (body && body.shipment) return [body.shipment];
  return [];
}

/* A carrier + tracking number → a public tracking URL, when Order Desk didn't
 * give us a ready-made one. Falls back to the account orders page. */
function trackingLink(shipment) {
  const direct = String((shipment && shipment.tracking_url) || '').trim();
  if (direct) return direct;

  const num = String((shipment && shipment.tracking_number) || '').trim();
  if (!num) return FALLBACK_LINK;

  const carrier = String((shipment && shipment.carrier_code) || '').trim().toUpperCase();
  if (carrier === 'USPS') return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(num);
  if (carrier === 'UPS') return 'https://www.ups.com/track?loc=en_US&tracknum=' + encodeURIComponent(num);
  if (carrier === 'FEDEX') return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(num);
  return FALLBACK_LINK;
}

/* ─── Handler ─────────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'Method not allowed' });

  // Shared-secret check (if configured). Accept ?token= or X-Webhook-Token.
  const expected = process.env.ORDERDESK_WEBHOOK_SECRET;
  if (expected) {
    const got = (event.queryStringParameters && event.queryStringParameters.token) || header(event, 'x-webhook-token');
    if (got !== expected) {
      console.warn('[aimtell-ship] rejected: bad or missing webhook token');
      return resp(401, { ok: false, error: 'Unauthorized' });
    }
  }

  const apiKey = process.env.AIMTELL_API_KEY;
  if (!apiKey) {
    console.error('[aimtell-ship] AIMTELL_API_KEY not set');
    return resp(500, { ok: false, error: 'Server not configured.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) {
    console.error('[aimtell-ship] invalid JSON body:', String(event.body || '').slice(0, 500));
    return resp(400, { ok: false, error: 'Invalid JSON' });
  }

  // Probe aid: log the raw payload once so field names can be confirmed on the
  // first real shipment. Trimmed to keep logs sane.
  console.log('[aimtell-ship] payload:', JSON.stringify(body).slice(0, 4000));

  const order = body.order || body;

  const email = extractEmail(order);
  if (!email) {
    console.warn('[aimtell-ship] no customer email in payload — skipping (acknowledged)');
    return resp(200, { ok: true, skipped: 'no email' });
  }

  const shipments = extractShipments(order, body);
  if (!shipments.length) {
    console.warn('[aimtell-ship] no shipments in payload — skipping (acknowledged)');
    return resp(200, { ok: true, skipped: 'no shipments' });
  }

  // The just-added shipment is the newest; Order Desk appends to the array.
  const shipment = shipments[shipments.length - 1];
  const link = trackingLink(shipment);

  const payload = {
    idSite: AIMTELL_IDSITE,
    title: PUSH_TITLE,
    body: PUSH_BODY,
    link,
    alias: email, // plain email; Aimtell hashes it and matches the subscriber
  };

  try {
    const res = await httpsReq(AIMTELL_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Authorization-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
    }, payload);

    if (!res.ok) {
      console.error('[aimtell-ship] Aimtell push failed', res.status, (res.text || '').slice(0, 300));
      // 502 lets Order Desk retry a genuine Aimtell outage.
      return resp(502, { ok: false, error: 'Aimtell push failed', status: res.status });
    }

    console.log('[aimtell-ship] pushed to alias', email, '→', link);
    return resp(200, { ok: true, alias: email, link });
  } catch (e) {
    console.error('[aimtell-ship] Aimtell request error:', e.message);
    return resp(502, { ok: false, error: 'Aimtell request error' });
  }
};
