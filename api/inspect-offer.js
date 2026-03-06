// /api/inspect-offer.js
const crypto = require("crypto");

function base64urlToJson(b64url) {
  const b64 =
    String(b64url || "").replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((String(b64url || "").length + 3) % 4);
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
      Accept: "application/json",
    },
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`Supabase get failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data[0] : null;
}

module.exports = async function handler(req, res) {
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

    const verified = verifyToken(token, TOKEN_SECRET);
    if (!verified.ok) return res.status(400).json({ ok: false, message: verified.message });

    // lean schema: booking_request_offers now stores request_id + slot_id
    const offerRow = await supabaseGetSingle({
      table: "booking_request_offers",
      match: { offer_token: token },
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      select: "id, request_id, offer_group, offer_token, is_active, appointment_type, route_zone_code, slot_id",
    });

    if (!offerRow) {
      return res.status(404).json({ ok: false, message: "Offer not found" });
    }

    const requestRow = offerRow.request_id
      ? await supabaseGetSingle({
          table: "booking_requests",
          match: { id: offerRow.request_id },
          serviceRole: SERVICE_ROLE,
          supabaseUrl: SUPABASE_URL,
          select: "id, address, appointment_type, contact_method, phone, email, status",
        })
      : null;

    const slotRow = offerRow.slot_id
      ? await supabaseGetSingle({
          table: "schedule_slots",
          match: { id: offerRow.slot_id },
          serviceRole: SERVICE_ROLE,
          supabaseUrl: SUPABASE_URL,
          select: "id, service_date, slot_index, zone_code, window_label, start_time, end_time",
        })
      : null;

    return res.status(200).json({
      ok: true,
      offer: {
        id: offerRow.id,
        offer_group: offerRow.offer_group,
        offer_token: offerRow.offer_token,
        is_active: offerRow.is_active,
        slot_id: offerRow.slot_id,
        route_zone_code: offerRow.route_zone_code || null,
        appointment_type: offerRow.appointment_type || requestRow?.appointment_type || null,

        service_date: slotRow?.service_date || null,
        slot_index: slotRow?.slot_index || null,
        zone_code: slotRow?.zone_code || null,
        window_label: slotRow?.window_label || null,
        start_time: slotRow?.start_time || null,
        end_time: slotRow?.end_time || null,
      },
      request: requestRow || null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || String(err),
    });
  }
};
