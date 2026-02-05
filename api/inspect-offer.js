// /api/inspect-offer.js
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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, message: "Method Not Allowed" });
  }

  try {
    const token = String(req.query?.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, message: "Missing token" });

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const v = verifyToken(token, TOKEN_SECRET);
    if (!v.ok) return res.status(400).json({ ok: false, message: v.message });

    // Look up the offer by token (this table exists in your request-times.js flow)
    const offerRow = await supabaseGetSingle({
      table: "booking_request_offers",
      match: { offer_token: token },
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      select: "request_id, offer_group, service_date, slot_index, zone_code, offer_token",
    });

    if (!offerRow) {
      return res.status(404).json({ ok: false, message: "Offer not found" });
    }

    // Fetch the request (for address/type display)
    const requestRow = await supabaseGetSingle({
      table: "booking_requests",
      match: { id: offerRow.request_id },
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      select: "id, address, appointment_type, contact_method, phone, email, status",
    });

    // You can enrich times if your slots table stores them; for now we return service_date + slot_index
    // If your get-available-slots returns start/end/window_label AND you store them later, we can display them too.
    return res.status(200).json({
      ok: true,
      offer: {
        service_date: offerRow.service_date,
        slot_index: offerRow.slot_index,
        zone_code: offerRow.zone_code,
        // optional fields if you later store them:
        start_time: null,
        end_time: null,
        window_label: null,
      },
      request: requestRow || null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message || String(err) });
  }
}
