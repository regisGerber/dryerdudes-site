// /api/create-checkout-session.js (FULL REPLACEMENT - CommonJS)
// Bulletproof gate BEFORE Stripe Checkout:
// - offer must exist + is_active=true
// - block if booking already exists for same slot (booked statuses)
//   - primary check: zone_code + slot_code
//   - fallback check: zone_code + window_start + window_end (for legacy rows missing slot_code)
// - pass customer_email to Stripe when available (helps Stripe email receipts)

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

function computeSlotCode(service_date, slot_index) {
  return `${service_date}#${Number(slot_index)}`;
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

function toIsoZ(isoWithOffset) {
  const d = new Date(isoWithOffset);
  if (isNaN(d.getTime())) return null;
  return d.toISOString(); // canonical UTC
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

    // Respect SITE_ORIGIN when set, otherwise host
    const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
    const origin = envOrigin && /^https?:\/\//i.test(envOrigin)
      ? envOrigin
      : `https://${req.headers.host}`;

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
    const slotCode = computeSlotCode(offerRow.service_date, offerRow.slot_index);

    const windowStartLocal = makeLocalTimestamptz(offerRow.service_date, offerRow.start_time, tzOffset);
    const windowEndLocal = makeLocalTimestamptz(offerRow.service_date, offerRow.end_time, tzOffset);

    const windowStartZ = windowStartLocal ? toIsoZ(windowStartLocal) : null;
    const windowEndZ = windowEndLocal ? toIsoZ(windowEndLocal) : null;

    if (!zoneCode || !offerRow.service_date || !Number.isFinite(Number(offerRow.slot_index))) {
      return res.status(409).json({
        ok: false,
        error: "bad_offer",
        message: "That appointment option is invalid. Please pick another time.",
      });
    }

    // 2) Booked statuses (matches your scheduler logic)
    const bookedStatuses = ["scheduled", "en_route", "on_site", "completed"];
    const statusIn = `(${bookedStatuses.map((s) => `"${s}"`).join(",")})`; // PostgREST in.(...)

    // 2a) Primary: check by zone + slot_code
    const bySlotCodeUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&status=in.${encodeURIComponent(statusIn)}` +
      `&select=id&limit=1`;

    const bySlotCodeResp = await sbFetchJson(bySlotCodeUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!bySlotCodeResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "supabase_check_failed",
        message: "Could not validate availability.",
        details: bySlotCodeResp.text,
      });
    }

    const existingBySlotCode = Array.isArray(bySlotCodeResp.data) ? bySlotCodeResp.data[0] : null;
    if (existingBySlotCode) {
      return res.status(409).json({
        ok: false,
        error: "slot_already_booked",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    // 2b) Fallback: check by exact window_start/window_end (covers legacy rows missing slot_code)
    if (windowStartZ && windowEndZ) {
      const byWindowUrl =
        `${SUPABASE_URL}/rest/v1/bookings` +
        `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
        `&window_start=eq.${encodeURIComponent(windowStartZ)}` +
        `&window_end=eq.${encodeURIComponent(windowEndZ)}` +
        `&status=in.${encodeURIComponent(statusIn)}` +
        `&select=id&limit=1`;

      const byWindowResp = await sbFetchJson(byWindowUrl, { headers: sbHeaders(SERVICE_ROLE) });
      if (!byWindowResp.ok) {
        return res.status(500).json({
          ok: false,
          error: "supabase_check_failed",
          message: "Could not validate availability.",
          details: byWindowResp.text,
        });
      }

      const existingByWindow = Array.isArray(byWindowResp.data) ? byWindowResp.data[0] : null;
      if (existingByWindow) {
        return res.status(409).json({
          ok: false,
          error: "slot_already_booked",
          message: "That appointment option was already taken. Please pick another time.",
        });
      }
    }

    // 3) Fetch booking request to pass customer_email (helps Stripe send receipts)
    let customerEmail = null;
    let customerPhone = null;
    try {
      const reqUrl =
        `${SUPABASE_URL}/rest/v1/booking_requests` +
        `?id=eq.${encodeURIComponent(offerRow.request_id)}` +
        `&select=email,phone&limit=1`;

      const reqResp = await sbFetchJson(reqUrl, { headers: sbHeaders(SERVICE_ROLE) });
      const reqRow = Array.isArray(reqResp.data) ? reqResp.data[0] : null;
      if (reqRow?.email) customerEmail = String(reqRow.email).trim();
      if (reqRow?.phone) customerPhone = String(reqRow.phone).trim();
    } catch {
      // ignore
    }

    // 4) Create Stripe Checkout session
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
    const jobRef = makeJobRef();

    const sessionParams = {
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
      success_url: `${origin}/payment-success.html?jobRef=${encodeURIComponent(jobRef)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?token=${encodeURIComponent(String(token))}`,
      metadata: {
        jobRef,
        offer_token: String(token),
        zone_code: zoneCode,
        slot_code: slotCode,
      },
    };

    if (customerEmail) {
      sessionParams.customer_email = customerEmail;
    }

    // Optional: store phone in metadata (useful for support)
    if (customerPhone) {
      sessionParams.metadata.phone = customerPhone;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

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
