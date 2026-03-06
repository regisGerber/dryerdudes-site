const Stripe = require("stripe");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

module.exports.config = { api: { bodyParser: false } };

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: resp.ok, status: resp.status, data, text };
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function fmtDateMDY(iso) {
  const s = String(iso || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function fmtTime12h(t) {
  if (!t) return "";
  const raw = String(t).slice(0, 5);
  const m = raw.match(/^(\d{2}):(\d{2})$/);
  if (!m) return raw;
  let hh = Number(m[1]);
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${mm} ${ampm}`;
}

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host =
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req.headers.host || "").trim();

  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");
    const STRIPE_WEBHOOK_SECRET = requireEnv("STRIPE_WEBHOOK_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    const sig = req.headers["stripe-signature"];
    const rawBody = await getRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send("Webhook signature verification failed");
    }

    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true });
    }

    const session = event.data.object;
    const metadata = session.metadata || {};
    const origin = getOrigin(req);

    const offerToken = String(metadata.offer_token || "").trim();
    const jobRef = String(metadata.jobRef || "").trim() || null;
    const appointmentType = String(metadata.appointment_type || "standard").trim();
    const stripePaymentIntent = session.payment_intent || null;
    const collectedCents = typeof session.amount_total === "number" ? session.amount_total : 0;

    if (!offerToken) {
      return res.status(200).json({ received: true });
    }

    // idempotency: already inserted for this Stripe session?
    const existingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?stripe_checkout_session_id=eq.${encodeURIComponent(session.id)}` +
      `&select=id&limit=1`;

    const existingResp = await sbFetchJson(existingUrl, {
      headers: sbHeaders(SERVICE_ROLE)
    });

    const existing = Array.isArray(existingResp.data) ? existingResp.data[0] : null;
    if (existing) {
      console.log("Webhook replay detected — booking already exists");
      return res.status(200).json({ received: true, bookingId: existing.id });
    }

    // finalize everything atomically in DB
    const finalizeUrl = `${SUPABASE_URL}/rest/v1/rpc/finalize_paid_booking`;
    const finalizeResp = await sbFetchJson(finalizeUrl, {
      method: "POST",
      headers: sbHeaders(SERVICE_ROLE),
      body: JSON.stringify({
        p_offer_token: offerToken,
        p_stripe_checkout_session_id: session.id,
        p_stripe_payment_intent_id: stripePaymentIntent,
        p_collected_cents: collectedCents,
        p_job_ref: jobRef,
        p_appointment_type: appointmentType,
        p_tz_offset: process.env.LOCAL_TZ_OFFSET || "-08:00"
      })
    });

   if (!finalizeResp.ok) {

  try {

    if (stripePaymentIntent) {

      const pi = await stripe.paymentIntents.retrieve(
        stripePaymentIntent,
        { expand: ["latest_charge.refunds"] }
      );

      const charge = pi.latest_charge;

      const alreadyRefunded =
        charge &&
        charge.refunds &&
        charge.refunds.data &&
        charge.refunds.data.length > 0;

      if (!alreadyRefunded) {

        await stripe.refunds.create({
          payment_intent: stripePaymentIntent
        });

        console.log("Refund issued for failed booking");

      } else {

        console.log("Refund already exists — skipping");

      }
    }

  } catch (refundErr) {

    console.error("Refund check failed", refundErr);

  }

  return res.status(500).json({
    error: "Booking finalize failed",
    body: finalizeResp.text
  });
}


    const resultRow = Array.isArray(finalizeResp.data) ? finalizeResp.data[0] : null;
    const bookingId = resultRow?.booking_id || null;

    // confirmation email (best effort only)
    const customerEmail =
      (session.customer_details && session.customer_details.email) ||
      session.customer_email ||
      null;

    if (customerEmail && resultRow) {
      const payload = {
        customerEmail: String(customerEmail).trim(),
        customerName:
          (session.customer_details && session.customer_details.name) || "there",
        service: "Dryer Repair",
        date: fmtDateMDY(resultRow.service_date),
        timeWindow: `${fmtTime12h(resultRow.start_time)}–${fmtTime12h(resultRow.end_time)}`,
        address: metadata.address || "",
        notes: "",
        jobRef: jobRef,
        stripeSessionId: session.id
      };

      try {
        const emailResp = await fetch(`${origin}/api/send-booking-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const emailText = await emailResp.text();
        if (!emailResp.ok) {
          console.error("send-booking-email failed", {
            status: emailResp.status,
            body: emailText
          });
        }
      } catch (emailErr) {
        console.error("send-booking-email error", emailErr);
      }
    }

    return res.status(200).json({
      received: true,
      bookingId
    });
  } catch (err) {
    console.error("stripe webhook error", err);
    return res.status(500).json({ error: "Webhook failure" });
  }
};
