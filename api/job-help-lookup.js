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

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeJobRef(jobRef) {
  return String(jobRef || "").trim().toUpperCase();
}

function hoursUntil(value) {
  if (!value) return null;
  return (new Date(value).getTime() - Date.now()) / 36e5;
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "en_route") return "en route";
  if (s === "on_site") return "on site";
  if (s === "billing_pending") return "billing pending";
  if (s === "awaiting_payment") return "awaiting payment";
  if (s === "parts_approval_needed") return "approval needed";
  if (s === "parts_on_order") return "parts on order";
  if (s === "cancelled") return "cancelled";
  return s || "scheduled";
}

async function logCustomerAction({ supabaseUrl, serviceRole, booking, actionType, metadata }) {
  try {
    await sbFetchJson(`${supabaseUrl}/rest/v1/booking_customer_actions`, {
      method: "POST",
      headers: {
        ...sbHeaders(serviceRole),
        Prefer: "return=representation",
      },
      body: JSON.stringify([{
        booking_id: booking.id,
        request_id: booking.request_id,
        job_ref: booking.job_ref,
        customer_email: booking.booking_requests?.email || null,
        action_type: actionType,
        status: "completed",
        metadata: metadata || null,
      }]),
    });
  } catch {
    // Do not break lookup if logging fails.
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const jobRef = normalizeJobRef(req.body?.job_ref);
    const email = normalizeEmail(req.body?.email);

    if (!jobRef || !email) {
      return res.status(400).json({
        ok: false,
        error: "Job number and email are required.",
      });
    }

    const url = new URL(`${SUPABASE_URL}/rest/v1/bookings`);
    url.searchParams.set(
      "select",
      `
        id,
        request_id,
        job_ref,
        status,
        window_start,
        window_end,
        payment_status,
        request_source,
        property_manager_id,
        booking_requests:request_id (
          id,
          name,
          email,
          phone,
          address,
          request_source,
          property_manager_id
        )
      `
    );
    url.searchParams.set("job_ref", `eq.${jobRef}`);
    url.searchParams.set("limit", "1");

    const r = await sbFetchJson(url.toString(), {
      headers: sbHeaders(SERVICE_ROLE),
    });

    const booking = Array.isArray(r.data) ? r.data[0] : null;

    if (!r.ok || !booking) {
      return res.status(404).json({
        ok: false,
        error: "Could not find that appointment. Check the job number and email.",
      });
    }

    const requestEmail = normalizeEmail(booking.booking_requests?.email);

    if (requestEmail !== email) {
      return res.status(404).json({
        ok: false,
        error: "Could not find that appointment. Check the job number and email.",
      });
    }

    const hrs = hoursUntil(booking.window_start);
    const outside48 = hrs == null ? false : hrs > 48;
    const activeStatus = !["completed", "cancelled", "no_show"].includes(
      String(booking.status || "").toLowerCase()
    );

    await logCustomerAction({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      booking,
      actionType: "lookup",
      metadata: {
        source: "job_help",
      },
    });

    return res.status(200).json({
      ok: true,
      job: {
        booking_id: booking.id,
        request_id: booking.request_id,
        job_ref: booking.job_ref,
        status: booking.status,
        status_label: statusLabel(booking.status),
        window_start: booking.window_start,
        window_end: booking.window_end,
        address: booking.booking_requests?.address || "",
        customer_name: booking.booking_requests?.name || "",
        request_source: booking.request_source,
        is_property_manager_job: !!booking.property_manager_id,
        hours_until_window: hrs,
        can_reschedule: activeStatus && outside48,
        can_cancel: activeStatus,
        cancel_refund_eligible: activeStatus && outside48,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
