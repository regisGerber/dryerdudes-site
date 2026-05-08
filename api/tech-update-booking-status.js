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

async function insertEvent({ supabaseUrl, serviceRole, bookingId, actorUserId, eventType, metadata }) {
  const r = await sbFetchJson(`${supabaseUrl}/rest/v1/booking_events`, {
    method: "POST",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify([{
      booking_id: bookingId,
      actor_user_id: actorUserId,
      event_type: eventType,
      metadata: metadata || null,
    }]),
  });

  if (!r.ok) {
    throw new Error(`Event insert failed: ${r.status} ${r.text}`);
  }

  return r.data;
}

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

function fmtTimeLocal(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

async function sendSmsTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from || !to) {
    return { skipped: true, reason: "Twilio env vars or phone missing" };
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Body: body,
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return { skipped: false, ok: false, status: resp.status, data };
  }

  return { skipped: false, ok: true, status: resp.status, data };
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

async function sendEnRouteNotification({ booking, request }) {
  const start = fmtTimeLocal(booking.window_start);
  const end = fmtTimeLocal(booking.window_end);
  const name = request?.name || "there";
  const jobRef = booking?.job_ref || "";

  const smsBody =
    `Dryer Dudes: your technician is on the way.\n` +
    `Arrival window: ${start}–${end}` +
    (jobRef ? `\nJob ref: ${jobRef}` : "") +
    `\nReply STOP to opt out.`;

  const html =
    `<p>Hi ${escHtml(name)},</p>` +
    `<p>Your Dryer Dudes technician is on the way.</p>` +
    `<p><strong>Arrival window:</strong> ${escHtml(start)}–${escHtml(end)}</p>` +
    (jobRef ? `<p><strong>Job ref:</strong> ${escHtml(jobRef)}</p>` : "") +
    `<p>— Dryer Dudes</p>`;

  const smsResult = request?.phone
    ? await sendSmsTwilio({ to: request.phone, body: smsBody })
    : { skipped: true, reason: "no phone" };

  const emailResult = request?.email
    ? await sendEmailResend({
        to: request.email,
        subject: "Dryer Dudes technician is on the way",
        html,
      })
    : { skipped: true, reason: "no email" };

  return { smsResult, emailResult };
}

function minutesUntil(dateValue) {
  return (new Date(dateValue).getTime() - Date.now()) / 60000;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
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
        error: "Only assigned techs can update booking status",
      });
    }

    const bookingId = String(req.body?.booking_id || "").trim();
    const newStatus = String(req.body?.status || "").trim().toLowerCase();

    if (!bookingId) {
      return res.status(400).json({
        ok: false,
        error: "Missing booking_id",
      });
    }

    const allowedStatuses = new Set(["en_route", "on_site"]);

    if (!allowedStatuses.has(newStatus)) {
      return res.status(400).json({
        ok: false,
        error: "This status is not available from the quick tech action yet.",
      });
    }

    const booking = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: bookingId },
      select: "id, request_id, assigned_tech_id, window_start, window_end, status, job_ref",
    });

    if (!booking) {
      return res.status(404).json({
        ok: false,
        error: "Booking not found",
      });
    }

    if (profile.role !== "admin" && booking.assigned_tech_id !== user.id) {
      return res.status(403).json({
        ok: false,
        error: "This booking is not assigned to the signed-in tech.",
      });
    }

    if (newStatus === "en_route") {
      const mins = minutesUntil(booking.window_start);

      if (mins > 30) {
        return res.status(400).json({
          ok: false,
          error: "En Route can only be selected within 30 minutes of the appointment window.",
          minutes_until_window: Math.round(mins),
        });
      }
    }

    const patch = { status: newStatus };

    if (newStatus === "en_route") {
      patch.en_route_at = new Date().toISOString();
    }

    if (newStatus === "on_site") {
      patch.on_site_at = new Date().toISOString();
    }

    const updated = await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: booking.id },
      patch,
    });

    let notification = { skipped: true };

    if (newStatus === "en_route") {
      const request = await getSingle({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "booking_requests",
        filters: { id: booking.request_id },
        select: "id, name, phone, email, address",
      });

      notification = await sendEnRouteNotification({
        booking,
        request,
      });
    }

    await insertEvent({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingId: booking.id,
      actorUserId: user.id,
      eventType: `status_${newStatus}`,
      metadata: {
        previous_status: booking.status,
        new_status: newStatus,
        notification,
      },
    });

    return res.status(200).json({
      ok: true,
      booking: updated,
      notification,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
