// /api/return-visit-options.js
// Public token endpoint: loads available return-visit windows for a paid parts-on-order job.

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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

function todayPacificDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadActiveBookedSlotIds({ supabaseUrl, serviceRole, slotIds, currentBookingId }) {
  const ids = [...new Set((slotIds || []).map((x) => String(x || "").trim()).filter(Boolean))];
  if (!ids.length) return new Set();

  const activeStatuses = [
    "scheduled",
    "en_route",
    "on_site",
    "billing_pending",
    "awaiting_payment",
    "parts_approval_needed",
    "parts_on_order",
    "return_visit_needed"
  ];

  const active = new Set();

  for (const chunk of chunkArray(ids, 50)) {
    const url =
      `${supabaseUrl}/rest/v1/bookings` +
      `?select=id,slot_id,status` +
      `&slot_id=in.(${chunk.join(",")})` +
      `&status=in.(${activeStatuses.join(",")})`;

    const r = await sbFetchJson(url, {
      headers: sbHeaders(serviceRole),
    });

    if (!r.ok) {
      throw new Error(`Could not check active bookings: ${r.status} ${r.text}`);
    }

    for (const row of Array.isArray(r.data) ? r.data : []) {
      if (String(row.id) !== String(currentBookingId)) {
        active.add(String(row.slot_id));
      }
    }
  }

  return active;
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
      select: "id,request_id,job_ref,status,slot_id,zone_code,route_zone_code,tech_id,assigned_tech_id",
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
      select: "id,name,email,phone,address",
    });

    const today = todayPacificDate();

    const slotUrl = new URL(`${SUPABASE_URL}/rest/v1/schedule_slots`);
    slotUrl.searchParams.set(
      "select",
      "id,service_date,slot_index,window_label,start_time,end_time,zone_code,tech_id,is_booked"
    );
    slotUrl.searchParams.set("service_date", `gte.${today}`);
    slotUrl.searchParams.set("is_booked", "eq.false");
    slotUrl.searchParams.set("order", "service_date.asc,slot_index.asc");
    slotUrl.searchParams.set("limit", "80");

    if (booking.tech_id) {
      slotUrl.searchParams.set("tech_id", `eq.${booking.tech_id}`);
    } else if (booking.zone_code || booking.route_zone_code) {
      slotUrl.searchParams.set("zone_code", `eq.${booking.zone_code || booking.route_zone_code}`);
    }

    const slotsResp = await sbFetchJson(slotUrl.toString(), {
      headers: sbHeaders(SERVICE_ROLE),
    });

    if (!slotsResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not load return visit slots.",
        details: slotsResp.text,
      });
    }

    const rawSlots = Array.isArray(slotsResp.data) ? slotsResp.data : [];
    const activeSlotIds = await loadActiveBookedSlotIds({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      slotIds: rawSlots.map((s) => s.id),
      currentBookingId: booking.id,
    });

    const options = rawSlots
      .filter((s) => !activeSlotIds.has(String(s.id)))
      .slice(0, 8);

    return res.status(200).json({
      ok: true,
      job: {
        booking_id: booking.id,
        job_ref: booking.job_ref || "",
        customer_name: request?.name || "",
        address: request?.address || "",
        part_status: partStatus,
        part_status_label: partStatusLabel(partStatus),
      },
      options,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
