// /api/tech-list-parts-on-order.js
// Lists parts-on-order jobs for the signed-in tech/admin.
// Uses separate Supabase lookups instead of nested PostgREST joins to avoid 500s from relationship/query issues.

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getBearerToken(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
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

async function getUserFromToken({ supabaseUrl, serviceRole, accessToken }) {
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok || !data?.id) return null;

  return data;
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

function chunkArray(arr, size) {
  const out = [];

  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }

  return out;
}

async function loadBillingRows({ supabaseUrl, serviceRole }) {
  const url =
    `${supabaseUrl}/rest/v1/booking_billing` +
    `?select=*` +
    `&order=updated_at.desc` +
    `&limit=250`;

  const r = await sbFetchJson(url, {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Could not load booking_billing: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data : [];
}

async function loadBookingsByIds({ supabaseUrl, serviceRole, bookingIds }) {
  const ids = [...new Set(
    (bookingIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )];

  if (!ids.length) return new Map();

  const map = new Map();

  for (const chunk of chunkArray(ids, 60)) {
    const url =
      `${supabaseUrl}/rest/v1/bookings` +
      `?select=id,request_id,job_ref,status,assigned_tech_id,window_start,window_end,appointment_type` +
      `&id=in.(${chunk.join(",")})`;

    const r = await sbFetchJson(url, {
      headers: sbHeaders(serviceRole),
    });

    if (!r.ok) {
      throw new Error(`Could not load bookings: ${r.status} ${r.text}`);
    }

    for (const row of Array.isArray(r.data) ? r.data : []) {
      map.set(String(row.id), row);
    }
  }

  return map;
}

async function loadRequestsByIds({ supabaseUrl, serviceRole, requestIds }) {
  const ids = [...new Set(
    (requestIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )];

  if (!ids.length) return new Map();

  const map = new Map();

  for (const chunk of chunkArray(ids, 60)) {
    const url =
      `${supabaseUrl}/rest/v1/booking_requests` +
      `?select=id,name,email,phone,address` +
      `&id=in.(${chunk.join(",")})`;

    const r = await sbFetchJson(url, {
      headers: sbHeaders(serviceRole),
    });

    if (!r.ok) {
      throw new Error(`Could not load booking_requests: ${r.status} ${r.text}`);
    }

    for (const row of Array.isArray(r.data) ? r.data : []) {
      map.set(String(row.id), row);
    }
  }

  return map;
}

function isActivePartsRow(row, booking) {
  const billingStatus = String(row?.status || "").toLowerCase();
  const bookingStatus = String(booking?.status || "").toLowerCase();
  const partStatus = String(row?.part_status || "").toLowerCase();

  if (bookingStatus === "completed" || bookingStatus === "cancelled" || bookingStatus === "canceled") {
    return false;
  }

  if (billingStatus === "completed" || partStatus === "installed") {
    return false;
  }

  if (billingStatus === "parts_on_order") {
    return true;
  }

  return [
    "awaiting_payment",
    "ordered",
    "customer_receiving",
    "tech_receiving",
    "customer_has_part",
    "tech_has_part",
    "return_visit_ready"
  ].includes(partStatus);
}

function normalizePartStatus(row) {
  const partStatus = String(row?.part_status || "").toLowerCase();

  if (partStatus) return partStatus;

  const billingStatus = String(row?.status || "").toLowerCase();

  if (billingStatus === "parts_on_order") {
    const destination = String(row?.part_delivery_destination || "tech").toLowerCase();

    if (destination === "customer") return "customer_receiving";
    return "tech_receiving";
  }

  return "";
}

function safeOutput(row, booking, request) {
  const destination =
    String(row?.part_delivery_destination || "").toLowerCase() === "customer"
      ? "customer"
      : "tech";

  const partStatus = normalizePartStatus(row);

  return {
    billing_id: row.id || null,
    booking_id: row.booking_id || null,

    status: row.status || "",
    payment_status: row.payment_status || "",

    parts_cost_cents: Number(row.parts_cost_cents || 0),

    part_delivery_destination: destination,
    part_status: partStatus,

    part_ordered_at: row.part_ordered_at || null,
    part_paid_at: row.part_paid_at || null,
    part_on_hand_at: row.part_on_hand_at || null,
    part_customer_notified_at: row.part_customer_notified_at || null,
    return_visit_requested_at: row.return_visit_requested_at || null,
    return_visit_scheduled_at: row.return_visit_scheduled_at || null,

    part_tracking_notes:
      row.part_tracking_notes ||
      row.parts_order_notes ||
      "",

    job_ref: booking?.job_ref || "",
    booking_status: booking?.status || "",
    assigned_tech_id: booking?.assigned_tech_id || null,
    window_start: booking?.window_start || null,
    window_end: booking?.window_end || null,
    appointment_type: booking?.appointment_type || "",

    customer_name: request?.name || "",
    customer_email: request?.email || "",
    customer_phone: request?.phone || "",
    address: request?.address || ""
  };
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

    const accessToken = getBearerToken(req);

    if (!accessToken) {
      return res.status(401).json({
        ok: false,
        error: "Missing auth token",
      });
    }

    const user = await getUserFromToken({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      accessToken,
    });

    if (!user?.id) {
      return res.status(401).json({
        ok: false,
        error: "Invalid auth token",
      });
    }

    const profile = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "profiles",
      filters: { user_id: user.id },
      select: "user_id, role",
    });

    if (profile?.role !== "tech" && profile?.role !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "Only techs/admins can view parts on order.",
      });
    }

    const billingRows = await loadBillingRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
    });

    const bookingIds = billingRows
      .map((row) => row.booking_id)
      .filter(Boolean);

    const bookingMap = await loadBookingsByIds({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingIds,
    });

    const requestIds = [...bookingMap.values()]
      .map((booking) => booking.request_id)
      .filter(Boolean);

    const requestMap = await loadRequestsByIds({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      requestIds,
    });

    const rows = [];

    for (const billing of billingRows) {
      const booking = bookingMap.get(String(billing.booking_id || ""));
      if (!booking) continue;

      if (profile.role !== "admin" && String(booking.assigned_tech_id || "") !== String(user.id)) {
        continue;
      }

      if (!isActivePartsRow(billing, booking)) {
        continue;
      }

      const request = requestMap.get(String(booking.request_id || "")) || null;

      rows.push(safeOutput(billing, booking, request));
    }

    rows.sort((a, b) => {
      const aTime =
        new Date(a.part_ordered_at || a.part_paid_at || a.window_start || 0).getTime();

      const bTime =
        new Date(b.part_ordered_at || b.part_paid_at || b.window_start || 0).getTime();

      return bTime - aTime;
    });

    return res.status(200).json({
      ok: true,
      count: rows.length,
      parts_jobs: rows,
    });
  } catch (err) {
    console.error("tech-list-parts-on-order failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
