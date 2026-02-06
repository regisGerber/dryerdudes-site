// /api/stripe-webhook.js
import Stripe from "stripe";

export const config = {
  api: {
    bodyParser: false, // IMPORTANT: Stripe needs the raw body to verify signatures
  },
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Minimal Supabase update helper (REST)
async function supabasePatch({ table, match, patch, serviceRole, supabaseUrl }) {
  // match = { id: "..." } etc
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(match)) {
    params.set(k, `eq.${v}`);
  }

  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}?${params.toString()}`, {
    method: "PATCH",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`Supabase PATCH failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");
    const STRIPE_WEBHOOK_SECRET = requireEnv("STRIPE_WEBHOOK_SECRET"); // from Stripe webhook page
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    const rawBody = await readRawBody(req);
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }

    // We care about successful checkout completion
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // IMPORTANT:
      // This assumes your "create checkout session" endpoint sets metadata like:
      // metadata: { request_id, offer_token, appointment_type, service_date, slot_index, amount_cents }
      const md = session.metadata || {};

      const requestId = md.request_id;
      const offerToken = md.offer_token;

      if (!requestId || !offerToken) {
        // Don’t crash — but we can’t finalize without metadata
        console.error("Missing required metadata on session:", { requestId, offerToken, md });
        return res.status(200).json({ ok: true, warning: "missing_metadata" });
      }

      // Mark booking request as PAID/CONFIRMED
      await supabasePatch({
        table: "booking_requests",
        match: { id: requestId },
        patch: {
          status: "paid",
          paid_at: new Date().toISOString(),
          stripe_session_id: session.id,
          stripe_payment_intent: session.payment_intent || null,
          offer_token: offerToken,
        },
        serviceRole: SERVICE_ROLE,
        supabaseUrl: SUPABASE_URL,
      });

      // Also mark the selected offer as "confirmed" if your table supports it
      // If these columns don't exist yet, we’ll add them later — safe to remove if needed.
      try {
        await supabasePatch({
          table: "booking_request_offers",
          match: { offer_token: offerToken },
          patch: {
            status: "confirmed",
            confirmed_at: new Date().toISOString(),
          },
          serviceRole: SERVICE_ROLE,
          supabaseUrl: SUPABASE_URL,
        });
      } catch (e) {
        // Not fatal if your offers table doesn’t have these columns yet
        console.warn("Offer confirm patch skipped:", e.message);
      }

      // TODO (next): trigger Twilio/Resend confirmation from here (after we confirm the schema)
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", message: err.message || String(err) });
  }
}
