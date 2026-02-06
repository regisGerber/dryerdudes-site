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

    // Helper: decide what origin to call (your site)
    const origin =
      process.env.SITE_ORIGIN ||
      `https://${req.headers["x-forwarded-host"] || req.headers.host}`;

    // ✅ Handle the events we care about
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        // --- Pull job reference from metadata (your new system) ---
        const m = session.metadata || {};
        const jobRef = m.jobRef || m.jobref || m.job_reference || null;

        // --- Pull customer email (Stripe can store it in a few places) ---
        const customerEmail =
          session.customer_details?.email ||
          session.customer_email ||
          null;

        // If we somehow don't have an email, we can still ACK Stripe,
        // but we can't send the customer a confirmation.
        if (!customerEmail) {
          console.warn("Webhook: missing customer email on session", {
            sessionId: session.id,
            jobRef,
          });
          break;
        }

        // OPTIONAL: if you later store booking details in metadata, they can be passed through here
        // (Right now these will default to "-" in your email unless you add them)
        const payload = {
          customerEmail,
          customerName: session.customer_details?.name || "there",
          service: m.service || "Dryer Repair",
          date: m.date || "Scheduled",
          timeWindow: m.timeWindow || m.time_window || "TBD",
          address: m.address || "",
          notes: m.notes || "",
          jobRef, // 👈 key addition
          stripeSessionId: session.id,
        };

        // Call your email endpoint
        try {
          const r = await fetch(`${origin}/api/send-booking-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          const text = await r.text();

          if (!r.ok) {
            console.error("Webhook -> send-booking-email failed", {
              status: r.status,
              body: text,
              jobRef,
              sessionId: session.id,
            });
          } else {
            console.log("Webhook -> booking email sent", {
              jobRef,
              sessionId: session.id,
            });
          }
        } catch (e) {
          console.error("Webhook fetch error calling send-booking-email", e);
        }

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
    console.error("stripe-webhook error:", err);
    return res.status(500).json({
      error: "Webhook server error",
      message: err?.message || String(err),
    });
  }
}
