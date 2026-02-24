// /api/verify-offer.js (FULL REPLACEMENT - CommonJS)
// Blocks if:
// - offer missing/inactive/expired/bad signature
// - slot cannot be resolved
// - slot is not open
// - booking exists for same slot_id (scheduled)
// - (optional) slot_blocks has slot_id match (if your table has slot_id)

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

// Resolve slot_id safely (today: one territory per zone via zone_tech_assignments)
async function resolveSlotId({ supabaseUrl, serviceRole, zoneCode, serviceDate, slotIndex }) {
  // 1) Find tech for zone
  const ztaUrl =
    `${supabaseUrl}/rest/v1/zone_tech_assignments` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&select=tech_id&limit=1`;

  const ztaResp = await sbFetchJson(ztaUrl, sbHeaders(serviceRole));
  if (!ztaResp.ok) return { slotId: null, reason: "zta_fetch_failed", details: ztaResp.text };

  const techId = Array.isArray(ztaResp.data) ? ztaResp.data[0]?.tech_id : null;
  if (!techId) return { slotId: null, reason: "zta_missing" };

  // 2) Find matching slot
  const slotUrl =
    `${supabaseUrl}/rest/v1/slots` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&slot_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&zone=eq.${encodeURIComponent(String(zoneCode))}` +
    `&select=id,status,hold_expires_at&limit=1`;

  const slotResp = await sbFetchJson(slotUrl, sbHeaders(serviceRole));
  if (!slotResp.ok) return { slotId: null, reason: "slot_fetch_failed", details: slotResp.text };

  const slotRow = Array.isArray(slotResp.data) ? slotResp.data[0] : null;
  if (!slotRow?.id) return { slotId: null, reason: "slot_not_found" };

  return { slotId: String(slotRow.id), slotRow };
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
    if (sigBuf.length !== expBuf.length) {
      return res.status(400).json({ ok: false, code: "bad_signature", message: "Invalid link." });
    }
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
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

    // Load offer row
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
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    const zoneCode = String(offerRow.zone_code || "").toUpperCase();
    const serviceDate = String(offerRow.service_date || "");
    const slotIndex = Number(offerRow.slot_index);

    if (!zoneCode || !serviceDate || !Number.isFinite(slotIndex)) {
      return res.status(409).json({
        ok: false,
        code: "bad_offer",
        message: "This time slot is invalid. Please go back and choose another option.",
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
          code: "slot_not_found",
          message: "This time slot is no longer available. Please go back and choose another option.",
        });
      }
    } else {
      // Load slot status
      const slotUrl =
        `${SUPABASE_URL}/rest/v1/slots` +
        `?id=eq.${encodeURIComponent(slotId)}` +
        `&select=id,status,hold_expires_at&limit=1`;

      const sResp = await sbFetchJson(slotUrl, sbHeaders(SERVICE_ROLE));
      slotRow = (sResp.ok && Array.isArray(sResp.data)) ? (sResp.data[0] || null) : null;
    }

    // Slot must be open
    const status = String(slotRow?.status || "").toLowerCase();
    if (status && status !== "open") {
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    // Block if booking exists for this slot_id
    const bookingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?slot_id=eq.${encodeURIComponent(slotId)}` +
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

    // Optional: slot_blocks by slot_id (if your table has that column)
    // If the query fails due to missing column, we ignore it (safe).
    try {
      const blockUrl =
        `${SUPABASE_URL}/rest/v1/slot_blocks` +
        `?slot_id=eq.${encodeURIComponent(slotId)}` +
        `&select=id&limit=1`;

      const blockResp = await sbFetchJson(blockUrl, sbHeaders(SERVICE_ROLE));
      if (blockResp.ok) {
        const blockRow = Array.isArray(blockResp.data) ? blockResp.data[0] : null;
        if (blockRow) {
          return res.status(409).json({
            ok: false,
            code: "slot_taken",
            message: "This time slot is no longer available. Please go back and choose another option.",
          });
        }
      }
    } catch {}

    return res.status(200).json({
      ok: true,
      code: "ok",
      zone: zoneCode,
      appointment_type: offerRow.appointment_type || payload?.appointment_type || "standard",
      offer: { ...offerRow, slot_id: slotId },
      payload,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "server_error", message: err?.message || String(err) });
  }
};
