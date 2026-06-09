// /api/customer-part-arrived.js
// Public token endpoint.
// Customer uses this after a customer-delivered part arrives.
// It marks the part as customer_has_part so return-visit.html can show scheduling options.

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

async function patchRows({ supabaseUrl, serviceRole, table, filters, patch }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  const r = await sbFetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  if (!r.ok) {
    throw new Error(`Supabase patch failed (${table}): ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data[0] || null : r.data;
}

async function insertEvent({ supabaseUrl, serviceRole, bookingId, eventType, metadata }) {
  const r = await sbFetchJson(`${supabaseUrl}/rest/v1/booking_events`, {
    method: "POST",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify([{
      booking_id: bookingId,
      actor_user_id: null,
      event_type: eventType,
      metadata: metadata || null,
    }]),
  });

  return r;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.body?.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Missing return visit token.",
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
        error: "Return visit link not found.",
      });
    }

    if (String(billing.payment_status || "").toLowerCase() !== "paid") {
      return res.status(409).json({
        ok: false,
        error: "The ordered part must be paid before scheduling the return visit.",
      });
    }

    const destination = String(billing.part_delivery_destination || "").toLowerCase();
    const partStatus = String(billing.part_status || "").toLowerCase();

    if (destination !== "customer") {
      return res.status(409).json({
        ok: false,
        error: "This part is not marked as customer delivery.",
      });
    }

    if (partStatus === "customer_has_part" || partStatus === "return_visit_ready") {
      return res.status(200).json({
        ok: true,
        already_ready: true,
      });
    }

    if (partStatus !== "customer_receiving") {
      return res.status(409).json({
        ok: false,
        error: "This part is not currently waiting for customer delivery.",
      });
    }

    const nowIso = new Date().toISOString();

    const updatedBilling = await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_billing",
      filters: { booking_id: billing.booking_id },
      patch: {
        part_status: "customer_has_part",
        part_on_hand_at: nowIso,
        return_visit_requested_at: nowIso,
        updated_at: nowIso,
      },
    });

    await insertEvent({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingId: billing.booking_id,
      eventType: "customer_part_arrived",
      metadata: {
        previous_part_status: billing.part_status || null,
        part_delivery_destination: destination,
      },
    });

    return res.status(200).json({
      ok: true,
      billing: updatedBilling,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
