// /api/stripe-webhook.js
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

function makeLocalTimestamptz(service_date, hhmmss, offset = "-08:00") {
  if (!service_date || !hhmmss) return null;
  const t = String(hhmmss).slice(0, 8);
  return `${service_date}T${t}${offset}`;
}

function computeSlotCode(service_date, slot_index, zone_code) {
  const z = String(zone_code || "").toUpperCase();
  const t1 = String(slot_index) === "1" ? "1600" : null;
  const t2 = String(slot_index) === "1" ? "1800" : null;
  if (t1 && t2 && z) return `${z}-${service_date}-${t1}-${t2}`;
  return `${service_date}#${slot_index}`;
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

    if (!offerToken) {
      return res.status(200).json({ received: true });
    }

    const stripePaymentIntent = session.payment_intent;

    /* ---------------------------------
       Idempotency protection
    ----------------------------------*/
    const existingUrl =
      `${SUPABASE_URL}/rest/v1/bookings?stripe_checkout_session_id=eq.${session.id}&select=id&limit=1`;

    const existingResp = await sbFetchJson(existingUrl, {
      headers: sbHeaders(SERVICE_ROLE)
    });

    const existing = Array.isArray(existingResp.data) ? existingResp.data[0] : null;
    if (existing) {
      return res.status(200).json({ received: true });
    }

    /* ---------------------------------
       Validate offer using RPC
    ----------------------------------*/
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/verify_offer_for_checkout`;

    const rpcResp = await sbFetchJson(rpcUrl, {
      method: "POST",
      headers: sbHeaders(SERVICE_ROLE),
      body: JSON.stringify({ p_token: offerToken })
    });

    const offer = Array.isArray(rpcResp.data) ? rpcResp.data[0] : null;

    if (!offer || offer.availability_status !== "valid") {
      return res.status(200).json({ received: true });
    }

    const slotId = offer.slot_id;
    const zoneCode = String(offer.zone_code || "").toUpperCase();

    /* ---------------------------------
       Load schedule slot
    ----------------------------------*/
    const slotUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots?id=eq.${slotId}` +
      `&select=id,tech_id,service_date,start_time,end_time,slot_index,zone_code&limit=1`;

    const slotResp = await sbFetchJson(slotUrl, {
      headers: sbHeaders(SERVICE_ROLE)
    });

    const slotRow = Array.isArray(slotResp.data) ? slotResp.data[0] : null;

    if (!slotRow) {
      return res.status(200).json({ received: true });
    }

    const techId = slotRow.tech_id;
    const slotCode = computeSlotCode(slotRow.service_date, slotRow.slot_index, slotRow.zone_code);

    const tzOffset = process.env.LOCAL_TZ_OFFSET || "-08:00";

    const windowStart = makeLocalTimestamptz(slotRow.service_date, slotRow.start_time, tzOffset);
    const windowEnd = makeLocalTimestamptz(slotRow.service_date, slotRow.end_time, tzOffset);

    /* ---------------------------------
       Insert booking
    ----------------------------------*/
    const bookingInsert = {
      request_id: metadata.request_id || null,
      selected_option_id: offer.offer_id,

      slot_id: slotRow.id,
      tech_id: techId,

      window_start: windowStart,
      window_end: windowEnd,

      slot_code: slotCode,
      zone_code: zoneCode,
      route_zone_code: zoneCode,

      appointment_type: metadata.appointment_type || "standard",

      payment_status: "paid",
      collected_cents: session.amount_total || null,

      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: stripePaymentIntent,

      status: "scheduled",
      job_ref: jobRef
    };

    const bookingResp = await sbFetchJson(
      `${SUPABASE_URL}/rest/v1/bookings`,
      {
        method: "POST",
        headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=representation" },
        body: JSON.stringify(bookingInsert)
      }
    );

    /* ---------------------------------
       Booking failed → refund
    ----------------------------------*/
    if (!bookingResp.ok) {
      try {
        if (stripePaymentIntent) {
          await stripe.refunds.create({
            payment_intent: stripePaymentIntent
          });
        }
      } catch (refundErr) {
        console.error("Refund failed", refundErr);
      }

      return res.status(500).json({
        error: "Booking insert failed",
        body: bookingResp.text
      });
    }

    const bookingRow = Array.isArray(bookingResp.data) ? bookingResp.data[0] : null;

    /* ---------------------------------
       Deactivate all offers for slot
    ----------------------------------*/
    const invalidateUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers?slot_id=eq.${slotId}`;

    await sbFetchJson(invalidateUrl, {
      method: "PATCH",
      headers: sbHeaders(SERVICE_ROLE),
      body: JSON.stringify({ is_active: false })
    });

    /* ---------------------------------
       Mark request booked
    ----------------------------------*/
    if (metadata.request_id) {
      await sbFetchJson(
        `${SUPABASE_URL}/rest/v1/booking_requests?id=eq.${metadata.request_id}`,
        {
          method: "PATCH",
          headers: sbHeaders(SERVICE_ROLE),
          body: JSON.stringify({ status: "booked" })
        }
      );
    }

    /* ---------------------------------
       Send confirmation email (best effort)
    ----------------------------------*/
    const customerEmail =
      (session.customer_details && session.customer_details.email) ||
      session.customer_email ||
      null;

    if (customerEmail) {
      const payload = {
        customerEmail: String(customerEmail).trim(),
        customerName:
          (session.customer_details && session.customer_details.name) ||
          "there",
        service: "Dryer Repair",
        date: fmtDateMDY(slotRow.service_date),
        timeWindow: `${fmtTime12h(slotRow.start_time)}–${fmtTime12h(slotRow.end_time)}`,
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
      bookingId: bookingRow?.id || null
    });

  } catch (err) {
    console.error("stripe webhook error", err);

    return res.status(500).json({
      error: "Webhook failure"
    });
  }
};

