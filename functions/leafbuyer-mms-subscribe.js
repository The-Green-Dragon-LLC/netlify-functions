// Handles FoxyCart post-transaction webhook to subscribe customers to Leafbuyer MMS.
// Triggered when the customer checks the MMS opt-in box at checkout.
//
// Required env vars:
//   LEAFBUYER_CLIENT_ID      - OAuth client ID (staging: c6A7DhK9XSalOOWwHNHmzEvf9UPOLR3a)
//   LEAFBUYER_CLIENT_SECRET  - OAuth client secret / signing key
//   LEAFBUYER_TEMPLATE_ID    - Ad hoc message template ID (obtain after Leafbuyer approval)
//   LEAFBUYER_MMS_IMAGE_ID   - (optional) Approved MMS image ID
//   LEAFBUYER_ENV            - "staging" or "production" (default: "staging")
//   MMS_OPTIN_FIELD          - FoxyCart custom field name for the checkbox (default: "mms_subscribe")

const ENDPOINTS = {
  staging: {
    graphql: "https://api.ingress.stage.lbmlp.dev.leafbuyerloyalty.com/graphql",
    auth: "https://stage-lbmlp.us.auth0.com/oauth/token",
  },
  production: {
    graphql: "https://adhoc.leafbuyerloyalty.com/graphql",
    auth: "https://leafbuyer.auth0.com/oauth/token",
  },
};

const LOCATION_ID = "5e10a496-98bd-47fc-950e-240a5fe314d7";
const MMS_OPTIN_FIELD = process.env.MMS_OPTIN_FIELD || "mms_subscribe";

// Token cache — Auth0 tokens are valid for 10 hours
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const env = process.env.LEAFBUYER_ENV === "production" ? "production" : "staging";
  const { auth: authEndpoint } = ENDPOINTS[env];

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.LEAFBUYER_CLIENT_ID,
    client_secret: process.env.LEAFBUYER_CLIENT_SECRET,
    audience: "api",
  });

  const res = await fetch(authEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Leafbuyer auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    // Subtract 60s buffer so we refresh before true expiry
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return tokenCache.token;
}

async function graphql(query, variables = {}) {
  const env = process.env.LEAFBUYER_ENV === "production" ? "production" : "staging";
  const { graphql: endpoint } = ENDPOINTS[env];
  const token = await getAccessToken();

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

async function createCustomer(customer) {
  const mutation = `
    mutation CreateCustomer($locationId: String!, $customer: CustomerInput!) {
      createCustomer(locationId: $locationId, customer: $customer) {
        id
        phoneNumber
        firstName
        lastName
      }
    }
  `;
  return graphql(mutation, {
    locationId: LOCATION_ID,
    customer,
  });
}

async function sendAdHocMessage(input) {
  const mutation = `
    mutation SendAdHocMarketingMessage($input: AdHocMarketingMessageInput!) {
      sendAdHocMarketingMessage(input: $input) {
        status
        dispatchId
      }
    }
  `;
  return graphql(mutation, { input });
}

// Extract custom field value from FoxyCart embedded custom_fields array
function getCustomField(payload, fieldName) {
  const fields = payload["_embedded"]?.["fx:custom_fields"] ?? [];
  const field = fields.find(
    (f) => f.name?.toLowerCase() === fieldName.toLowerCase()
  );
  return field?.value ?? null;
}

// Format phone to E.164 — strips everything except digits, prepends +1 if 10 digits
function toE164(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // Only proceed if the customer opted in to MMS
  const optinValue = getCustomField(payload, MMS_OPTIN_FIELD);
  if (!optinValue || optinValue.toLowerCase() === "false" || optinValue === "0") {
    console.log("MMS opt-in not checked — skipping");
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  const customer = payload["_embedded"]?.["fx:customer"] ?? {};
  const shipment = payload["_embedded"]?.["fx:shipment"] ?? {};

  // Phone can come from a dedicated custom field, the shipment phone, or billing phone
  const rawPhone =
    getCustomField(payload, "phone") ||
    shipment.phone ||
    customer.phone ||
    null;

  const phoneNumber = toE164(rawPhone);

  if (!phoneNumber) {
    console.error("No valid phone number found in FoxyCart payload");
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, details: "No valid phone number" }),
    };
  }

  const templateId = process.env.LEAFBUYER_TEMPLATE_ID;
  if (!templateId) {
    console.error("LEAFBUYER_TEMPLATE_ID env var is not set");
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, details: "Template ID not configured" }),
    };
  }

  try {
    // Create (or upsert) the customer record in Leafbuyer
    const customerInput = {
      phoneNumber,
      firstName: customer.first_name || shipment.first_name || "",
      lastName: customer.last_name || shipment.last_name || "",
      email: customer.email || "",
    };

    // Include optional fields only if present
    if (customer.postal_code || shipment.postal_code) {
      customerInput.zipcode = customer.postal_code || shipment.postal_code;
    }

    await createCustomer(customerInput);
    console.log(`Leafbuyer customer created/updated for ${phoneNumber}`);

    // Send the sign-up ad hoc marketing message
    const messageInput = {
      phoneNumber,
      templateId,
      firstName: customerInput.firstName,
      lastName: customerInput.lastName,
    };

    if (process.env.LEAFBUYER_MMS_IMAGE_ID) {
      messageInput.messageCenterImageId = process.env.LEAFBUYER_MMS_IMAGE_ID;
    }

    const result = await sendAdHocMessage(messageInput);
    console.log(
      `MMS dispatched — status: ${result.sendAdHocMarketingMessage.status}, ` +
        `dispatchId: ${result.sendAdHocMarketingMessage.dispatchId}`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, ...result.sendAdHocMarketingMessage }),
    };
  } catch (err) {
    console.error("Leafbuyer MMS subscribe error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, details: err.message }),
    };
  }
};
