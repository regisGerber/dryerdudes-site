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

async function supabaseGetOffer({ token, serviceRole, supabaseUrl }) {
  const url = `${supabaseUrl}/rest/v1/booking_request_offers?offer_token=eq.${encodeURIComponent(token)}&select=*`;
  const resp = await fetch(url, {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
    },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Supabase fetch failed: ${resp.status} ${JSON.stringify(data)}`);
  return data?.[0] ?? null;
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

    // Load offer row from Supabase so we can show proper details (and later confirm/lock)
    const offerRow = await supabaseGetOffer({ token, serviceRole: SERVICE_ROLE, supabaseUrl: SUPABASE_URL });
    if (!offerRow) {
      return res.status(404).json({ ok: false, error: "not_found", message: "Offer not found." });
    }

    return res.status(200).json({
      ok: true,
      appointment_type: payload.appointment_type,
      zone: payload.zone,
      offer: offerRow,
      payload, // helpful while building; remove later if you want
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || String(err) });
  }
}
