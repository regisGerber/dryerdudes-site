// api/stripe-webhook.js
import Stripe from "stripe";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Read raw body (required for Stripe signature verification)
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export const config = {
  api: { bodyParser: false }, // IMPORTANT for Stripe signature verification
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");
    const STRIPE_WEBHOOK_SECRET = requireEnv("STRIPE_WEBHOOK_SECRET");

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    });

    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("Missing stripe-signature header");

    const rawBody = await getRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }

    // ✅ Handle the events we care about
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        // If you set metadata when creating the Checkout Session,
        // it will show up here, e.g.:
        // session.metadata.request_id
        // session.metadata.offer_token
        // session.metadata.amount_cents
        // session.metadata.appointment_type
        // session.metadata.service_date / slot_index / zone_code etc

        // For now, just acknowledge success.
        // Next step: update Supabase status + lock in the appointment.
        break;
      }

      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
        // Optional (only matters for certain payment methods)
        break;

      default:
        // ignore other events
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: "Webhook server error", message: err?.message || String(err) });
  }
}
