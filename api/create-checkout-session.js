// /api/create-checkout-session.js (FULL REPLACEMENT - CommonJS)
// Bulletproof gate BEFORE Stripe:
// - offer must exist + is_active
// - block if any scheduled booking overlaps the offer window (UTC-safe)
// - optional: also block by your slot_code format (B-YYYY-MM-DD-HHmm-HHmm)
// - pass customer_email to Stripe so receipt emails can be sent (if enabled in Stripe settings)

const Stripe = require("stripe");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function makeJobRef() {
  return `DD-${Date.now().toString().slice(-6)}`;
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data, text };
}

// Build "YYYY-MM-DDTHH:MM:SS-08:00"
function makeLocalTimestamptz(service_date, hhmmss, offset = "-08:00") {
  if (!service_date || !hhmmss) return null;
  const t = String(hhmmss).trim().slice(0, 8);
  const m = t.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = m[1];
  const mm = m[2];
  const ss = m[3] ?? "00";
  return `${service_date}T${hh}:${mm}:${ss}${offset}`;
}

// Convert local timestamptz string to a UTC ISO string (with Z) for stable PostgREST comparisons
function toUtcIso(localTimestamptz) {
  const d = new Date(localTimestamptz);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString(); // "...Z"
}

// Format "HHmm" from a UTC ISO string
function hhmmFromUtcIso(utcIso) {
  const d = new Date(utcIso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}

// Your bookings slot_code format: "B-2026-02-23-1600-1800"
function buildSlotCode({ zone, service_date, offerStartUtcIso, offerEndUtcIso }) {
  const startHHmm = hhmmFromUtcIso(offerStartUtcIso);
  const endHHmm = hhmmFromUtcIso(offerEndUtcIso);
  return `${zone}-${service_date}-${startHHmm}-${endHHmm}`;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

    const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");

    const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
    const origin =
      envOrigin && /^https?:\/\//i.test(envOrigin) ? envOrigin : `https://${req.headers.host}`;

    // 1) Load offer
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(String(token))}` +
      `&select=id,request_id,is_active,service_date,slot_index,zone_code,start_time,end_time,window_label` +
      `&limit=1`;

    const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;

    if (!offerResp.ok || !offerRow) {
      return res.status(409).json({
        ok: false,
        error: "offer_not_found",
        message: "That appointment option is no longer available. Please pick another time.",
      });
    }

    if (offerRow.is_active === false) {
      return res.status(409).json({
        ok: false,
        error: "offer_inactive",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    const zoneCode = String(offerRow.zone_code || "").toUpperCase();
    const serviceDate = String(offerRow.service_date || "");
    if (!zoneCode || !serviceDate) {
      return res.status(409).json({
        ok: false,
        error: "bad_offer",
        message: "That appointment option is invalid. Please pick another time.",
      });
    }

    // 2) Compute offer window in UTC ISO
    const offerStartLocal = makeLocalTimestamptz(serviceDate, offerRow.start_time, tzOffset);
    const offerEndLocal = makeLocalTimestamptz(serviceDate, offerRow.end_time, tzOffset);

    const offerStartUtcIso = offerStartLocal ? toUtcIso(offerStartLocal) : null;
    const offerEndUtcIso = offerEndLocal ? toUtcIso(offerEndLocal) : null;

    if (!offerStartUtcIso || !offerEndUtcIso) {
      return res.status(409).json({
        ok: false,
        error: "bad_offer_times",
        message: "That appointment option is invalid. Please pick another time.",
      });
    }

    // 3) HARD BLOCK if any scheduled booking overlaps this window (UTC-safe)
    // overlap: booking.window_start < offerEnd AND booking.window_end > offerStart
    const overlapUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&status=eq.scheduled` +
      `&window_start=lt.${encodeURIComponent(offerEndUtcIso)}` +
      `&window_end=gt.${encodeURIComponent(offerStartUtcIso)}` +
      `&select=id,slot_code,window_start,window_end&limit=1`;

    const overlapResp = await sbFetchJson(overlapUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const overlapRow = Array.isArray(overlapResp.data) ? overlapResp.data[0] : null;

    if (!overlapResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "availability_check_failed",
        message: "Could not validate availability.",
      });
    }

    if (overlapRow) {
      return res.status(409).json({
        ok: false,
        error: "slot_already_booked",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    // 4) OPTIONAL extra: also check by your slot_code format (helps debug + consistency)
    const slotCode = buildSlotCode({
      zone: zoneCode,
      service_date: serviceDate,
      offerStartUtcIso,
      offerEndUtcIso,
    });

    const bySlotCodeUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&status=eq.scheduled` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&select=id&limit=1`;

    const bySlotCodeResp = await sbFetchJson(bySlotCodeUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const bySlotCodeRow = Array.isArray(bySlotCodeResp.data) ? bySlotCodeResp.data[0] : null;

    if (bySlotCodeResp.ok && bySlotCodeRow) {
      return res.status(409).json({
        ok: false,
        error: "slot_already_booked",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    // 5) Pull email from booking_requests so Stripe can send a receipt (if enabled in Stripe)
    let customerEmail = null;
    try {
      const reqUrl =
        `${SUPABASE_URL}/rest/v1/booking_requests` +
        `?id=eq.${encodeURIComponent(offerRow.request_id)}` +
        `&select=email&limit=1`;

      const reqResp = await sbFetchJson(reqUrl, { headers: sbHeaders(SERVICE_ROLE) });
      const reqRow = Array.isArray(reqResp.data) ? reqResp.data[0] : null;
      if (reqRow?.email) customerEmail = String(reqRow.email).trim();
    } catch {
      // ignore
    }

    // 6) Create Stripe checkout session
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
    const jobRef = makeJobRef();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Dryer Dudes — Dryer Repair Appointment" },
            unit_amount: 8000,
          },
          quantity: 1,
        },
      ],
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      success_url: `${origin}/payment-success.html?jobRef=${encodeURIComponent(jobRef)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?token=${encodeURIComponent(String(token))}`,
      metadata: {
        jobRef,
        offer_token: String(token),
        zone_code: zoneCode,
        slot_code: slotCode,
      },
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || String(err),
    });
  }
};
