// /api/tech-list-parts-on-order.js

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

function isActivePartsRow(row) {
  const billingStatus = String(row.status || "").toLowerCase();
  const partStatus = String(row.part_status || "").toLowerCase();

  if (billingStatus === "parts_on_order") return true;

  return [
    "awaiting_payment",
    "ordered",
    "tech_receiving",
    "customer_receiving",
    "tech_has_part",
    "customer_has_part",
    "return_visit_ready"
  ].includes(partStatus);
}

function safeBooking(row) {
  const booking = row.bookings || {};
  const request = booking.booking_requests || {};

  return {
    billing_id: row.id,
    booking_id: row.booking_id,
    request_id: row.request_id,

    status: row.status,
    payment_status: row.payment_status,

    parts_cost_cents: row.parts_cost_cents || 0,
    part_delivery_destination: row.part_delivery_destination || null,
    part_status: row.part_status || null,
    part_ordered_at: row.part_ordered_at || null,
    part_paid_at: row.part_paid_at || null,
    part_on_hand_at: row.part_on_hand_at || null,
    part_customer_notified_at: row.part_customer_notified_at || null,
    return_visit_requested_at: row.return_visit_requested_at || null,
    return_visit_scheduled_at: row.return_visit_scheduled_at || null,
    part_tracking_notes: row.part_tracking_notes || row.parts_order_notes || "",

    job_ref: booking.job_ref || "",
    booking_status: booking.status || "",
    assigned_tech_id: booking.assigned_tech_id || null,
    window_start: booking.window_start || null,
    window_end: booking.window_end || null,

    customer_name: request.name || "",
    customer_email: request.email || "",
    customer_phone: request.phone || "",
    address: request.address || ""
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const accessToken = getBearerToken(req);

    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "Missing auth token" });
    }

    const user = await getUserFromToken({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      accessToken,
    });

    if (!user?.id) {
      return res.status(401).json({ ok: false, error: "Invalid auth token" });
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
        error: "Only techs can view parts on order.",
      });
    }

    const url = new URL(`${SUPABASE_URL}/rest/v1/booking_billing`);
    url.searchParams.set(
      "select",
      [
        "id",
        "booking_id",
        "request_id",
        "status",
        "payment_status",
        "parts_cost_cents",
        "parts_order_notes",
        "part_delivery_destination",
        "part_status",
        "part_ordered_at",
        "part_paid_at",
        "part_on_hand_at",
        "part_customer_notified_at",
        "return_visit_requested_at",
        "return_visit_scheduled_at",
        "part_tracking_notes",
        "updated_at",
        "bookings:booking_id(id,job_ref,status,assigned_tech_id,window_start,window_end,booking_requests:request_id(id,name,email,phone,address))"
      ].join(",")
    );
    url.searchParams.set("order", "updated_at.desc");
    url.searchParams.set("limit", "150");

    const r = await sbFetchJson(url.toString(), {
      headers: sbHeaders(SERVICE_ROLE),
    });

    if (!r.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not load parts on order.",
        details: r.text,
      });
    }

    const rows = Array.isArray(r.data) ? r.data : [];

    const filtered = rows
      .filter(isActivePartsRow)
      .filter((row) => {
        const booking = row.bookings || {};

        if (profile.role === "admin") return true;

        return String(booking.assigned_tech_id || "") === String(user.id);
      })
      .map(safeBooking);

    return res.status(200).json({
      ok: true,
      parts_jobs: filtered,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
