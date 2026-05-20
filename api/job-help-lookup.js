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
  let s = String(jobRef || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  // Allow "245847" and turn it into "DD-245847"
  if (/^\d{6}$/.test(s)) {
    s = `DD-${s}`;
  }

  // Allow "DD245847" and turn it into "DD-245847"
  const compact = s.match(/^DD(\d{6})$/);
  if (compact) {
    s = `DD-${compact[1]}`;
  }

  return s;
}

function hoursUntil(value) {
  if (!value) return null;
  return (new Date(value).getTime() - Date.now()) / 36e5;
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();

  if (s === "scheduled") return "scheduled";
  if (s === "en_route") return "en route";
  if (s === "on_site") return "on site";
  if (s === "billing_pending") return "billing pending";
  if (s === "awaiting_payment") return "awaiting payment";
  if (s === "parts_approval_needed") return "approval needed";
  if (s === "parts_on_order") return "parts on order";
  if (s === "completed") return "completed";
  if (s === "cancelled") return "cancelled";
  if (s === "canceled") return "cancelled";
  if (s === "no_show") return "no show";

  return s || "scheduled";
}

async function getBookingByJobRef({ supabaseUrl, serviceRole, jobRef }) {
  const url = new URL(`${supabaseUrl}/rest/v1/bookings`);

  url.searchParams.set(
    "select",
    [
      "id",
      "request_id",
      "job_ref",
      "status",
      "window_start",
      "window_end",
      "payment_status",
      "request_source",
      "property_manager_id"
    ].join(",")
  );

  url.searchParams.set("job_ref", `eq.${jobRef}`);
  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    method: "GET",
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Booking lookup failed: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

async function getBookingRequestById({ supabaseUrl, serviceRole, requestId }) {
  const url = new URL(`${supabaseUrl}/rest/v1/booking_requests`);

  url.searchParams.set(
    "select",
    [
      "id",
      "name",
      "email",
      "phone",
      "address",
      "request_source",
      "property_manager_id"
    ].join(",")
  );

  url.searchParams.set("id", `eq.${requestId}`);
  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    method: "GET",
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Booking request lookup failed: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

async function logCustomerAction({ supabaseUrl, serviceRole, booking, request, actionType, metadata }) {
  try {
    await sbFetchJson(`${supabaseUrl}/rest/v1/booking_customer_actions`, {
      method: "POST",
      headers: {
        ...sbHeaders(serviceRole),
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          booking_id: booking.id,
          request_id: booking.request_id,
          job_ref: booking.job_ref,
          customer_email: request?.email || null,
          action_type: actionType,
          status: "completed",
          metadata: metadata || null,
        },
      ]),
    });
  } catch {
    // Do not block lookup if logging fails.
  }
}

function getInput(req) {
  if (req.method === "GET") {
    return {
      job_ref: req.query?.job_ref || req.query?.jobRef || req.query?.job || req.query?.ref || "",
      email: req.query?.email || "",
    };
  }

  return {
    job_ref: req.body?.job_ref || req.body?.jobRef || req.body?.job || req.body?.ref || "",
    email: req.body?.email || "",
  };
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const input = getInput(req);

    const jobRef = normalizeJobRef(input.job_ref);
    const email = normalizeEmail(input.email);

    if (!jobRef || !email) {
      return res.status(200).json({
        ok: false,
        error: "Job number and email are required.",
      });
    }

    const booking = await getBookingByJobRef({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      jobRef,
    });

    if (!booking) {
      return res.status(200).json({
        ok: false,
        error: "Could not find that appointment. Check the job number and email.",
      });
    }

    const request = await getBookingRequestById({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      requestId: booking.request_id,
    });

    if (!request) {
      return res.status(200).json({
        ok: false,
        error: "Could not find that appointment. Check the job number and email.",
      });
    }

    const requestEmail = normalizeEmail(request.email);

    if (requestEmail !== email) {
      return res.status(200).json({
        ok: false,
        error: "Could not find that appointment. Check the job number and email.",
      });
    }

    const hrs = hoursUntil(booking.window_start);

    const activeStatus = !["completed", "cancelled", "canceled", "no_show"].includes(
      String(booking.status || "").toLowerCase()
    );

    const outside48 = hrs == null ? false : hrs > 48;

    await logCustomerAction({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      booking,
      request,
      actionType: "lookup",
      metadata: {
        source: "job_help",
        method: req.method,
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
        address: request.address || "",
        customer_name: request.name || "",
        request_source: booking.request_source,
        is_property_manager_job: !!booking.property_manager_id,
        hours_until_window: hrs,
        can_reschedule: activeStatus && outside48,
        can_cancel: activeStatus,
        cancel_refund_eligible: activeStatus && outside48,
      },
    });
  } catch (err) {
    console.error("job-help-lookup failed", err);

    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
