// /api/verify-offer.js (CommonJS)
// Validates an offer token and checks live availability before checkout.

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

  const ztaResp = await sbFetchJson(ztaUrl, sbHeaders(serviceRole));
  const techId = ztaResp.ok && Array.isArray(ztaResp.data) ? ztaResp.data[0]?.tech_id : null;
  if (!techId) return { techId: null, slotId: null, slotRow: null };

  // First try exact zone match.
  const slotUrlWithZone =
    `${supabaseUrl}/rest/v1/slots` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&slot_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&zone=eq.${encodeURIComponent(String(zoneCode))}` +
    `&select=id,status&limit=1`;

  const slotRespWithZone = await sbFetchJson(slotUrlWithZone, sbHeaders(serviceRole));
  const slotRowWithZone = slotRespWithZone.ok && Array.isArray(slotRespWithZone.data) ? (slotRespWithZone.data[0] || null) : null;
  if (slotRowWithZone?.id) {
    return { techId: String(techId), slotId: String(slotRowWithZone.id), slotRow: slotRowWithZone };
  }

  // Fallback: zone can be null on older/backfilled rows.
  const slotUrlFallback =
    `${supabaseUrl}/rest/v1/slots` +
    `?tech_id=eq.${encodeURIComponent(String(techId))}` +
    `&slot_date=eq.${encodeURIComponent(String(serviceDate))}` +
    `&slot_index=eq.${encodeURIComponent(String(slotIndex))}` +
    `&select=id,status&limit=1`;

  const slotRespFallback = await sbFetchJson(slotUrlFallback, sbHeaders(serviceRole));
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

  const resp = await sbFetchJson(url, sbHeaders(serviceRole));
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

    const r = await sbFetchJson(slotIdUrl, sbHeaders(serviceRole));
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

  const r2 = await sbFetchJson(slotCodeUrl, sbHeaders(serviceRole));
  if (!r2.ok) return { exists: false, method: "fallback_failed" };

  const row2 = Array.isArray(r2.data) ? r2.data[0] : null;
  return { exists: !!row2, method: "slot_code_fallback" };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, code: "method_not_allowed", message: "Method Not Allowed" });
    }

    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, code: "missing_token", message: "Missing token." });

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
      return res.status(410).json({ ok: false, code: "expired", message: "This link has expired." });
    }

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

    let slotId = offerRow.slot_id ? String(offerRow.slot_id) : null;
    let slotRow = null;
    let techId = null;

    const resolved = await resolveSlot({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      zoneCode,
      serviceDate,
      slotIndex,
    });

    techId = resolved.techId;

    if (!slotId) {
      slotId = resolved.slotId;
      slotRow = resolved.slotRow;
    } else {
      const slotUrl =
        `${SUPABASE_URL}/rest/v1/slots` +
        `?id=eq.${encodeURIComponent(slotId)}` +
        `&select=id,status&limit=1`;
      const sResp = await sbFetchJson(slotUrl, sbHeaders(SERVICE_ROLE));
      slotRow = sResp.ok && Array.isArray(sResp.data) ? (sResp.data[0] || null) : null;
    }

    if (!slotId || !techId) {
      return res.status(409).json({ ok: false, code: "slot_not_found", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    const status = String(slotRow?.status || "").toLowerCase();
    if (status && status !== "open") {
      return res.status(409).json({ ok: false, code: "slot_taken", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    const offCheck = await isSlotTimeOff({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      techId,
      serviceDate,
      slotIndex,
    });

    if (offCheck.blocked) {
      return res.status(409).json({ ok: false, code: "slot_taken", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    const booked = await bookingExistsForSlot({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      slotId,
      offerRow,
    });

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
