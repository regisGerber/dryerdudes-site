// /api/create-checkout-session.js (FULL REPLACEMENT - CommonJS)
// Gates BEFORE Stripe using slot_id + slots.status + bookings(scheduled).
// Also sets customer_email so Stripe sends receipts/refunds.

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

async function resolveSlotId({ supabaseUrl, serviceRole, zoneCode, serviceDate, slotIndex }) {
  const ztaUrl =
    `${supabaseUrl}/rest/v1/zone_tech_assignments` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&select=tech_id&limit=1`;

  const ztaResp = await sbFetchJson(ztaUrl, { headers: sbHeaders(serviceRole) });
  const techId = (ztaResp.ok && Array.isArray(ztaResp.data)) ? ztaResp.data[0]?.tech_id : null;
  if (!techId) return { slotId: null };

  const slotUrl =
    `${supabaseUrl}/rest/v1/slots` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&slot_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&zone=eq.${encodeURIComponent(String(zoneCode))}` +
    `&select=id,status&limit=1`;

  const slotResp = await sbFetchJson(slotUrl, { headers: sbHeaders(serviceRole) });
  const slotRow = (slotResp.ok && Array.isArray(slotResp.data)) ? (slotResp.data[0] || null) : null;
  if (!slotRow?.id) return { slotId: null };

  return { slotId: String(slotRow.id), slotRow };
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
    const slotIndex = Number(offerRow.slot_index);

    if (!zoneCode || !serviceDate || !Number.isFinite(slotIndex)) {
      return res.status(409).json({
        ok: false,
        error: "bad_offer",
        message: "That appointment option is invalid. Please pick another time.",
      });
    }

    // Resolve slot_id if missing
    let slotId = offerRow.slot_id ? String(offerRow.slot_id) : null;
    let slotRow = null;

    if (!slotId) {
      const resolved = await resolveSlotId({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        zoneCode,
        serviceDate,
        slotIndex,
      });
      slotId = resolved.slotId;
      slotRow = resolved.slotRow || null;

      if (!slotId) {
        return res.status(409).json({
          ok: false,
          error: "slot_not_found",
          message: "That appointment option is no longer available. Please pick another time.",
        });
      }
    } else {
      const slotUrl =
        `${SUPABASE_URL}/rest/v1/slots` +
        `?id=eq.${encodeURIComponent(slotId)}` +
        `&select=id,status&limit=1`;
      const sResp = await sbFetchJson(slotUrl, { headers: sbHeaders(SERVICE_ROLE) });
      slotRow = (sResp.ok && Array.isArray(sResp.data)) ? (sResp.data[0] || null) : null;
    }

    // Slot must be open
    const status = String(slotRow?.status || "").toLowerCase();
    if (status && status !== "open") {
      return res.status(409).json({
        ok: false,
        error: "slot_not_open",
        message: "That appointment option is no longer available. Please pick another time.",
      });
    }

    // Block if already booked (slot_id)
    const bookingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?slot_id=eq.${encodeURIComponent(slotId)}` +
      `&status=eq.scheduled` +
      `&select=id&limit=1`;

    const bookingResp = await sbFetchJson(bookingUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!bookingResp.ok) {
      return res.status(500).json({ ok: false, error: "availability_check_failed", message: "Could not validate availability." });
    }

    const bookingRow = Array.isArray(bookingResp.data) ? bookingResp.data[0] : null;
    if (bookingRow) {
      return res.status(409).json({
        ok: false,
        error: "slot_already_booked",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    // Optional: slot_blocks(slot_id)
    try {
      const blockUrl =
        `${SUPABASE_URL}/rest/v1/slot_blocks` +
        `?slot_id=eq.${encodeURIComponent(slotId)}` +
        `&select=id&limit=1`;

      const blockResp = await sbFetchJson(blockUrl, { headers: sbHeaders(SERVICE_ROLE) });
      if (blockResp.ok) {
        const blockRow = Array.isArray(blockResp.data) ? blockResp.data[0] : null;
        if (blockRow) {
          return res.status(409).json({
            ok: false,
            error: "slot_blocked",
            message: "That appointment option is no longer available. Please pick another time.",
          });
        }
      }
    } catch {}

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
