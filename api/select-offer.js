// /api/select-offer.js
import crypto from "crypto";

function base64urlToJson(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}

function verifyToken(token, secret) {
  const [payloadB64, sigB64] = String(token || "").split(".");
  if (!payloadB64 || !sigB64) return { ok: false, message: "Bad token format" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  if (expected !== sigB64) return { ok: false, message: "Invalid signature" };

  const payload = base64urlToJson(payloadB64);
  if (payload?.exp && Date.now() > Number(payload.exp)) return { ok: false, message: "Token expired" };
  return { ok: true, payload };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function supabaseGetSingle({ table, match, serviceRole, supabaseUrl, select = "*" }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  Object.entries(match).forEach(([k, v]) => url.searchParams.set(k, `eq.${v}`));
  url.searchParams.set("limit", "1");

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
    },
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`Supabase get failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  return Array.isArray(data) ? data[0] : null;
}

async function supabasePatch({ table, match, patch, serviceRole, supabaseUrl }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  Object.entries(match).forEach(([k, v]) => url.searchParams.set(k, `eq.${v}`));

  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`Supabase patch failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method Not Allowed" });
  }

  try {
    const { token = "" } = req.body || {};
    const cleanToken = String(token).trim();
    if (!cleanToken) return res.status(400).json({ ok: false, message: "Missing token" });

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const v = verifyToken(cleanToken, TOKEN_SECRET);
    if (!v.ok) return res.status(400).json({ ok: false, message: v.message });

    // Confirm the offer exists
    const offerRow = await supabaseGetSingle({
      table: "booking_request_offers",
      match: { offer_token: cleanToken },
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      select: "request_id, service_date, slot_index, zone_code, offer_token",
    });

    if (!offerRow) {
      return res.status(404).json({ ok: false, message: "Offer not found" });
    }

    // Mark request as selected (status column is known to exist from your insert)
    await supabasePatch({
      table: "booking_requests",
      match: { id: offerRow.request_id },
      patch: { status: "selected" },
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
    });

    return res.status(200).json({
      ok: true,
      request_id: offerRow.request_id,
      selected: {
        service_date: offerRow.service_date,
        slot_index: offerRow.slot_index,
        zone_code: offerRow.zone_code,
      },
      message: "Selected. Confirmation will be sent shortly.",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message || String(err) });
  }
}
