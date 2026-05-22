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

  if (/^\d{6}$/.test(s)) s = `DD-${s}`;

  const compact = s.match(/^DD(\d{6})$/);
  if (compact) s = `DD-${compact[1]}`;

  return s;
}

function cleanTopic(topic) {
  const t = String(topic || "other").trim().toLowerCase();

  const allowed = new Set([
    "reschedule",
    "cancel",
    "payment",
    "arrival_window",
    "preparation",
    "service_scope",
    "property_manager",
    "other",
  ]);

  return allowed.has(t) ? t : "other";
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
      "request_source",
      "property_manager_id"
    ].join(",")
  );

  url.searchParams.set("job_ref", `eq.${jobRef}`);
  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
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
    // Do not block customer question if logging fails.
  }
}

export default async function handler(req, res) {
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

    const jobRef = normalizeJobRef(req.body?.job_ref);
    const email = normalizeEmail(req.body?.email);
    const topic = cleanTopic(req.body?.topic);
    const question = String(req.body?.question || "").trim();
    const predictedAnswerKey = String(req.body?.predicted_answer_key || "").trim();

    if (!jobRef || !email) {
      return res.status(400).json({
        ok: false,
        error: "Job number and email are required.",
      });
    }

    if (!question || question.length < 5) {
      return res.status(400).json({
        ok: false,
        error: "Please enter a question.",
      });
    }

    const booking = await getBookingByJobRef({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      jobRef,
    });

    if (!booking) {
      return res.status(404).json({
        ok: false,
        error: "Could not find that appointment. Check the job number and email.",
      });
    }

    const request = await getBookingRequestById({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      requestId: booking.request_id,
    });

    if (!request || normalizeEmail(request.email) !== email) {
      return res.status(404).json({
        ok: false,
        error: "Could not find that appointment. Check the job number and email.",
      });
    }

    const insertResp = await sbFetchJson(`${SUPABASE_URL}/rest/v1/job_help_requests`, {
      method: "POST",
      headers: {
        ...sbHeaders(SERVICE_ROLE),
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          booking_id: booking.id,
          request_id: booking.request_id,
          job_ref: booking.job_ref,
          customer_email: request.email || email,
          customer_name: request.name || null,
          topic,
          question,
          predicted_answer_key: predictedAnswerKey || null,
          status: "new",
        },
      ]),
    });

    if (!insertResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not submit question.",
        details: insertResp.data,
      });
    }

    await logCustomerAction({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      booking,
      request,
      actionType: "question_submitted",
      metadata: {
        topic,
        predicted_answer_key: predictedAnswerKey || null,
      },
    });

    const row = Array.isArray(insertResp.data) ? insertResp.data[0] : null;

    return res.status(200).json({
      ok: true,
      request_id: row?.id || null,
      message: "Question sent. Dryer Dudes will respond by email.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
