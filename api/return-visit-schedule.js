// /api/return-visit-schedule.js
// Public token endpoint.
// Schedules selected return visit window without additional payment.
// Optional Authorized Entry can be applied to any selected return visit option.

const { sendSmsTwilio } = require("./_twilio");

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

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host =
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req.headers.host || "").trim();

  return `${proto}://${host}`;
}

function escHtml(value) {
  return String(value ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

function formatDate(isoDate) {
  const s = String(isoDate || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;

  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function formatTime(t) {
  const raw = String(t || "").slice(0, 5);
  const m = raw.match(/^(\d{2}):(\d{2})$/);
  if (!m) return raw;

  let h = Number(m[1]);
  const mm = m[2];
  const ampm = h >= 12 ? "PM" : "AM";

  h = h % 12;
  if (h === 0) h = 12;

  return `${h}:${mm} ${ampm}`;
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

  if (!resp.ok) {
    return { skipped: false, ok: false, status: resp.status, data };
  }

  return { skipped: false, ok: true, status: resp.status, data };
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

async function sendReturnVisitConfirmation({
  origin,
  request,
  scheduled,
  authorizedEntry,
}) {
  const jobRef = scheduled.job_ref || "";
  const line = `${formatDate(scheduled.service_date)} • ${formatTime(scheduled.start_time)}–${formatTime(scheduled.end_time)}`;
  const helpUrl = `${origin}/job-help.html?job_ref=${encodeURIComponent(jobRef)}`;

  const smsBody =
    `Dryer Dudes: your return visit is scheduled.\n\n` +
    `Arrival window: ${line}\n` +
    `Job ref: ${jobRef}\n` +
    (authorizedEntry ? `Visit type: Authorized Entry\n` : "") +
    `\nYour original repair visit covers this return visit and installation for the ordered part.\n` +
    `Reply STOP to opt out.`;

  const html =
    `<p>Hi ${escHtml(request?.name || "there")},</p>` +
    `<p>Your Dryer Dudes return visit has been scheduled.</p>` +
    `<p><strong>Arrival window:</strong><br>${escHtml(line)}</p>` +
    `<p><strong>Job ref:</strong> ${escHtml(jobRef)}</p>` +
    (authorizedEntry ? `<p><strong>Visit type:</strong> Authorized Entry</p>` : "") +
    `<p><strong>Good news:</strong> your original repair visit already covers the return visit and installation for this ordered part. You do not need to pay another service visit charge for this return visit.</p>` +
    `<p>If you need help with this job, use Appointment Help:<br><a href="${helpUrl}">Appointment Help</a></p>` +
    `<p>— Dryer Dudes</p>`;

  let smsResult = { skipped: true };
  let emailResult = { skipped: true };

  try {
    smsResult = request?.phone
      ? await sendSmsTwilio({ to: request.phone, body: smsBody })
      : { skipped: true, reason: "no phone" };
  } catch (smsErr) {
    smsResult = {
      skipped: false,
      ok: false,
      error: smsErr?.message || String(smsErr),
    };
  }

  try {
    emailResult = request?.email
      ? await sendEmailResend({
          to: request.email,
          subject: `Dryer Dudes return visit scheduled — ${jobRef}`,
          html,
        })
      : { skipped: true, reason: "no email" };
  } catch (emailErr) {
    emailResult = {
      skipped: false,
      ok: false,
      error: emailErr?.message || String(emailErr),
    };
  }

  return { smsResult, emailResult };
}

function appendReturnVisitAuthorizedEntryNotes(existingNotes, accessNotes) {
  const existing = String(existingNotes || "").trim();
  const block =
    `Return visit Authorized Entry instructions:\n` +
    `${String(accessNotes || "").trim()}`;

  if (!existing) return block;
  if (existing.includes(block)) return existing;

  return `${existing}\n\n${block}`;
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

    const body = req.body || {};
    const token = String(body.token || "").trim();
    const slotId = String(body.slot_id || "").trim();

    const authorizedEntry =
      body.authorized_entry === true ||
      body.authorized_entry === "true" ||
      body.authorized_entry === 1 ||
      body.authorized_entry === "1";

    const accessNotes = String(body.access_notes || "").trim();
    const confirmAuthorizedEntry =
      body.confirm_authorized_entry === true ||
      body.confirm_authorized_entry === "true" ||
      body.confirm_authorized_entry === 1 ||
      body.confirm_authorized_entry === "1";

    const confirmDryerAccessible =
      body.confirm_dryer_accessible === true ||
      body.confirm_dryer_accessible === "true" ||
      body.confirm_dryer_accessible === 1 ||
      body.confirm_dryer_accessible === "1";

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Missing return visit token",
      });
    }

    if (!slotId) {
      return res.status(400).json({
        ok: false,
        error: "Choose a return visit window first.",
      });
    }

    if (authorizedEntry) {
      if (!accessNotes) {
        return res.status(400).json({
          ok: false,
          error: "Authorized Entry access instructions are required.",
        });
      }

      if (!confirmAuthorizedEntry || !confirmDryerAccessible) {
        return res.status(400).json({
          ok: false,
          error: "Authorized Entry permissions must be confirmed.",
        });
      }
    }

    const rpc = await sbFetchJson(`${SUPABASE_URL}/rest/v1/rpc/schedule_return_visit`, {
      method: "POST",
      headers: sbHeaders(SERVICE_ROLE),
      body: JSON.stringify({
        p_return_visit_token: token,
        p_slot_id: slotId,
      }),
    });

    if (!rpc.ok) {
      return res.status(409).json({
        ok: false,
        error: "Could not schedule return visit.",
        message: rpc.data?.message || rpc.data?.error || rpc.text || "That return visit window may no longer be available.",
      });
    }

    const scheduled = Array.isArray(rpc.data) ? rpc.data[0] || null : null;

    if (!scheduled?.booking_id) {
      return res.status(500).json({
        ok: false,
        error: "Return visit was not scheduled.",
      });
    }

    const booking = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: scheduled.booking_id },
      select: "id,request_id,job_ref,tech_notes",
    });

    const request = booking?.request_id
      ? await getSingle({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "booking_requests",
          filters: { id: booking.request_id },
          select: "id,name,email,phone,address,notes",
        })
      : null;

    if (authorizedEntry && booking?.id) {
      await patchRows({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "bookings",
        filters: { id: booking.id },
        patch: {
          appointment_type: "no_one_home",
        },
      });

      if (request?.id) {
        await patchRows({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "booking_requests",
          filters: { id: request.id },
          patch: {
            notes: appendReturnVisitAuthorizedEntryNotes(request.notes, accessNotes),
          },
        });
      }
    }

    const origin = getOrigin(req);

    const notifyResult = await sendReturnVisitConfirmation({
      origin,
      request,
      scheduled,
      authorizedEntry,
    });

    await insertEvent({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingId: scheduled.booking_id,
      eventType: "return_visit_scheduled",
      metadata: {
        scheduled,
        authorized_entry: authorizedEntry,
        access_notes: authorizedEntry ? accessNotes : null,
        notifyResult,
      },
    });

    return res.status(200).json({
      ok: true,
      scheduled: {
        ...scheduled,
        authorized_entry: authorizedEntry,
      },
      notifyResult,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
