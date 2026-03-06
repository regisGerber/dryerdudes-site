// /api/verify-offer.js (FULL REPLACEMENT - CommonJS)
// Uses Supabase RPC verify_offer_for_checkout(token) so it works with the lean schema:
// booking_request_offers has slot_id, and schedule_slots has service_date/start/end.

const crypto = require("crypto");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// --- token helpers (keep signature validation) ---
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

// --- supabase helpers ---
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

function humanMessageForStatus(status) {
  switch (status) {
    case "already_booked":
      return "That time was just taken. Please go back and choose another option.";
    case "inactive_offer":
      return "That option is no longer active. Please go back and request new options.";
    case "offer_not_found":
      return "This link is not valid. Please go back and request new options.";
    case "invalid":
      return "This option is not available. Please go back and choose another option.";
    default:
      return "This option is not available. Please go back and choose another option.";
  }
}

module.exports = async function handler(req, res) {
  try {
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query?.token || "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, code: "missing_token", message: "Missing token." });
    }

    // 0) Validate signature + expiry (fast fail; prevents random token spam hitting DB)
    const parts = token.split(".");
    if (parts.length !== 2) {
      return res.status(400).json({ ok: false, code: "bad_token_format", message: "Invalid link." });
    }

    const [payloadB64url, sig] = parts;
    const expected = sign(payloadB64url, TOKEN_SECRET);

    const sigBuf = Buffer.from(String(sig));
    const expBuf = Buffer.from(String(expected));
    if (sigBuf.length !== expBuf.length) {
      return res.status(400).json({ ok: false, code: "bad_signature", message: "Invalid link." });
    }
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(400).json({ ok: false, code: "bad_signature", message: "Invalid link." });
    }

    let payload = null;
    try {
      payload = JSON.parse(base64urlToString(payloadB64url));
    } catch {
      return res.status(400).json({ ok: false, code: "bad_payload", message: "Invalid link." });
    }

    if (payload?.exp && Date.now() > Number(payload.exp)) {
      return res.status(400).json({ ok: false, code: "expired", message: "This link has expired." });
    }

    // 1) Call RPC that understands lean schema
    // POST /rest/v1/rpc/verify_offer_for_checkout  { "p_token": "<token>" }
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/verify_offer_for_checkout`;

    const rpcResp = await sbFetchJson(rpcUrl, {
      method: "POST",
      headers: sbHeaders(SERVICE_ROLE),
      body: JSON.stringify({ p_token: token }),
    });

    if (!rpcResp.ok) {
      return res.status(500).json({
        ok: false,
        code: "offer_fetch_failed",
        message: "Could not load offer.",
        details: rpcResp.text,
      });
    }

    const row = Array.isArray(rpcResp.data) ? (rpcResp.data[0] ?? null) : null;
    if (!row) {
      return res.status(404).json({
        ok: false,
        code: "offer_not_found",
        message: "Offer not found.",
      });
    }

    // 2) Enforce availability
    const status = String(row.availability_status || "invalid");
    if (status !== "valid") {
      return res.status(409).json({
        ok: false,
        code: "offer_not_available",
        availability_status: status,
        message: humanMessageForStatus(status),
        offer: row,
      });
    }

    // 3) Valid
    return res.status(200).json({
      ok: true,
      code: "ok",
      offer: row, // includes slot_id + service_date + start/end + zone_code
      payload,    // handy for debugging, but not required by checkout
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: "server_error",
      message: err?.message || String(err),
    });
  }
};
