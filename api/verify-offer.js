// /api/verify-offer.js (FULL REPLACEMENT — CommonJS)
// Validates the offer token before showing checkout page:
// - verifies token signature + exp
// - checks offer exists + is_active
// - checks slot not started
// - checks not already booked (slot_code + booked statuses)
// - checks assigned tech not on time off
// - deactivates offer (and slot offers) when invalid so old links die fast

const crypto = require("crypto");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function base64urlToString(b64url) {
  const s = String(b64url || "");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
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

function parseAndVerifyToken(token, secret) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 2) return { ok: false, code: "bad_token_format" };
  const [payloadB64url, sig] = parts;

  const expected = sign(payloadB64url, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return { ok: false, code: "bad_signature" };
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return { ok: false, code: "bad_signature" };

  let payload;
  try {
    payload = JSON.parse(base64urlToString(payloadB64url));
  } catch {
    return { ok: false, code: "bad_payload" };
  }

  if (payload?.exp && Date.now() > Number(payload.exp)) {
    return { ok: false, code: "expired", payload };
  }

  return { ok: true, payload };
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

function computeSlotCode(service_date, slot_index) {
  return `${service_date}#${slot_index}`;
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

function toMs(isoString) {
  const d = new Date(isoString);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function rangesOverlapMs(aStartMs, aEndMs, bStartMs, bEndMs) {
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

async function deactivateOfferByToken({ supabaseUrl, serviceRole, token }) {
  const url = `${supabaseUrl}/rest/v1/booking_request_offers?offer_token=eq.${encodeURIComponent(token)}`;
  await sbFetchJson(url, {
    method: "PATCH",
    headers: { ...sbHeaders(serviceRole), Prefer: "return=minimal" },
    body: JSON.stringify({ is_active: false }),
  });
}

async function invalidateAllOffersForSlot({ supabaseUrl, serviceRole, zoneCode, serviceDate, slotIndex }) {
  const url =
    `${supabaseUrl}/rest/v1/booking_request_offers` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&service_date=eq.${encodeURIComponent(serviceDate)}` +
    `&slot_index=eq.${encodeURIComponent(slotIndex)}`;
  await sbFetchJson(url, {
    method: "PATCH",
    headers: { ...sbHeaders(serviceRole), Prefer: "return=minimal" },
    body: JSON.stringify({ is_active: false }),
  });
}

module.exports = async function handler(req, res) {
  try {
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, code: "missing_token", message: "Missing token." });
    }

    const tv = parseAndVerifyToken(token, TOKEN_SECRET);
    if (!tv.ok) {
      const status = tv.code === "expired" ? 410 : 400;
      return res.status(status).json({
        ok: false,
        code: tv.code,
        message: tv.code === "expired" ? "This link has expired." : "Invalid link.",
      });
    }

    // 1) Load offer row
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(token)}` +
      `&select=id,request_id,offer_token,is_active,service_date,slot_index,zone_code,appointment_type,start_time,end_time,window_label`;

    const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!offerResp.ok) {
      return res.status(500).json({
        ok: false,
        code: "offer_fetch_failed",
        message: "Could not load offer.",
      });
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
    const slotIndex = Number(offerRow.slot_index);

    const windowStart = makeLocalTimestamptz(serviceDate, offerRow.start_time, tzOffset);
    const windowEnd = makeLocalTimestamptz(serviceDate, offerRow.end_time, tzOffset);

    if (!windowStart || !windowEnd) {
      await deactivateOfferByToken({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, token });
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    // 2) Block if started
    const startMs = toMs(windowStart);
    if (startMs != null && Date.now() >= startMs) {
      await invalidateAllOffersForSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, zoneCode, serviceDate, slotIndex });
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "That appointment window has already started. Please choose another time.",
      });
    }

    // 3) Block if already booked (slot_code + multiple statuses)
    const slotCode = computeSlotCode(serviceDate, slotIndex);
    const BOOKED_STATUSES = ["scheduled", "en_route", "on_site", "completed"];

    const bookingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&status=in.(${BOOKED_STATUSES.map((s) => `"${s}"`).join(",")})` +
      `&select=id&limit=1`;

    const bookingResp = await sbFetchJson(bookingUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!bookingResp.ok) {
      return res.status(500).json({
        ok: false,
        code: "booking_check_failed",
        message: "Could not validate availability.",
      });
    }

    const bookingRow = Array.isArray(bookingResp.data) ? (bookingResp.data[0] ?? null) : null;
    if (bookingRow) {
      await invalidateAllOffersForSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, zoneCode, serviceDate, slotIndex });
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    // 4) Block if tech is on time off
    const techUrl =
      `${SUPABASE_URL}/rest/v1/zone_tech_assignments` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&select=tech_id&limit=1`;

    const techResp = await sbFetchJson(techUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!techResp.ok) {
      return res.status(500).json({ ok: false, code: "tech_lookup_failed", message: "Could not validate availability." });
    }

    const techRow = Array.isArray(techResp.data) ? techResp.data[0] : null;
    const techId = techRow?.tech_id ? String(techRow.tech_id) : null;

    if (!techId) {
      await invalidateAllOffersForSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, zoneCode, serviceDate, slotIndex });
      return res.status(409).json({
        ok: false,
        code: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    const offUrl =
      `${SUPABASE_URL}/rest/v1/tech_time_off` +
      `?tech_id=eq.${encodeURIComponent(techId)}` +
      `&end_ts=gte.${encodeURIComponent(windowStart)}` +
      `&start_ts=lte.${encodeURIComponent(windowEnd)}` +
      `&select=start_ts,end_ts,type`;

    const offResp = await sbFetchJson(offUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!offResp.ok) {
      return res.status(500).json({ ok: false, code: "time_off_check_failed", message: "Could not validate availability." });
    }

    const offRows = Array.isArray(offResp.data) ? offResp.data : [];
    const wStartMs = toMs(windowStart);
    const wEndMs = toMs(windowEnd);

    const slotIsOff =
      wStartMs != null &&
      wEndMs != null &&
      offRows.some((o) => {
        const os = o?.start_ts ? toMs(o.start_ts) : null;
        const oe = o?.end_ts ? toMs(o.end_ts) : null;
        if (os == null || oe == null) return false;

        const t = String(o?.type || "").toLowerCase();
        if (t === "slot") return os === wStartMs && oe === wEndMs;
        return rangesOverlapMs(wStartMs, wEndMs, os, oe);
      });

    if (slotIsOff) {
      await invalidateAllOffersForSlot({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, zoneCode, serviceDate, slotIndex });
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
      appointment_type: offerRow.appointment_type || tv.payload?.appointment_type || "standard",
      offer: { ...offerRow, slot_code: slotCode },
      payload: tv.payload,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: "server_error",
      message: err?.message || String(err),
    });
  }
};
