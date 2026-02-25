// /api/create-checkout-session.js (FULL REPLACEMENT - CommonJS)
// Gates BEFORE Stripe using:
// - offer active
// - slot resolves (slot_id)
// - slot.status == open
// - tech_time_off exact (tech_id, service_date, slot_index)
// - no scheduled booking already exists for slot_id (fallback to slot_code if needed)
// Sets customer_email for Stripe receipts/refunds.

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

function hhmmFromTime(t) {
  const s = String(t || "").slice(0, 5).replace(":", "");
  return s.length === 4 ? s : null;
}

function slotCodeFromOffer(offerRow) {
  const zone = String(offerRow.zone_code || "").toUpperCase();
  const d = String(offerRow.service_date || "");
  const s = hhmmFromTime(offerRow.start_time);
  const e = hhmmFromTime(offerRow.end_time);
  if (!zone || !d || !s || !e) return null;
  return `${zone}-${d}-${s}-${e}`;
}

async function resolveSlot({ supabaseUrl, serviceRole, zoneCode, serviceDate, slotIndex }) {
  const ztaUrl =
    `${supabaseUrl}/rest/v1/zone_tech_assignments` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&select=tech_id&limit=1`;

  const ztaResp = await sbFetchJson(ztaUrl, { headers: sbHeaders(serviceRole) });
  const techId = (ztaResp.ok && Array.isArray(ztaResp.data)) ? ztaResp.data[0]?.tech_id : null;
  if (!techId) return { techId: null, slotId: null, slotRow: null };

  const slotUrl =
    `${supabaseUrl}/rest/v1/slots` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&slot_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&zone=eq.${encodeURIComponent(String(zoneCode))}` +
    `&select=id,status&limit=1`;

  const slotResp = await sbFetchJson(slotUrl, { headers: sbHeaders(serviceRole) });
  const slotRow = (slotResp.ok && Array.isArray(slotResp.data)) ? (slotResp.data[0] || null) : null;
  const slotId = slotRow?.id ? String(slotRow.id) : null;

  return { techId: String(techId), slotId, slotRow };
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
  const slotIdUrl =
    `${supabaseUrl}/rest/v1/bookings` +
    `?slot_id=eq.${encodeURIComponent(String(slotId))}` +
    `&status=eq.scheduled` +
    `&select=id&limit=1`;

  const r1 = await sbFetchJson(slotIdUrl, { headers: sbHeaders(serviceRole) });
  if (r1.ok) {
    const row = Array.isArray(r1.data) ? r1.data[0] : null;
    return { exists: !!row, method: "slot_id" };
  }

  // Fallback if slot_id column not present yet
  const slotCode = slotCodeFromOffer(offerRow);
  if (!slotCode) return { exists: false, method: "none" };

  const zoneCode = String(offerRow.zone_code || "").toUpperCase();
  const slotCodeUrl =
    `${supabaseUrl}/rest/v1/bookings` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&slot_code=eq.${encodeURIComponent(slotCode)}` +
    `&status=eq.scheduled` +
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

    // Load offer
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

    // Resolve slot_id if missing
    let slotId = offerRow.slot_id ? String(offerRow.slot_id) : null;
    let slotRow = null;
    let techId = null;

    if (!slotId) {
      const resolved = await resolveSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, zoneCode, serviceDate, slotIndex });
      slotId = resolved.slotId;
      slotRow = resolved.slotRow;
      techId = resolved.techId;
    } else {
      const resolved = await resolveSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, zoneCode, serviceDate, slotIndex });
      techId = resolved.techId;

      const slotUrl =
        `${SUPABASE_URL}/rest/v1/slots` +
        `?id=eq.${encodeURIComponent(slotId)}` +
        `&select=id,status&limit=1`;

      const sResp = await sbFetchJson(slotUrl, { headers: sbHeaders(SERVICE_ROLE) });
      slotRow = (sResp.ok && Array.isArray(sResp.data)) ? (sResp.data[0] || null) : null;
    }

    if (!slotId || !techId) {
      return res.status(409).json({ ok: false, error: "slot_not_found", message: "That appointment option is no longer available. Please pick another time." });
    }

    // Slot must be open
    const status = String(slotRow?.status || "").toLowerCase();
    if (status && status !== "open") {
      return res.status(409).json({ ok: false, error: "slot_not_open", message: "That appointment option is no longer available. Please pick another time." });
    }

    // Exact tech_time_off block (NO overlap)
    const offCheck = await isSlotTimeOff({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, techId, serviceDate, slotIndex });
    if (offCheck.blocked) {
      return res.status(409).json({ ok: false, error: "tech_time_off", message: "That appointment option is no longer available. Please pick another time." });
    }

    // Booked?
    const booked = await bookingExistsForSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, slotId, offerRow });
    if (booked.exists) {
      return res.status(409).json({ ok: false, error: "slot_already_booked", message: "That appointment option was already taken. Please pick another time." });
    }

    // Pull email for Stripe receipts
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
