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
      "appointment_type",
      "request_source",
      "property_manager_id"
    ].join(",")
  );
  url.searchParams.set("job_ref", `eq.${jobRef}`);
  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) throw new Error(`Booking lookup failed: ${r.status} ${r.text}`);
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
      "appointment_type",
      "notes",
      "request_source",
      "property_manager_id"
    ].join(",")
  );
  url.searchParams.set("id", `eq.${requestId}`);
  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) throw new Error(`Booking request lookup failed: ${r.status} ${r.text}`);
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

  if (!r.ok) throw new Error(`Patch failed (${table}): ${r.status} ${r.text}`);
  return Array.isArray(r.data) ? r.data[0] || null : r.data;
}

async function insertCustomerAction({ supabaseUrl, serviceRole, booking, request, actionType, metadata }) {
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
        customer_email: request.email || null,
        action_type: actionType,
        status: "completed",
        metadata: metadata || null,
      },
    ]),
  });
}

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

async function sendEmailResend({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;

  if (!key || !to) {
    return { skipped: true, reason: "Resend key or email missing" };
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Dryer Dudes <scheduling@dryerdudes.com>",
      reply_to: "scheduling@dryerdudes.com",
      to: [to],
      subject,
      html,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return { skipped: false, ok: false, status: resp.status, data };
  return { skipped: false, ok: true, status: resp.status, data };
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
    const accessNotes = String(req.body?.access_notes || "").trim();

    const confirmAuthorizedEntry = req.body?.confirm_authorized_entry === true;
    const confirmDryerAccessible = req.body?.confirm_dryer_accessible === true;
    const confirmElectricDryer = req.body?.confirm_electric_dryer === true;

    if (!jobRef || !email) {
      return res.status(400).json({
        ok: false,
        error: "Job number and email are required.",
      });
    }

    if (!accessNotes) {
      return res.status(400).json({
        ok: false,
        error: "Access instructions are required.",
      });
    }

    if (!confirmAuthorizedEntry || !confirmDryerAccessible || !confirmElectricDryer) {
      return res.status(400).json({
        ok: false,
        error: "Please confirm the authorized-entry requirements.",
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

    const activeStatus = !["completed", "cancelled", "canceled", "no_show"].includes(
      String(booking.status || "").toLowerCase()
    );

    if (!activeStatus) {
      return res.status(400).json({
        ok: false,
        error: "This appointment is no longer active.",
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

    const nowIso = new Date().toISOString();

    const existingNotes = String(request.notes || "").trim();
    const appendedNotes = [
      existingNotes,
      `Authorized entry instructions: ${accessNotes}`
    ].filter(Boolean).join("\n\n");

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: request.id },
      patch: {
        appointment_type: "no_one_home",
        authorized_entry: true,
        authorized_entry_at: nowIso,
        authorized_entry_notes: accessNotes,
        notes: appendedNotes,
      },
    });

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: booking.id },
      patch: {
        appointment_type: "no_one_home",
        authorized_entry_at: nowIso,
        authorized_entry_notes: accessNotes,
      },
    });

    await insertCustomerAction({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      booking,
      request,
      actionType: "authorized_entry",
      metadata: {
        access_notes: accessNotes,
      },
    });

    const emailResult = await sendEmailResend({
      to: request.email,
      subject: `Authorized entry saved — ${booking.job_ref}`,
      html:
        `<p>Hi ${escHtml(request.name || "there")},</p>` +
        `<p>Your authorized-entry instructions were saved for job <strong>${escHtml(booking.job_ref)}</strong>.</p>` +
        `<p><strong>Access instructions:</strong></p>` +
        `<p>${escHtml(accessNotes)}</p>` +
        `<p>— Dryer Dudes</p>`,
    });

    return res.status(200).json({
      ok: true,
      message: "Authorized entry saved.",
      emailResult,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
