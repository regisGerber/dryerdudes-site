// /api/verify-offer.js (FULL REPLACEMENT - CommonJS)
// Verifies signed offer token and blocks if:
// - offer missing/inactive
// - booked slot overlap exists
// - assigned tech has time off overlap

const crypto = require("crypto");

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

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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

function toUtcIso(localTimestamptz) {
  const d = new Date(localTimestamptz);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

async function getAssignedTechIdForZone({ SUPABASE_URL, SERVICE_ROLE, zoneCode }) {
  const url =
    `${SUPABASE_URL}/rest/v1/zone_tech_assignments` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&select=tech_id&limit=1`;

  const r = await sbFetchJson(url, sbHeaders(SERVICE_ROLE));
  if (!r.ok) throw new Error(`zone_tech_assignments fetch failed (${r.status}): ${r.text}`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  return row?.tech_id || null;
}

async function techHasTimeOffOverlap({ SUPABASE_URL, SERVICE_ROLE, techId, offerStartUtcIso, offerEndUtcIso }) {
  if (!techId) return false;

  const url =
    `${SUPABASE_URL}/rest/v1/tech_time_off` +
    `?tech_id=eq.${encodeURIComponent(techId)}` +
    `&start_ts=lt.${encodeURIComponent(offerEndUtcIso)}` +
    `&end_ts=gt.${encodeURIComponent(offerStartUtcIso)}` +
    `&select=id,type,start_ts,end_ts&limit=1`;

  const r = await sbFetchJson(url, sbHeaders(SERVICE_ROLE));
  if (!r.ok) throw new Error(`tech_time_off fetch failed (${r.status}): ${r.text}`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  return !!row;
}

module.exports = async function handler(req, res) {
  try {
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, code: "missing_token", message: "Missing token." });
    }

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
      `&select=id,request_id,offer_token,is_active,service_date,zone_code,appointment_type,start_time,end_time,window_label`;

    const offerResp = await sbFetchJson(offerUrl, sbHeaders(SERVICE_ROLE));
    if (!offerResp.ok) {
      return res.status(500).json({ ok: false, code: "offer_fetch_failed", message: "Could not load offer." });
    }

    const offerRow = Array.isArray(offerResp.data) ? (offerResp.data[0] ?? null) : null;
    if (!offerRow) {
      return res.status(404).json({ ok: false, code: "offer_not_found", message: "Offer not found." });
    }

    if (offerRow.is_active === false) {
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    const zoneCode = String(offerRow.zone_code || "").toUpperCase();
    const serviceDate = String(offerRow.service_date || "");
    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");

    const offerStartLocal = makeLocalTimestamptz(serviceDate, offerRow.start_time, tzOffset);
    const offerEndLocal = makeLocalTimestamptz(serviceDate, offerRow.end_time, tzOffset);
    const offerStartUtcIso = offerStartLocal ? toUtcIso(offerStartLocal) : null;
    const offerEndUtcIso = offerEndLocal ? toUtcIso(offerEndLocal) : null;

    if (!zoneCode || !serviceDate || !offerStartUtcIso || !offerEndUtcIso) {
      return res.status(409).json({
        ok: false,
        code: "bad_offer",
        message: "This time slot is invalid. Please go back and choose another option.",
      });
    }

    // Block if scheduled booking overlaps window
    const overlapUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&status=eq.scheduled` +
      `&window_start=lt.${encodeURIComponent(offerEndUtcIso)}` +
      `&window_end=gt.${encodeURIComponent(offerStartUtcIso)}` +
      `&select=id&limit=1`;

    const overlapResp = await sbFetchJson(overlapUrl, sbHeaders(SERVICE_ROLE));
    if (!overlapResp.ok) {
      return res.status(500).json({ ok: false, code: "booking_check_failed", message: "Could not validate availability." });
    }

    const overlapRow = Array.isArray(overlapResp.data) ? (overlapResp.data[0] ?? null) : null;
    if (overlapRow) {
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    // Block if assigned tech is off
    const techId = await getAssignedTechIdForZone({ SUPABASE_URL, SERVICE_ROLE, zoneCode });

    const off = await techHasTimeOffOverlap({
      SUPABASE_URL,
      SERVICE_ROLE,
      techId,
      offerStartUtcIso,
      offerEndUtcIso,
    });

    if (off) {
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    return res.status(200).json({
      ok: true,
      code: "ok",
      zone: zoneCode,
      appointment_type: offerRow.appointment_type || payload?.appointment_type || "standard",
      offer: offerRow,
      payload,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: "server_error",
      message: err?.message || String(err),
    });
  }
};
