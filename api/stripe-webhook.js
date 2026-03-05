// /api/stripe-webhook.js (OPTIMIZED + TECH_ID FIX)
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

function computeSlotCode(service_date, slot_index) {
  return `${service_date}#${slot_index}`;
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
      return res.status(400).send(`Webhook signature verification failed`);
    }

    if (event.type !== "checkout.session.completed")
      return res.status(200).json({ received: true });

    const session = event.data.object;
    const m = session.metadata || {};

    const offerToken = String(m.offer_token || "").trim();
    const jobRef = String(m.jobRef || "").trim() || null;

    if (!offerToken)
      return res.status(500).json({ error: "Missing offer token" });

    const stripePaymentIntent = session.payment_intent;

    /* -------------------------
       Idempotency protection
    --------------------------*/

    const existingUrl =
      `${SUPABASE_URL}/rest/v1/bookings?stripe_checkout_session_id=eq.${session.id}&select=id&limit=1`;

    const existingResp = await sbFetchJson(existingUrl, { headers: sbHeaders(SERVICE_ROLE) });

    const existing = Array.isArray(existingResp.data) ? existingResp.data[0] : null;
    if (existing) return res.status(200).json({ received: true });

    /* -------------------------
       Get offer + request data
       (runtime optimization)
    --------------------------*/

    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(offerToken)}` +
      `&select=id,request_id,is_active,service_date,slot_index,zone_code,start_time,end_time,booking_requests(appointment_type)`;

    const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });

    const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;

    if (!offerRow || offerRow.is_active === false)
      return res.status(200).json({ received: true });

    const zoneCode = offerRow.zone_code.toUpperCase();
    const slotCode = computeSlotCode(offerRow.service_date, offerRow.slot_index);

    const appointmentType =
      offerRow.booking_requests?.appointment_type || "standard";

    /* -------------------------
       Fetch schedule slot
    --------------------------*/

    const slotUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?zone_code=eq.${zoneCode}` +
      `&service_date=eq.${offerRow.service_date}` +
      `&slot_index=eq.${offerRow.slot_index}` +
      `&select=id,tech_id&limit=1`;

    const slotResp = await sbFetchJson(slotUrl, { headers: sbHeaders(SERVICE_ROLE) });

    const slotRow = Array.isArray(slotResp.data) ? slotResp.data[0] : null;

    if (!slotRow)
      return res.status(500).json({ error: "Slot not found" });

    const slotId = slotRow.id;
    const techId = slotRow.tech_id;

    /* -------------------------
       Conflict protection
    --------------------------*/

    const conflictUrl =
      `${SUPABASE_URL}/rest/v1/bookings?slot_code=eq.${slotCode}&zone_code=eq.${zoneCode}&select=id&limit=1`;

    const conflictResp = await sbFetchJson(conflictUrl, { headers: sbHeaders(SERVICE_ROLE) });

    const conflict = Array.isArray(conflictResp.data) ? conflictResp.data[0] : null;

    if (conflict)
      return res.status(200).json({ received: true, slotTaken: true });

    /* -------------------------
       Build window timestamps
    --------------------------*/

    const tzOffset = process.env.LOCAL_TZ_OFFSET || "-08:00";

    const windowStart = makeLocalTimestamptz(
      offerRow.service_date,
      offerRow.start_time,
      tzOffset
    );

    const windowEnd = makeLocalTimestamptz(
      offerRow.service_date,
      offerRow.end_time,
      tzOffset
    );

    const bookingInsert = {
      request_id: offerRow.request_id,
      selected_option_id: offerRow.id,

      slot_id: slotId,
      tech_id: techId,

      window_start: windowStart,
      window_end: windowEnd,

      slot_code: slotCode,
      zone_code: zoneCode,
      appointment_type: appointmentType,

      payment_status: "paid",
      collected_cents: session.amount_total || null,

      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: stripePaymentIntent,

      status: "scheduled",
      job_ref: jobRef,
    };

    const bookingResp = await sbFetchJson(`${SUPABASE_URL}/rest/v1/bookings`, {
      method: "POST",
      headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=representation" },
      body: JSON.stringify(bookingInsert),
    });

    /* -------------------------
       Booking failed → refund
    --------------------------*/

    if (!bookingResp.ok) {

      try {
        if (stripePaymentIntent) {
          await stripe.refunds.create({
            payment_intent: stripePaymentIntent,
          });
        }
      } catch (refundErr) {
        console.error("Refund failed", refundErr);
      }

      return res.status(500).json({
        error: "Booking insert failed",
        body: bookingResp.text,
      });
    }

    const bookingRow = bookingResp.data?.[0] || null;

    /* -------------------------
       Invalidate offers
    --------------------------*/

    const invalidateUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?zone_code=eq.${zoneCode}` +
      `&service_date=eq.${offerRow.service_date}` +
      `&slot_index=eq.${offerRow.slot_index}`;

    await sbFetchJson(invalidateUrl, {
      method: "PATCH",
      headers: { ...sbHeaders(SERVICE_ROLE) },
      body: JSON.stringify({ is_active: false }),
    });

    /* -------------------------
       Mark request booked
    --------------------------*/

    await sbFetchJson(
      `${SUPABASE_URL}/rest/v1/booking_requests?id=eq.${offerRow.request_id}`,
      {
        method: "PATCH",
        headers: { ...sbHeaders(SERVICE_ROLE) },
        body: JSON.stringify({ status: "booked" }),
      }
    );

    return res.status(200).json({
      received: true,
      bookingId: bookingRow?.id || null,
    });

  } catch (err) {
    console.error("stripe webhook error", err);
    return res.status(500).json({ error: "Webhook failure" });
  }
};
