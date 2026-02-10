// /api/verify-offer.js
import crypto from "crypto";

function base64urlToString(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
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

async function sbGetOne(url, headers) {
  const resp = await fetch(url, { headers });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`Supabase fetch failed: ${resp.status} ${JSON.stringify(data)}`);
  return Array.isArray(data) ? (data[0] ?? null) : null;
}

export default async function handler(req, res) {
  try {
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

    const parts = token.split(".");
    if (parts.length !== 2) return res.status(400).json({ ok: false, error: "bad_token_format" });

    const [payloadB64url, sig] = parts;
    const expected = sign(payloadB64url, TOKEN_SECRET);

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(400).json({ ok: false, error: "bad_signature", message: "Invalid link." });
    }

    const payloadJson = base64urlToString(payloadB64url);
    const payload = JSON.parse(payloadJson);

    if (payload?.exp && Date.now() > Number(payload.exp)) {
      return res.status(400).json({ ok: false, error: "expired", message: "This link has expired." });
    }

    // Load offer row (include is_active + slot fields)
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(token)}` +
      `&select=id,request_id,offer_token,is_active,service_date,slot_index,slot_code,zone_code,appointment_type,start_time,end_time,window_label`;

    const offerRow = await sbGetOne(offerUrl, sbHeaders(SERVICE_ROLE));
    if (!offerRow) {
      return res.status(404).json({ ok: false, error: "not_found", message: "Offer not found." });
    }

    // If we already invalidated it, block immediately
    if (offerRow.is_active === false) {
      return res.status(409).json({
        ok: false,
        error: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    // Extra safety: if booking exists, block even if is_active somehow didn’t flip yet
    const slotCode = String(offerRow.slot_code || `${offerRow.service_date}#${offerRow.slot_index}`);
    const zoneCode = String(offerRow.zone_code || "");
    const apptType = String(offerRow.appointment_type || "standard");

    const bookingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&appointment_type=eq.${encodeURIComponent(apptType)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&select=id&limit=1`;

    const bookingRow = await sbGetOne(bookingUrl, sbHeaders(SERVICE_ROLE));
    if (bookingRow) {
      return res.status(409).json({
        ok: false,
        error: "slot_taken",
        message: "This time slot is no longer available. Please go back and choose another option.",
      });
    }

    return res.status(200).json({
      ok: true,
      appointment_type: payload.appointment_type,
      zone: payload.zone,
      offer: {
        ...offerRow,
        // expose computed slot_code in response for clarity
        slot_code: slotCode,
        appointment_type: apptType,
      },
      payload, // keep while building; remove later if you want
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || String(err) });
  }
}
