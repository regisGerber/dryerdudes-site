// /api/create-checkout-session.js (CommonJS)
// Re-checks slot availability right before Stripe checkout session creation.

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

function slotCodeFromOffer(offerRow) {
  const d = String(offerRow?.service_date || "").trim();
  const i = Number(offerRow?.slot_index);
  if (!d || !Number.isFinite(i)) return null;
  return `${d}#${i}`;
}

async function resolveSlot({ supabaseUrl, serviceRole, zoneCode, serviceDate, slotIndex }) {
  const ztaUrl =
    `${supabaseUrl}/rest/v1/zone_tech_assignments` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&select=tech_id&limit=1`;

  const ztaResp = await sbFetchJson(ztaUrl, { headers: sbHeaders(serviceRole) });
  const techId = ztaResp.ok && Array.isArray(ztaResp.data) ? ztaResp.data[0]?.tech_id : null;
  if (!techId) return { techId: null, slotId: null, slotRow: null };

  const slotUrlWithZone =
    `${supabaseUrl}/rest/v1/slots` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&slot_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&zone=eq.${encodeURIComponent(String(zoneCode))}` +
    `&select=id,status&limit=1`;

  const slotRespWithZone = await sbFetchJson(slotUrlWithZone, { headers: sbHeaders(serviceRole) });
  const slotRowWithZone = slotRespWithZone.ok && Array.isArray(slotRespWithZone.data) ? (slotRespWithZone.data[0] || null) : null;
  if (slotRowWithZone?.id) {
    return { techId: String(techId), slotId: String(slotRowWithZone.id), slotRow: slotRowWithZone };
  }

  const slotUrlFallback =
    `${supabaseUrl}/rest/v1/slots` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&slot_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&select=id,status&limit=1`;

  const slotRespFallback = await sbFetchJson(slotUrlFallback, { headers: sbHeaders(serviceRole) });
  const slotRowFallback = slotRespFallback.ok && Array.isArray(slotRespFallback.data) ? (slotRespFallback.data[0] || null) : null;

  return {
    techId: String(techId),
    slotId: slotRowFallback?.id ? String(slotRowFallback.id) : null,
    slotRow: slotRowFallback,
  };
}

async function isSlotTimeOff({ supabaseUrl, serviceRole, techId, serviceDate, slotIndex }) {
  const url =
    `${supabaseUrl}/rest/v1/tech_time_off` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&service_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&select=id&limit=1`;

  const resp = await sbFetchJson(url, { headers: sbHeaders(serviceRole) });
  if (!resp.ok) return { blocked: false, error: true, details: resp.text };

  const row = Array.isArray(resp.data) ? resp.data[0] : null;
  return { blocked: !!row, error: false };
}

async function bookingExistsForSlot({ supabaseUrl, serviceRole, slotId, offerRow }) {
  if (slotId) {
    const slotIdUrl =
      `${supabaseUrl}/rest/v1/bookings` +
      `?slot_id=eq.${encodeURIComponent(String(slotId))}` +
      `&status=in.(scheduled,en_route,on_site,completed)` +
      `&select=id&limit=1`;

    const r = await sbFetchJson(slotIdUrl, { headers: sbHeaders(serviceRole) });
    if (r.ok) {
      const row = Array.isArray(r.data) ? r.data[0] : null;
      if (row) return { exists: true, method: "slot_id" };
    }
  }

  const slotCode = slotCodeFromOffer(offerRow);
  if (!slotCode) return { exists: false, method: "none" };

  const zoneCode = String(offerRow.zone_code || "").toUpperCase();
  const slotCodeUrl =
    `${supabaseUrl}/rest/v1/bookings` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&slot_code=eq.${encodeURIComponent(slotCode)}` +
    `&status=in.(scheduled,en_route,on_site,completed)` +
    `&select=id&limit=1`;

  const r2 = await sbFetchJson(slotCodeUrl, { headers: sbHeaders(serviceRole) });
  if (!r2.ok) return { exists: false, method: "fallback_failed" };

  const row2 = Array.isArray(r2.data) ? r2.data[0] : null;
  return { exists: !!row2, method: "slot_code_fallback" };
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

    const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
    const origin = envOrigin && /^https?:\/\//i.test(envOrigin) ? envOrigin : `https://${req.headers.host}`;

    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(String(token))}` +
      `&select=id,request_id,is_active,service_date,slot_index,zone_code,start_time,end_time,window_label,slot_id` +
      `&limit=1`;

    const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;

    if (!offerResp.ok || !offerRow) {
      return res.status(409).json({ ok: false, error: "offer_not_found", message: "That appointment option is no longer available. Please pick another time." });
    }
    if (offerRow.is_active === false) {
      return res.status(409).json({ ok: false, error: "offer_inactive", message: "That appointment option was already taken. Please pick another time." });
    }

    const zoneCode = String(offerRow.zone_code || "").toUpperCase();
    const serviceDate = String(offerRow.service_date || "");
    const slotIndex = Number(offerRow.slot_index);

    if (!zoneCode || !serviceDate || !Number.isFinite(slotIndex)) {
      return res.status(409).json({ ok: false, error: "bad_offer", message: "That appointment option is invalid. Please pick another time." });
    }

    let slotId = offerRow.slot_id ? String(offerRow.slot_id) : null;
    let slotRow = null;

    const resolved = await resolveSlot({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      zoneCode,
      serviceDate,
      slotIndex,
    });

    if (!slotId) {
      slotId = resolved.slotId;
      slotRow = resolved.slotRow;
    } else {
      const slotUrl =
        `${SUPABASE_URL}/rest/v1/slots` +
        `?id=eq.${encodeURIComponent(slotId)}` +
        `&select=id,status&limit=1`;

      const sResp = await sbFetchJson(slotUrl, { headers: sbHeaders(SERVICE_ROLE) });
      slotRow = sResp.ok && Array.isArray(sResp.data) ? (sResp.data[0] || null) : null;
    }

    const techId = resolved.techId;

    if (!slotId || !techId) {
      return res.status(409).json({ ok: false, error: "slot_not_found", message: "That appointment option is no longer available. Please pick another time." });
    }

    const status = String(slotRow?.status || "").toLowerCase();
    if (status && status !== "open") {
      return res.status(409).json({ ok: false, error: "slot_not_open", message: "That appointment option is no longer available. Please pick another time." });
    }

    const offCheck = await isSlotTimeOff({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      techId,
      serviceDate,
      slotIndex,
    });
    if (offCheck.blocked) {
      return res.status(409).json({ ok: false, error: "tech_time_off", message: "That appointment option is no longer available. Please pick another time." });
    }

    const booked = await bookingExistsForSlot({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      slotId,
      offerRow,
    });
    if (booked.exists) {
      return res.status(409).json({ ok: false, error: "slot_already_booked", message: "That appointment option was already taken. Please pick another time." });
    }

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
        slot_id: slotId,
        service_date: serviceDate,
        slot_index: String(slotIndex),
      },
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || String(err) });
  }
};
