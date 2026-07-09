// Shopify POS -> Omnisend subscriber sync (direct API webhook receiver)
// Verifies the Shopify HMAC, filters to POS orders ONLY (source_name === "pos"),
// then subscribes the in-store buyer in Omnisend.
//
// Env vars (Netlify -> Site config -> Environment variables):
//   OMNISEND_API_KEY         (required)
//   SHOPIFY_WEBHOOK_SECRET   (required) Shopify admin -> Settings -> Notifications -> Webhooks (signing secret)
//   OMNISEND_SEND_WELCOME    (optional) "true" to fire Omnisend's welcome message

import type { Config, Context } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const OMNISEND_API_KEY = Netlify.env.get("OMNISEND_API_KEY");
  const SHOPIFY_WEBHOOK_SECRET = Netlify.env.get("SHOPIFY_WEBHOOK_SECRET");
  const SEND_WELCOME = Netlify.env.get("OMNISEND_SEND_WELCOME") === "true";

  if (!OMNISEND_API_KEY || !SHOPIFY_WEBHOOK_SECRET) {
    console.error("Missing OMNISEND_API_KEY or SHOPIFY_WEBHOOK_SECRET.");
    return new Response("Server misconfigured", { status: 500 });
  }

  const rawBody = await req.text();
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256") || "";

  // Shopify HMAC is base64-encoded SHA256 of the raw body.
  const digest = createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64");
  if (!hmacHeader || !safeEqual(hmacHeader, digest)) {
    console.warn("Shopify HMAC verification failed.");
    return new Response("Unauthorized", { status: 401 });
  }

  let order: any;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // POS-ONLY: ignore web/online and any other channel.
  const source = (order.source_name || "").toLowerCase();
  if (source !== "pos") {
    return new Response(`Ignored non-POS order (source: ${order.source_name})`, { status: 200 });
  }

  const customer = order.customer || {};
  const email = order.email || order.contact_email || customer.email;
  const firstName = customer.first_name || "";
  const lastName = customer.last_name || "";

  if (!email) {
    return new Response("No email on POS order; skipped", { status: 200 });
  }

  try {
    await subscribeToOmnisend(OMNISEND_API_KEY, SEND_WELCOME, {
      email,
      firstName,
      lastName,
      tags: ["source: shopify-pos", "channel: in-store"],
    });
  } catch (e: any) {
    console.error("Omnisend request failed:", e?.message);
    return new Response("Omnisend request failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
};

export const config: Config = {
  path: "/hooks/shopify-pos",
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
