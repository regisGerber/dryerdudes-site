// /api/verify-offer.js
// DryerDudes offer verification endpoint

const crypto = require("crypto");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/* ---------------- TOKEN HELPERS ---------------- */

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

/* ---------------- SUPABASE HELPERS ---------------- */

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

/* ---------------- USER MESSAGES ---------------- */

function humanMessageForStatus(status) {
  switch (status) {
    case "already_booked":
      return "That appointment time was just taken. Please go back and choose another option.";

    case "inactive_offer":
      return "This option is no longer active. Please request new appointment options.";

    case "offer_not_found":
      return "This booking link is not valid. Please request new appointment options.";

    case "invalid":
      return "This appointment option is not available.";

    default:
      return "This appointment option is no longer available.";
  }
}

/* ---------------- MAIN HANDLER ---------------- */

module.exports = async function handler(req, res) {
  try {
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query?.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        code: "missing_token",
        message: "Missing booking token.",
      });
    }

    /* ---------------- TOKEN VALIDATION ---------------- */

    const parts = token.split(".");
    if (parts.length !== 2) {
      return res.status(400).json({
        ok: false,
        code: "bad_token_format",
        message: "Invalid booking link.",
      });
    }

    const [payloadB64url, sig] = parts;

    const expected = sign(payloadB64url, TOKEN_SECRET);

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(400).json({
        ok: false,
        code: "bad_signature",
        message: "Invalid booking link.",
      });
    }

    let payload;

    try {
      payload = JSON.parse(base64urlToString(payloadB64url));
    } catch {
      return res.status(400).json({
        ok: false,
        code: "bad_payload",
        message: "Invalid booking link.",
      });
    }

    if (payload?.exp && Date.now() > Number(payload.exp)) {
      return res.status(400).json({
        ok: false,
        code: "expired",
        message: "This booking link has expired.",
      });
    }

    /* ---------------- VERIFY OFFER ---------------- */

    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/verify_offer_for_checkout`;

    const rpcResp = await sbFetchJson(rpcUrl, {
      method: "POST",
      headers: sbHeaders(SERVICE_ROLE),
      body: JSON.stringify({ p_token: token }),
    });

    if (!rpcResp.ok) {
      return res.status(500).json({
        ok: false,
        code: "offer_verify_failed",
        message: "Could not verify appointment option.",
        details: rpcResp.text,
      });
    }

    if (!Array.isArray(rpcResp.data) || rpcResp.data.length === 0) {
      return res.status(404).json({
        ok: false,
        code: "offer_not_found",
        message: "This booking option no longer exists.",
      });
    }

    const offer = rpcResp.data[0];

    /* ---------------- SLOT STATUS ---------------- */

    const status = String(offer.availability_status || "invalid");

    if (status !== "valid") {
      return res.status(409).json({
        ok: false,
        code: "offer_not_available",
        availability_status: status,
        message: humanMessageForStatus(status),
        offer,
      });
    }

    /* ---------------- SUCCESS ---------------- */

    return res.status(200).json({
      ok: true,
      code: "ok",
      offer,
      payload,
    });

  } catch (err) {
    console.error("verify-offer error:", err);

    return res.status(500).json({
      ok: false,
      code: "server_error",
      message: err?.message || String(err),
    });
  }
};
