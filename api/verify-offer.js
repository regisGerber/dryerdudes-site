// /api/verify-offer.js (FULL REPLACEMENT, UPDATED)
import crypto from "crypto";

function base64urlToString(b64url) {
  const b64 =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((b64url.length + 3) % 4);
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

function computeSlotCode(service_date, slot_index) {
  return `${service_date}#${slot_index}`;
}

function taken(res) {
  return res.status(409).json({
    ok: false,
    code: "slot_taken",
    message: "This time slot is no longer available. Please go back and choose another option.",
  });
}

export default async function handler(req, res) {
  try {
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res
        .status(400)
        .json({ ok: false, code: "missing_token", message: "Missing token." });
    }

    const parts = token.split(".");
    if (parts.length !== 2) {
      return res
        .status(400)
        .json({ ok: false, code: "bad_token_format", message: "Invalid link." });
    }

    const [payloadB64url, sig] = parts;
    const expected = sign(payloadB64url, TOKEN_SECRET);

    // timingSafeEqual requires equal-length buffers
    if (Buffer.from(sig).length !== Buffer.from(expected).length) {
      return res
        .status(400)
        .json({ ok: false, code: "bad_signature", message: "Invalid link." });
    }
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res
        .status(400)
        .json({ ok: false, code: "bad_signature", message: "Invalid link." });
    }

    let payload;
    try {
      payload = JSON.parse(base64urlToString(payloadB64url));
    } catch {
      return res
        .status(400)
        .json({ ok: false, code: "bad_payload", message: "Invalid link." });
    }

    if (payload?.exp && Date.now() > Number(payload.exp)) {
      return res.status(400).json({
        ok: false,
        code: "expired",
        message: "This link has expired.",
      });
    }

    // 1) Load offer row
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(token)}` +
      `&select=id,request_id,offer_token,is_active,service_date,slot_index,zone_code,start_time,end_time,window_label`;

    const offerResp = await sbFetchJson(offerUrl, sbHeaders(SERVICE_ROLE));
    if (!offerResp.ok) {
      return res.status(500).json({
        ok: false,
        code: "offer_fetch_failed",
        message: "Could not load offer.",
        details: offerResp.text,
      });
    }

    const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] ?? null : null;
    if (!offerRow) {
      return res.status(404).json({
        ok: false,
        code: "offer_not_found",
        message: "Offer not found.",
      });
    }

    // 2) If explicitly inactive -> taken
    if (offerRow.is_active === false) return taken(res);

    const slotCode = computeSlotCode(offerRow.service_date, offerRow.slot_index);
    const zoneCode = String(offerRow.zone_code || "");

    // 3) Global safety: block if any booking exists for this zone+slot_code
    // IMPORTANT: no appointment_type filter
    const bookingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&select=id&limit=1`;

    const bookingResp = await sbFetchJson(bookingUrl, sbHeaders(SERVICE_ROLE));
    if (!bookingResp.ok) {
      return res.status(500).json({
        ok: false,
        code: "booking_check_failed",
        message: "Could not validate availability.",
        details: bookingResp.text,
      });
    }

    const bookingRow = Array.isArray(bookingResp.data) ? bookingResp.data[0] ?? null : null;
    if (bookingRow) return taken(res);

    // 4) Extra safety: block if this exact offer row was already used as selected_option_id
    // This catches cases where slot_code uniqueness was bypassed or older rows exist.
    const bySelectedOptionUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?selected_option_id=eq.${encodeURIComponent(offerRow.id)}` +
      `&select=id&limit=1`;

    const bySelResp = await sbFetchJson(bySelectedOptionUrl, sbHeaders(SERVICE_ROLE));
    if (!bySelResp.ok) {
      return res.status(500).json({
        ok: false,
        code: "booking_check_failed",
        message: "Could not validate availability.",
        details: bySelResp.text,
      });
    }

    const bySel = Array.isArray(bySelResp.data) ? bySelResp.data[0] ?? null : null;
    if (bySel) return taken(res);

    // ✅ OK
    return res.status(200).json({
      ok: true,
      code: "ok",
      zone: zoneCode,
      offer: { ...offerRow, slot_code: slotCode },
      payload,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: "server_error",
      message: err?.message || String(err),
    });
  }
}
```0
