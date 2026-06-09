// /api/return-visit-options.js
// Public token endpoint.
// Uses the existing Dryer Dudes scheduling backbone:
// /api/get-available-slots -> 3 primary options + 2 more options.
// Does NOT independently query/pick 8 raw schedule_slots.

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host =
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req.headers.host || "").trim();

  return `${proto}://${host}`;
}

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
    data = { raw: text };
  }

  return { ok: resp.ok, status: resp.status, data, text };
}

async function getSingle({ supabaseUrl, serviceRole, table, filters, select = "*" }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", select);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Supabase lookup failed (${table}): ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

function pickSlotIdFromCandidate(c) {
  return c?.id || c?.slot_id || c?.schedule_slot_id || null;
}

function buildScheduleSlotsOrFilter(keys) {
  const parts = keys.map((k) => {
    const d = String(k.service_date);
    const idx = Number(k.slot_index);
    const z = String(k.zone_code || "").toUpperCase();

    return `and(service_date.eq.${d},slot_index.eq.${idx},zone_code.eq.${z})`;
  });

  return `or=(${parts.join(",")})`;
}

async function fetchScheduleSlotMap({ keys, supabaseUrl, serviceRole }) {
  if (!Array.isArray(keys) || keys.length === 0) return new Map();

  const seen = new Set();
  const uniq = [];

  for (const k of keys) {
    const zone = String(k.zone_code || "").toUpperCase();
    const date = String(k.service_date || "").trim();
    const idx = Number(k.slot_index);

    if (!zone || !date || !Number.isFinite(idx)) continue;

    const key = `${zone}#${date}#${idx}`;
    if (seen.has(key)) continue;

    seen.add(key);
    uniq.push({
      zone_code: zone,
      service_date: date,
      slot_index: idx,
    });
  }

  if (!uniq.length) return new Map();

  const orFilter = buildScheduleSlotsOrFilter(uniq);

  const url =
    `${supabaseUrl}/rest/v1/schedule_slots` +
    `?select=id,service_date,slot_index,zone_code,start_time,end_time,window_label,tech_id,is_booked` +
    `&${orFilter}` +
    `&limit=${Math.max(uniq.length, 10)}`;

  const r = await sbFetchJson(url, {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Supabase schedule_slots lookup failed: ${r.status} ${r.text}`);
  }

  const map = new Map();

  for (const row of Array.isArray(r.data) ? r.data : []) {
    const key = `${String(row.zone_code || "").toUpperCase()}#${row.service_date}#${Number(row.slot_index)}`;
    map.set(key, row);
  }

  return map;
}

function normalizeOption(c, fallbackZone, slotMap) {
  const zone = String(c.zone_code || fallbackZone || "").toUpperCase();
  const serviceDate = String(c.service_date || "").trim();
  const slotIndex = Number(c.slot_index);

  const existingSlotId = pickSlotIdFromCandidate(c);
  const key = `${zone}#${serviceDate}#${slotIndex}`;
  const slotRow = existingSlotId ? null : slotMap.get(key);

  const slotId = existingSlotId || slotRow?.id || null;

  if (!slotId) return null;

  return {
    id: slotId,
    slot_id: slotId,
    service_date: slotRow?.service_date || serviceDate,
    slot_index: slotRow?.slot_index ?? slotIndex,
    zone_code: slotRow?.zone_code || zone,
    daypart: c.daypart || null,
    window_label: slotRow?.window_label || c.window_label || null,
    start_time: slotRow?.start_time || c.start_time || null,
    end_time: slotRow?.end_time || c.end_time || null,
  };
}

function partStatusLabel(value) {
  const v = String(value || "").toLowerCase();

  if (v === "tech_has_part") return "Dryer Dudes has the part";
  if (v === "customer_has_part") return "Customer has the part";
  if (v === "return_visit_ready") return "Return visit ready";

  return "Part ready";
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query?.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Missing return visit token",
      });
    }

    const billing = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_billing",
      filters: { return_visit_token: token },
      select: "*",
    });

    if (!billing) {
      return res.status(404).json({
        ok: false,
        error: "Return visit link not found",
      });
    }

    if (String(billing.payment_status || "").toLowerCase() !== "paid") {
      return res.status(409).json({
        ok: false,
        error: "The ordered part must be paid before scheduling the return visit.",
      });
    }

    const partStatus = String(billing.part_status || "").toLowerCase();

    if (!["tech_has_part", "customer_has_part", "return_visit_ready"].includes(partStatus)) {
      return res.status(409).json({
        ok: false,
        error: "The part is not ready for return visit scheduling yet.",
      });
    }

    const booking = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: billing.booking_id },
      select: "id,request_id,job_ref,status,slot_id,zone_code,home_location_code,route_zone_code,tech_id,assigned_tech_id",
    });

    if (!booking) {
      return res.status(404).json({
        ok: false,
        error: "Booking not found",
      });
    }

    const bookingStatus = String(booking.status || "").toLowerCase();

    if (["completed", "cancelled", "canceled", "no_show"].includes(bookingStatus)) {
      return res.status(409).json({
        ok: false,
        error: "This job is no longer available for return visit scheduling.",
      });
    }

    const request = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: booking.request_id },
      select: "id,name,email,phone,address,zone_code,home_location_code,notes",
    });

    const homeZone =
      String(request?.zone_code || "").trim().toUpperCase() ||
      String(request?.home_location_code || "").trim().toUpperCase() ||
      String(booking.home_location_code || "").trim().toUpperCase() ||
      String(booking.route_zone_code || "").trim().toUpperCase() ||
      String(booking.zone_code || "").trim().toUpperCase();

    if (!["A", "B", "C", "D"].includes(homeZone)) {
      return res.status(400).json({
        ok: false,
        error: "Could not determine the customer's home service zone for return visit scheduling.",
        debug: {
          request_zone_code: request?.zone_code || null,
          request_home_location_code: request?.home_location_code || null,
          booking_home_location_code: booking.home_location_code || null,
          booking_route_zone_code: booking.route_zone_code || null,
          booking_zone_code: booking.zone_code || null,
        },
      });
    }

    const origin = getOrigin(req);

    // IMPORTANT:
    // Use the same standard appointment scheduling style as the main booking system:
    // 3 primary options + 2 more options.
    // Do not use type=parts here because the parts branch is a different 3-option flow.
    const slotsResp = await fetch(
      `${origin}/api/get-available-slots?zone=${encodeURIComponent(homeZone)}&type=standard`
    );

    const slotsJson = await slotsResp.json().catch(() => ({}));

    if (!slotsResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "get-available-slots failed",
        details: slotsJson,
      });
    }

    const primaryRaw = Array.isArray(slotsJson.primary) ? slotsJson.primary.slice(0, 3) : [];
    const moreRaw = Array.isArray(slotsJson.more?.options) ? slotsJson.more.options.slice(0, 2) : [];

    const allRaw = [...primaryRaw, ...moreRaw].map((c) => ({
      ...c,
      zone_code: String(c.zone_code || homeZone).toUpperCase(),
      service_date: String(c.service_date || "").trim(),
      slot_index: Number(c.slot_index),
      _slot_id: pickSlotIdFromCandidate(c),
    }));

    const needLookup = allRaw.filter((c) => {
      return !c._slot_id && c.zone_code && c.service_date && Number.isFinite(c.slot_index);
    });

    const keyTriples = needLookup.map((c) => ({
      zone_code: c.zone_code,
      service_date: c.service_date,
      slot_index: c.slot_index,
    }));

    const slotMap = await fetchScheduleSlotMap({
      keys: keyTriples,
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
    });

    const primary = primaryRaw
      .map((c) => normalizeOption(c, homeZone, slotMap))
      .filter(Boolean)
      .slice(0, 3);

    const moreOptions = moreRaw
      .map((c) => normalizeOption(c, homeZone, slotMap))
      .filter(Boolean)
      .slice(0, 2);

    return res.status(200).json({
      ok: true,
      token,
      zone: homeZone,
      job: {
        booking_id: booking.id,
        job_ref: booking.job_ref || "",
        customer_name: request?.name || "",
        address: request?.address || "",
        part_status: partStatus,
        part_status_label: partStatusLabel(partStatus),
      },
      primary,
      more: {
        options: moreOptions,
        show_authorized_entry_note: true,
      },
      scheduler: {
        source: "get-available-slots",
        style: "standard_3_primary_2_more",
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
