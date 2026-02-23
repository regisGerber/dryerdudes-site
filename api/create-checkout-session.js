// /api/create-checkout-session.js (FULL REPLACEMENT - CommonJS)
// Gate BEFORE Stripe using slot_code exact match (NOT overlap).
// slot_code is computed in UTC HHMM to match existing bookings.slot_code.

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

function pad2(n) {
  return String(n).padStart(2, "0");
}

function utcHHMM(service_date, hhmmss, tzOffset) {
  const d = String(service_date || "").trim();
  const t = String(hhmmss || "").trim().slice(0, 5); // "HH:MM"
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (!/^\d{2}:\d{2}$/.test(t)) return null;

  const iso = `${d}T${t}:00${tzOffset}`;
  const dt = new Date(iso);
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return null;

  return `${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}`;
}

function slotCodeFromOffer(offerRow) {
  if (offerRow && typeof offerRow.slot_code === "string" && offerRow.slot_code.trim()) {
    return offerRow.slot_code.trim();
  }

  const zone = String(offerRow.zone_code || "").toUpperCase();
  const serviceDate = String(offerRow.service_date || "").trim();
  const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00").trim();

  const sUtc = utcHHMM(serviceDate, offerRow.start_time, tzOffset);
  const eUtc = utcHHMM(serviceDate, offerRow.end_time, tzOffset);

  if (!zone || !serviceDate || !sUtc || !eUtc) return null;
  return `${zone}-${serviceDate}-${sUtc}-${eUtc}`;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

    const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
    const origin =
      envOrigin && /^https?:\/\//i.test(envOrigin) ? envOrigin : `https://${req.headers.host}`;

    // Offer
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(String(token))}` +
      `&select=id,request_id,is_active,service_date,zone_code,start_time,end_time,window_label` +
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
    const slotCode = slotCodeFromOffer(offerRow);
    if (!zoneCode || !slotCode) {
      return res.status(409).json({
        ok: false,
        error: "bad_offer",
        message: "Could not validate availability. Please pick another time.",
      });
    }

    // 1) booked?
    const bookingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&status=eq.scheduled` +
      `&select=id&limit=1`;

    const bookingResp = await sbFetchJson(bookingUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!bookingResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "availability_check_failed",
        message: "Could not validate availability.",
        details: bookingResp.text,
      });
    }

    const bookingRow = Array.isArray(bookingResp.data) ? bookingResp.data[0] : null;
    if (bookingRow) {
      return res.status(409).json({
        ok: false,
        error: "slot_already_booked",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    // 2) time-off block?
    const blockUrl =
      `${SUPABASE_URL}/rest/v1/slot_blocks` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&select=id&limit=1`;

    const blockResp = await sbFetchJson(blockUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!blockResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "block_check_failed",
        message: "Could not validate availability.",
        details: blockResp.text,
      });
    }

    const blockRow = Array.isArray(blockResp.data) ? blockResp.data[0] : null;
    if (blockRow) {
      return res.status(409).json({
        ok: false,
        error: "tech_time_off",
        message: "That appointment option is no longer available. Please pick another time.",
      });
    }

    // Pull email for Stripe receipts (so customer gets Stripe receipt + refund emails)
    let customerEmail = null;
    try {
      const reqUrl =
        `${SUPABASE_URL}/rest/v1/booking_requests` +
        `?id=eq.${encodeURIComponent(offerRow.request_id)}` +
        `&select=email&limit=1`;
      const reqResp = await sbFetchJson(reqUrl, { headers: sbHeaders(SERVICE_ROLE) });
      const reqRow = Array.isArray(reqResp.data) ? reqResp.data[0] : null;
      if (reqRow?.email) customerEmail = String(reqRow.email).trim();
    } catch {}

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
