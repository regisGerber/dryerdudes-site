// /api/create-checkout-session.js
import crypto from "crypto";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function makeJobRef() {
  // Example: DD-483921
  return `DD-${Date.now().toString().slice(-6)}`;
}

async function stripeFetch(path, bodyObj) {
  const key = requireEnv("STRIPE_SECRET_KEY");

  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(bodyObj),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Stripe error: ${resp.status} ${JSON.stringify(data)}`);
  }

  return data;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, error: "missing_token" });
    }

    const origin = `https://${req.headers.host}`;

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(501).json({
        ok: false,
        error: "stripe_not_configured",
        message: "Payment is not configured yet. Add STRIPE_SECRET_KEY to enable checkout.",
      });
    }

    // 🔑 Generate job reference number
    const jobRef = makeJobRef();

    // Create Stripe Checkout session
    const session = await stripeFetch("checkout/sessions", {
      mode: "payment",

      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]":
        "Dryer Dudes — Dryer Repair Appointment",
      "line_items[0][price_data][unit_amount]": "8000", // $80.00
      "line_items[0][quantity]": "1",

      // 👇 Include jobRef in success page for visibility
      success_url: `${origin}/payment-success.html?jobRef=${encodeURIComponent(
        jobRef
      )}&session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${origin}/checkout.html?token=${encodeURIComponent(token)}`,

      // 👇 THIS IS THE MOST IMPORTANT PART
      "metadata[jobRef]": jobRef,
      "metadata[offer_token]": String(token),
    });

    return res.status(200).json({
      ok: true,
      url: session.url,
    });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || String(err),
    });
  }
}
