// /api/verify-offer.js (FULL REPLACEMENT - CommonJS)
// Blocks if:
// - token missing/bad signature/expired
// - offer missing/inactive
// - slot_id cannot be resolved
// - slot.status != open
// - tech_time_off has exact (tech_id, service_date, slot_index)
// - bookings already has scheduled booking for slot_id (with safe fallback)

const crypto = require("crypto");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function base64urlToString(b64url) {
  const b64 =
    String(b64url || "").replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((String(b64url || "").length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

function sign(payloadB64url, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(payloadB64url)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    Accept: "application/json",
  };
}

async function sbFetchJson(url, headers) {
  const resp = await fetch(url, { headers });
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
  // "10:00:00" -> "1000"
  const s = String(t || "").slice(0, 5).replace(":", "");
  return s.length === 4 ? s : null;
}


async function resolveSlot({ supabaseUrl, serviceRole, zoneCode, serviceDate, slotIndex }) {
  // Find tech for zone
  const ztaUrl =
    `${supabaseUrl}/rest/v1/zone_tech_assignments` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&select=tech_id&limit=1`;

  const ztaResp = await sbFetchJson(ztaUrl, sbHeaders(serviceRole));
  const techId = (ztaResp.ok && Array.isArray(ztaResp.data)) ? ztaResp.data[0]?.tech_id : null;
  if (!techId) return { techId: null, slotId: null, slotRow: null };

  // Find slot row
  const slotUrl =
    `${supabaseUrl}/rest/v1/slots` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&slot_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&zone=eq.${encodeURIComponent(String(zoneCode))}` +
    `&select=id,status&limit=1`;

  const slotResp = await sbFetchJson(slotUrl, sbHeaders(serviceRole));
  const slotRow = (slotResp.ok && Array.isArray(slotResp.data)) ? (slotResp.data[0] || null) : null;
  const slotId = slotRow?.id ? String(slotRow.id) : null;

  return { techId: String(techId), slotId, slotRow };
}

async function isSlotTimeOff({ supabaseUrl, serviceRole, techId, serviceDate, slotIndex }) {
  // Exact match only (NO overlap!)
  const url =
    `${supabaseUrl}/rest/v1/tech_time_off` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&service_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&select=id&limit=1`;

  const resp = await sbFetchJson(url, sbHeaders(serviceRole));
  if (!resp.ok) {
    // If your tech_time_off table is protected by RLS for service role (unlikely), this will show up.
    // But service role should bypass RLS.
    return { blocked: false, error: true, details: resp.text };
  }

  const row = Array.isArray(resp.data) ? resp.data[0] : null;
  return { blocked: !!row, error: false };
}

// Block if booking exists for this slot_id (scheduled)
const bookingUrl =
  `${SUPABASE_URL}/rest/v1/bookings` +
  `?slot_id=eq.${encodeURIComponent(String(slotId))}` +
  `&status=eq.scheduled` +
  `&select=id&limit=1`;

const bookingResp = await sbFetchJson(bookingUrl, sbHeaders(SERVICE_ROLE));
if (!bookingResp.ok) {
  return res.status(500).json({ ok: false, code: "booking_check_failed", message: "Could not validate availability." });
}

const bookingRow = Array.isArray(bookingResp.data) ? bookingResp.data[0] : null;
if (bookingRow) {
  return res.status(409).json({
    ok: false,
    code: "slot_taken",
    message: "This time slot is no longer available. Please go back and choose another option.",
  });
}



  // Fallback: if bookings table doesn't have slot_id yet, try slot_code (older schema)
  const slotCode = slotCodeFromOffer(offerRow);
  if (!slotCode) return { exists: false, method: "none" };

  const zoneCode = String(offerRow.zone_code || "").toUpperCase();

  const slotCodeUrl =
    `${supabaseUrl}/rest/v1/bookings` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&slot_code=eq.${encodeURIComponent(slotCode)}` +
    `&status=eq.scheduled` +
    `&select=id&limit=1`;

  const r2 = await sbFetchJson(slotCodeUrl, sbHeaders(serviceRole));
  if (!r2.ok) return { exists: false, method: "fallback_failed" };

  const row2 = Array.isArray(r2.data) ? r2.data[0] : null;
  return { exists: !!row2, method: "slot_code_fallback" };
}

module.exports = async function handler(req, res) {
  try {
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, code: "missing_token", message: "Missing token." });

    // Validate signature
    const parts = token.split(".");
    if (parts.length !== 2) {
      return res.status(400).json({ ok: false, code: "bad_token_format", message: "Invalid link." });
    }
    const [payloadB64url, sig] = parts;
    const expected = sign(payloadB64url, TOKEN_SECRET);

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(400).json({ ok: false, code: "bad_signature", message: "Invalid link." });
    }

    let payload;
    try {
      payload = JSON.parse(base64urlToString(payloadB64url));
    } catch {
      return res.status(400).json({ ok: false, code: "bad_payload", message: "Invalid link." });
    }

    if (payload?.exp && Date.now() > Number(payload.exp)) {
      return res.status(400).json({ ok: false, code: "expired", message: "This link has expired." });
    }

    // Load offer
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(token)}` +
      `&select=id,request_id,offer_token,is_active,service_date,slot_index,zone_code,appointment_type,start_time,end_time,window_label,slot_id` +
      `&limit=1`;

    const offerResp = await sbFetchJson(offerUrl, sbHeaders(SERVICE_ROLE));
    if (!offerResp.ok) {
      return res.status(500).json({ ok: false, code: "offer_fetch_failed", message: "Could not load offer." });
    }

    const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;
    if (!offerRow) return res.status(404).json({ ok: false, code: "offer_not_found", message: "Offer not found." });

    if (offerRow.is_active === false) {
      return res.status(409).json({ ok: false, code: "slot_taken", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    const zoneCode = String(offerRow.zone_code || "").toUpperCase();
    const serviceDate = String(offerRow.service_date || "");
    const slotIndex = Number(offerRow.slot_index);

    if (!zoneCode || !serviceDate || !Number.isFinite(slotIndex)) {
      return res.status(409).json({ ok: false, code: "bad_offer", message: "This time slot is invalid. Please go back and choose another option." });
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
      // still need techId for time_off gate
      const resolved = await resolveSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, zoneCode, serviceDate, slotIndex });
      techId = resolved.techId;

      const slotUrl =
        `${SUPABASE_URL}/rest/v1/slots` +
        `?id=eq.${encodeURIComponent(slotId)}` +
        `&select=id,status&limit=1`;
      const sResp = await sbFetchJson(slotUrl, sbHeaders(SERVICE_ROLE));
      slotRow = (sResp.ok && Array.isArray(sResp.data)) ? (sResp.data[0] || null) : null;
    }

    if (!slotId || !techId) {
      return res.status(409).json({ ok: false, code: "slot_not_found", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    // Slot must be open
    const status = String(slotRow?.status || "").toLowerCase();
    if (status && status !== "open") {
      return res.status(409).json({ ok: false, code: "slot_taken", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    // Exact tech_time_off block (NO overlap)
    const offCheck = await isSlotTimeOff({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, techId, serviceDate, slotIndex });
    if (offCheck.blocked) {
      return res.status(409).json({ ok: false, code: "slot_taken", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    // Booked?
    const booked = await bookingExistsForSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, slotId, offerRow });
    if (booked.exists) {
      return res.status(409).json({ ok: false, code: "slot_taken", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    return res.status(200).json({
      ok: true,
      code: "ok",
      zone: zoneCode,
      appointment_type: offerRow.appointment_type || payload?.appointment_type || "standard",
      offer: { ...offerRow, slot_id: slotId, resolved_tech_id: techId },
      payload,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "server_error", message: err?.message || String(err) });
  }
};
