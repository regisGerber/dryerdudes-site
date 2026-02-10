// /api/select-offer.js
import crypto from "crypto";

function base64urlToJson(b64url) {
  const b64 =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((b64url.length + 3) % 4);
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
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
  if (payload?.exp && Date.now() > Number(payload.exp)) {
    return { ok: false, message: "Token expired" };
  }

  return { ok: true, payload };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function supabaseGetSingle({ table, match, select, serviceRole, supabaseUrl }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  Object.entries(match).forEach(([k, v]) =>
    url.searchParams.set(k, `eq.${v}`)
  );
  url.searchParams.set("limit", "1");

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
    },
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Supabase get failed: ${resp.status} ${JSON.stringify(data)}`);
  }

  return Array.isArray(data) ? data[0] : null;
}

async function supabasePatch({ table, match, patch, serviceRole, supabaseUrl }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  Object.entries(match).forEach(([k, v]) =>
    url.searchParams.set(k, `eq.${v}`)
  );

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
  if (!resp.ok) {
    throw new Error(`Supabase patch failed: ${resp.status} ${JSON.stringify(data)}`);
  }

  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method Not Allowed" });
  }

  try {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, message: "Missing token" });
    }

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const verified = verifyToken(token, TOKEN_SECRET);
    if (!verified.ok) {
      return res.status(400).json({ ok: false, message: verified.message });
    }

    // Fetch the offer INCLUDING its id
    const offer = await supabaseGetSingle({
      table: "booking_request_offers",
      match: { offer_token: token },
      select: "id, request_id, service_date, slot_index, zone_code",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
    });

    if (!offer) {
      return res.status(404).json({ ok: false, message: "Offer not found" });
    }

    // Record selection on the request (NO INVALIDATION HERE)
    await supabasePatch({
      table: "booking_requests",
      match: { id: offer.request_id },
      patch: {
        selected_option_id: offer.id,
        status: "selected",
      },
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
    });

    return res.status(200).json({
      ok: true,
      request_id: offer.request_id,
      selected: {
        service_date: offer.service_date,
        slot_index: offer.slot_index,
        zone_code: offer.zone_code,
      },
      message: "Option selected. Proceed to checkout.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || String(err),
    });
  }
}
