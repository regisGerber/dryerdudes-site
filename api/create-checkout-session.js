// /api/create-checkout-session.js (FULL REPLACEMENT - CommonJS)
// Gate BEFORE Stripe using slot_code exact match (NOT overlap).
// slot_code computed in UTC HHMM to match bookings.slot_code.

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

function parseHHMMSS(t) {
  const raw = String(t || "").trim();
  const m = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

// Convert LOCAL date+time with fixed offset -> UTC HHMM
function localToUtcHHMM(serviceDate, timeHHMMSS, tzOffset) {
  const p = parseHHMMSS(timeHHMMSS);
  if (!serviceDate || !p) return null;

  const hh = String(p.hh).padStart(2, "0");
  const mm = String(p.mm).padStart(2, "0");

  const iso = `${serviceDate}T${hh}:${mm}:00${tzOffset}`;
  const d = new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;

  const uh = String(d.getUTCHours()).padStart(2, "0");
  const um = String(d.getUTCMinutes()).padStart(2, "0");
  return `${uh}${um}`;
}

function slotCodeFromOfferUtc(offerRow, tzOffset) {
  const zone = String(offerRow.zone_code || "").toUpperCase();
  const d = String(offerRow.service_date || "").trim();
  if (!zone || !d) return null;

  const utcStart = localToUtcHHMM(d, offerRow.start_time, tzOffset);
  const utcEnd = localToUtcHHMM(d, offerRow.end_time, tzOffset);
  if (!utcStart || !utcEnd) return null;

  return `${zone}-${d}-${utcStart}-${utcEnd}`;
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

    // IMPORTANT: fixed offset for *current season* (PST: -08:00, PDT: -07:00)
    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00").trim();

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
    const slotCode = slotCodeFromOfferUtc(offerRow, tzOffset);

    if (!zoneCode || !slotCode) {
      return res.status(409).json({
        ok: false,
        error: "bad_offer",
        message: "That appointment option is invalid. Please pick another time.",
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

    // Pull email for Stripe receipts (if present)
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

      // This is what allows Stripe receipt emails (IF receipts enabled in Stripe settings)
      ...(customerEmail ? { customer_email: customerEmail } : {}),

      success_url: `${origin}/payment-success.html?jobRef=${encodeURIComponent(jobRef)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?token=${encodeURIComponent(String(token))}`,

      metadata: {
        jobRef,
        offer_token: String(token),
        zone_code: zoneCode,
        slot_code: slotCode,
        tz_offset_used: tzOffset,
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
