// /api/request-times.js (FULL REPLACEMENT)
// Works with lean booking_request_offers schema (NO start_time/end_time/window_label columns)
// booking_request_offers columns assumed:
// request_id, offer_group, offer_token, is_active, appointment_type, offer_role, route_zone_code, slot_id

import crypto from "crypto";

// -------------------- token helpers --------------------
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
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;

  const proto = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host =
    String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req?.headers?.host || "").trim();

  return `${proto}://${host}`;
}

// -------------------- supabase REST helpers --------------------
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

async function supabaseInsert({ table, row, serviceRole, supabaseUrl }) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(serviceRole), Prefer: "return=representation" },
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
    headers: { ...sbHeaders(serviceRole), Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`Supabase insertMany failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// -------------------- core: backfill slot_id --------------------
function pickSlotIdFromCandidate(c) {
  // Be flexible: different endpoints might return different shapes
  return (
    c?.id ||            // common: schedule_slots row id returned as `id`
    c?.slot_id ||       // common: explicit `slot_id`
    c?.schedule_slot_id // sometimes used
  ) || null;
}

// Build PostgREST OR filter for composite keys
function buildScheduleSlotsOrFilter(keys) {
  // keys: [{service_date, slot_index, zone_code}]
  // PostgREST: or=(and(service_date.eq.2026-03-06,slot_index.eq.1,zone_code.eq.C),and(...))
  const parts = keys.map(k => {
    const d = String(k.service_date);
    const idx = Number(k.slot_index);
    const z = String(k.zone_code);
    // IMPORTANT: no quotes in PostgREST filter, just values
    return `and(service_date.eq.${d},slot_index.eq.${idx},zone_code.eq.${z})`;
  });
  return `or=(${parts.join(",")})`;
}

async function fetchScheduleSlotMap({ keys, supabaseUrl, serviceRole }) {
  if (!keys.length) return new Map();

  // De-dupe keys
  const seen = new Set();
  const uniq = [];
  for (const k of keys) {
    const key = `${k.zone_code}#${k.service_date}#${k.slot_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(k);
  }

  // If you ever have huge batches, chunk. For now options are small.
  const orFilter = buildScheduleSlotsOrFilter(uniq);
  const url =
    `${supabaseUrl}/rest/v1/schedule_slots` +
    `?select=id,service_date,slot_index,zone_code,start_time,end_time,window_label,tech_id,is_booked` +
    `&${orFilter}` +
    `&limit=${Math.max(uniq.length, 10)}`;

  const r = await sbFetchJson(url, { headers: sbHeaders(serviceRole) });
  if (!r.ok) {
    throw new Error(`Supabase schedule_slots lookup failed: ${r.status} ${r.text}`);
  }

  const map = new Map();
  for (const row of (r.data || [])) {
    const key = `${row.zone_code}#${row.service_date}#${row.slot_index}`;
    map.set(key, row);
  }
  return map;
}

