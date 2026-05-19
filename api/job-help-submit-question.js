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

async function findVerifiedBooking({ supabaseUrl, serviceRole, jobRef, email }) {
  const url = new URL(`${supabaseUrl}/rest/v1/bookings`);
  url.searchParams.set(
    "select",
    `
      id,
      request_id,
      job_ref,
      status,
      window_start,
      window_end,
      booking_requests:request_id (
        id,
        name,
        email,
        phone,
        address
      )
    `
  );
  url.searchParams.set("job_ref", `eq.${jobRef}`);
  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  const booking = Array.isArray(r.data) ? r.data[0] : null;

  if (!r.ok || !booking) return null;

  if (normalizeEmail(booking.booking_requests?.email) !== email) return null;

  return booking;
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
    // Do not break the customer request if logging fails.
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

    const booking = await findVerifiedBooking({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      jobRef,
      email,
    });

    if (!booking) {
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
      body: JSON.stringify([{
        booking_id: booking.id,
        request_id: booking.request_id,
        job_ref: booking.job_ref,
        customer_email: booking.booking_requests?.email || email,
        customer_name: booking.booking_requests?.name || null,
        topic,
        question,
        predicted_answer_key: predictedAnswerKey || null,
        status: "new",
      }]),
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
