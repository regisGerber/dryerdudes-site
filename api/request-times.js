import crypto from "crypto";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signToken(payloadObj, secret) {
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${payload}.${sig}`;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getOrigin(req) {
  const site = String(process.env.SITE_ORIGIN || "").trim();
  if (site) return site.replace(/\/+$/, "");
  return `https://${req.headers.host}`;
}

async function supabaseInsert({ table, row, serviceRole, supabaseUrl }) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok) {
    throw new Error(`Supabase insert failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }

  return data?.[0] ?? null;
}

async function supabaseInsertMany({ table, rows, serviceRole, supabaseUrl }) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok) {
    throw new Error(`Supabase insertMany failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }

  return data;
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const {
      name = "",
      phone = "",
      email = "",
      contact_method = "text",
      address = "",
      appointment_type = "standard",
    } = req.body || {};

    const cleanAddress = String(address || "").trim();
    if (!cleanAddress) return res.status(400).json({ error: "address required" });

    const origin = getOrigin(req);

    // resolve zone
    const rzResp = await fetch(`${origin}/api/resolve-zone?address=${encodeURIComponent(cleanAddress)}`);
    const rz = await rzResp.json();

    const zone = rz.zone_code;

    // fetch slots
    const slotsResp = await fetch(
      `${origin}/api/get-available-slots?zone=${encodeURIComponent(zone)}&type=${encodeURIComponent(appointment_type)}`
    );

    const slotsJson = await slotsResp.json();

    let primary = slotsJson.primary || [];
    let moreOptions = slotsJson.more?.options || [];

    if (!primary.length) {
      return res.json({ ok: true, message: "No options available" });
    }

    // create request
    const requestRow = await supabaseInsert({
      table: "booking_requests",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      row: {
        name,
        phone,
        email,
        contact_method,
        address: cleanAddress,
        appointment_type,
        zone_code: rz.zone_code,
        zone_name: rz.zone_name,
        status: "sent",
      },
    });

    const requestId = requestRow.id;

    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 3;

    const offersToStore = [];

    function makeOffer(slot, group) {

      const payload = {
        v: 1,
        request_id: requestId,
        slot_id: slot.id,
        exp: expiresAt,
      };

      const token = signToken(payload, TOKEN_SECRET);

      offersToStore.push({
        request_id: requestId,
        slot_id: slot.id,
        offer_group: group,
        route_zone_code: slot.zone_code || zone,
        offer_token: token,
        is_active: true,
      });

      return {
        ...slot,
        offer_token: token
      };
    }

    const primaryWithTokens = primary.slice(0,3).map(s => makeOffer(s,"primary"));
    const moreWithTokens = moreOptions.map(s => makeOffer(s,"more"));

    await supabaseInsertMany({
      table: "booking_request_offers",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      rows: offersToStore,
    });

    return res.json({
      ok: true,
      request_id: requestId,
      primary: primaryWithTokens,
      more: { ...slotsJson.more, options: moreWithTokens },
    });

  } catch (err) {

    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err)
    });

  }
}