// -------------------- handler --------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const {
      name = "",
      phone = "",
      email = "",
      contact_method = "email", // text | email | both
      address = "",
      appointment_type = "standard",
    } = req.body || {};

    const cleanAddress = String(address || "").trim();
    if (!cleanAddress) return res.status(400).json({ ok: false, error: "address is required" });

    const cm = String(contact_method || "email").toLowerCase();
    const useText = cm === "text" || cm === "both";
    const useEmail = cm === "email" || cm === "both";

    if (useText && !String(phone).trim()) return res.status(400).json({ ok: false, error: "phone is required for text/both" });
    if (useEmail && !String(email).trim()) return res.status(400).json({ ok: false, error: "email is required for email/both" });

    const origin = getOrigin(req);

    // 1) Resolve zone from address
    const rzResp = await fetch(`${origin}/api/resolve-zone?address=${encodeURIComponent(cleanAddress)}`);
    const rz = await rzResp.json().catch(() => ({}));
    if (!rzResp.ok) return res.status(502).json({ ok: false, error: "resolve-zone failed", details: rz });

    const zone = String(rz.zone_code || "").trim();
    if (!zone) return res.status(400).json({ ok: false, error: "Could not resolve zone for address", details: rz });

    // 2) Get candidate slots from YOUR scheduling logic
    const slotsResp = await fetch(
      `${origin}/api/get-available-slots?zone=${encodeURIComponent(zone)}&type=${encodeURIComponent(appointment_type)}`
    );
    const slotsJson = await slotsResp.json().catch(() => ({}));
    if (!slotsResp.ok) return res.status(502).json({ ok: false, error: "get-available-slots failed", details: slotsJson });

    let primary = Array.isArray(slotsJson.primary) ? slotsJson.primary : [];
    let moreOptions = Array.isArray(slotsJson.more?.options) ? slotsJson.more.options : [];

    if (primary.length < 1) {
      return res.status(200).json({ ok: true, zone, message: "No appointment options available right now.", details: slotsJson });
    }

    // 3) BACKFILL slot_id by matching schedule_slots on (zone_code, service_date, slot_index)
    // First, normalize candidate shape to ensure these exist
    const all = [...primary, ...moreOptions].map((c) => ({
      ...c,
      zone_code: String(c.zone_code || zone),
      service_date: String(c.service_date || "").trim(),
      slot_index: Number(c.slot_index),
      _slot_id: pickSlotIdFromCandidate(c),
    }));

    // If your scheduler already returned ids, keep them
    // Otherwise derive ids from schedule_slots
    const needLookup = all.filter((c) => !c._slot_id && c.service_date && Number.isFinite(c.slot_index));
    const keyTriples = needLookup.map((c) => ({
      zone_code: c.zone_code,
      service_date: c.service_date,
      slot_index: c.slot_index,
    }));

    const slotMap = await fetchScheduleSlotMap({ keys: keyTriples, supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE });

    // Attach slot rows and final slot_id
    const allEnriched = all.map((c) => {
      if (c._slot_id) return { ...c, slot_id: c._slot_id };
      const key = `${c.zone_code}#${c.service_date}#${c.slot_index}`;
      const row = slotMap.get(key);
      return { ...c, slot_id: row?.id || null, _slot_row: row || null };
    });

    // Drop any candidates we still can’t map (prevents NOT NULL crash)
    const keep = allEnriched.filter((c) => !!c.slot_id);

    // Re-split groups preserving order
    const primaryKeep = keep.slice(0, primary.length).filter(Boolean);
    const moreKeep = keep.slice(primary.length).filter(Boolean);

    // If mapping fails completely, return diagnostic info (so you can see what scheduler returned)
    if (primaryKeep.length < 1) {
      return res.status(500).json({
        ok: false,
        error: "Scheduler returned options but none could be matched to schedule_slots (slot_id mapping failed).",
        debug: {
          zone,
          appointment_type,
          primary_sample: primary[0] || null,
          more_sample: moreOptions[0] || null,
          needed_lookup_count: needLookup.length,
        },
      });
    }

    // 4) Store request
    const requestRow = await supabaseInsert({
      table: "booking_requests",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      row: {
        name: String(name || "").trim() || null,
        phone: String(phone || "").trim() || null,
        email: String(email || "").trim() || null,
        contact_method: cm,
        address: cleanAddress,
        appointment_type: String(appointment_type || "standard"),
        lat: typeof rz.lat === "number" ? rz.lat : null,
        lng: typeof rz.lng === "number" ? rz.lng : null,
        zone_code: zone,
        zone_name: rz.zone_name || null,
        status: "sent",
      },
    });

    const requestId = requestRow.id;

    // 5) Create offer tokens + store offers (LEAN)
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 3; // 3 days
    const offersToStore = [];

    function makeOffer(candidate, group) {
      const payload = {
        v: 2,
        request_id: requestId,
        appointment_type,
        zone: candidate.zone_code || zone,
        service_date: candidate.service_date,
        slot_index: candidate.slot_index,
        slot_id: candidate.slot_id, // include for debugging / future use
        exp: expiresAt,
      };

      const token = signToken(payload, TOKEN_SECRET);

      offersToStore.push({
        request_id: requestId,
        offer_group: group,
        offer_token: token,
        is_active: true,
        appointment_type: String(appointment_type || "standard"),
        route_zone_code: String(candidate.zone_code || zone),
        slot_id: candidate.slot_id, // ✅ REQUIRED by NOT NULL
      });

      // Return slot display fields (prefer schedule_slots truth if we have it)
      const sr = candidate._slot_row || {};
      return {
        service_date: sr.service_date || candidate.service_date,
        slot_index: sr.slot_index ?? candidate.slot_index,
        zone_code: sr.zone_code || candidate.zone_code || zone,
        start_time: sr.start_time || candidate.start_time || null,
        end_time: sr.end_time || candidate.end_time || null,
        window_label: sr.window_label || candidate.window_label || null,
        slot_id: candidate.slot_id,
        offer_token: token,
      };
    }

    const primaryWithTokens = primaryKeep.slice(0, 3).map((c) => makeOffer(c, "primary"));
    const moreWithTokens = moreKeep.map((c) => makeOffer(c, "more"));

    await supabaseInsertMany({
      table: "booking_request_offers",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      rows: offersToStore,
    });

    const requestToken = signToken({ v: 1, request_id: requestId, exp: expiresAt, kind: "request" }, TOKEN_SECRET);

    // NOTE: Delivery (SMS/email) can remain in your wrapper or elsewhere; keeping response lean here
    return res.status(200).json({
      ok: true,
      request_id: requestId,
      token: requestToken,
      zone,
      appointment_type,
      primary: primaryWithTokens,
      more: { ...slotsJson.more, options: moreWithTokens },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error", message: err?.message || String(err) });
  }
}
