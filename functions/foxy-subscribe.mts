// Foxy -> Omnisend subscriber sync (direct API webhook receiver)
// Verifies the Foxy HMAC signature, then subscribes the web buyer in Omnisend.
//
// Env vars (Netlify -> Site config -> Environment variables):
//   OMNISEND_API_KEY              (required)
//   FOXY_SUBSCRIBE_ENCRYPTION_KEY (required) this webhook's encryption key from Foxy
//                                 (separate from FOXY_WEBHOOK_ENCRYPTION_KEY used by other functions)
//   FOXY_STORE_ID                 (optional) extra sender check, e.g. 101277
//   OMNISEND_SEND_WELCOME         (optional) "true" to fire Omnisend's welcome message

import type { Config, Context } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const OMNISEND_API_KEY = Netlify.env.get("OMNISEND_API_KEY");
  const FOXY_KEY = Netlify.env.get("FOXY_SUBSCRIBE_ENCRYPTION_KEY");
  const FOXY_STORE_ID = Netlify.env.get("FOXY_STORE_ID");
  const SEND_WELCOME = Netlify.env.get("OMNISEND_SEND_WELCOME") === "true";

  if (!OMNISEND_API_KEY || !FOXY_KEY) {
    console.error("Missing OMNISEND_API_KEY or FOXY_SUBSCRIBE_ENCRYPTION_KEY.");
    return new Response("Server misconfigured", { status: 500 });
  }

  // Foxy signs the EXACT raw request body.
  const rawBody = await req.text();
  const signature = req.headers.get("foxy-webhook-signature") || "";
  const foxyEvent = req.headers.get("foxy-webhook-event") || "";
  const storeId = req.headers.get("foxy-store-id") || "";

  const expected = createHmac("sha256", FOXY_KEY).update(rawBody, "utf8").digest("hex");
  if (!signature || !safeEqual(signature, expected)) {
    console.warn("Foxy signature verification failed.");
    return new Response("Forbidden", { status: 403 });
  }
  if (FOXY_STORE_ID && storeId !== FOXY_STORE_ID) {
    return new Response("Forbidden", { status: 403 });
  }
  if (foxyEvent !== "transaction/created") {
    return new Response(`Ignored event: ${foxyEvent}`, { status: 200 });
  }

  let data: any;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const customer = (data._embedded && data._embedded["fx:customer"]) || {};
  const email = data.customer_email || customer.email;
  const firstName = data.customer_first_name || customer.first_name || "";
  const lastName = data.customer_last_name || customer.last_name || "";

  if (!email) {
    return new Response("No email on transaction; skipped", { status: 200 });
  }

  try {
    await subscribeToOmnisend(OMNISEND_API_KEY, SEND_WELCOME, {
      email,
      firstName,
      lastName,
      tags: ["source: foxycart", "channel: web"],
    });
  } catch (e: any) {
    console.error("Omnisend request failed:", e?.message);
    // 500 => Foxy retries (up to 11 times over the next hour).
    return new Response("Omnisend request failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
};

export const config: Config = {
  path: "/hooks/foxy",
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function subscribeToOmnisend(
  apiKey: string,
  sendWelcome: boolean,
  { email, firstName, lastName, tags }: { email: string; firstName?: string; lastName?: string; tags: string[] },
) {
  const statusDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const payload: any = {
    identifiers: [
      {
        type: "email",
        id: email,
        channels: { email: { status: "subscribed", statusDate } },
        sendWelcomeMessage: sendWelcome,
      },
    ],
    tags,
  };
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;

  const res = await fetch("https://api.omnisend.com/api/contacts", {
    method: "POST",
    headers: {
      Authorization: `Omnisend-API-Key ${apiKey}`,
      "Omnisend-Version": "2026-03-15",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omnisend ${res.status}: ${text}`);
  }
}
