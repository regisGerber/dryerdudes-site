// /api/verify-offer.js (FULL REPLACEMENT - CommonJS)
// Blocks if:
// - offer missing/inactive
// - booking exists for same zone_code + slot_code
// - slot_blocks contains same zone_code + slot_code (time off)

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
  // Prefer offer.slot_code if you add it later
  // Otherwise build from zone + service_date + start/end like your bookings do.
  // IMPORTANT: must match the exact string format stored in bookings.slot_code.
  //
  // You showed: "B-2026-02-23-1600-1800"
  // That implies:
  // zone "-" YYYY-MM-DD "-" HHMM "-" HHMM  (24h, local->UTC already baked in your booking row)
  //
  // Your offer has start_time/end_time like "13:00:00" etc.
  // We'll create HHMM from that directly (local schedule HHMM).
  const zone = String(offerRow.zone_code || "").toUpperCase();
  const d = String(offerRow.service_date || "");
  const s = String(offerRow.start_time || "").slice(0, 5).replace(":", ""); // "13:00" -> "1300"
  const e = String(offerRow.end_time || "").slice(0, 5).replace(":", "");
  if (!zone || !d || s.length !== 4 || e.length !== 4) return null;
  return `${zone}-${d}-${s}-${e}`;
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
    if (parts.length !== 2) return res.status(400).json({ ok: false, code: "bad_token_format", message: "Invalid link." });

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

    // Offer row
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(token)}` +
      `&select=id,request_id,offer_token,is_active,service_date,zone_code,appointment_type,start_time,end_time,window_label&limit=1`;

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
    const slotCode = slotCodeFromOffer(offerRow);

    if (!zoneCode || !slotCode) {
      return res.status(409).json({ ok: false, code: "bad_offer", message: "This time slot is invalid. Please go back and choose another option." });
    }

    // 1) Block if booking exists for same slot_code in that zone
    const bookingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&status=eq.scheduled` +
      `&select=id&limit=1`;

    const bookingResp = await sbFetchJson(bookingUrl, sbHeaders(SERVICE_ROLE));
    if (!bookingResp.ok) {
      return res.status(500).json({ ok: false, code: "booking_check_failed", message: "Could not validate availability." });
    }
    const bookingRow = Array.isArray(bookingResp.data) ? bookingResp.data[0] : null;
    if (bookingRow) {
      return res.status(409).json({ ok: false, code: "slot_taken", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    // 2) Block if time-off block exists
    const blockUrl =
      `${SUPABASE_URL}/rest/v1/slot_blocks` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&select=id&limit=1`;

    const blockResp = await sbFetchJson(blockUrl, sbHeaders(SERVICE_ROLE));
    if (!blockResp.ok) {
      return res.status(500).json({ ok: false, code: "block_check_failed", message: "Could not validate availability." });
    }
    const blockRow = Array.isArray(blockResp.data) ? blockResp.data[0] : null;
    if (blockRow) {
      return res.status(409).json({ ok: false, code: "slot_taken", message: "This time slot is no longer available. Please go back and choose another option." });
    }

    return res.status(200).json({
      ok: true,
      code: "ok",
      zone: zoneCode,
      appointment_type: offerRow.appointment_type || payload?.appointment_type || "standard",
      offer: { ...offerRow, slot_code: slotCode },
      payload,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "server_error", message: err?.message || String(err) });
  }
};
