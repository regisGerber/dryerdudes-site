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

function cleanPhone(p) {
  return String(p || "").replace(/[^\d+]/g, "");
}

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

async function sendSmsTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from || !to) {
    return { skipped: true };
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
  if (!resp.ok) return { skipped: false, ok: false, status: resp.status, data };
  return { skipped: false, ok: true, status: resp.status, data };
}

async function sendEmailResend({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;

  if (!key || !to) {
    return { skipped: true };
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

async function sendReviewRequest({ request, booking }) {
  const reviewUrl = process.env.REVIEW_URL;

  if (!reviewUrl) {
    return { skipped: true, reason: "REVIEW_URL not set" };
  }

  const smsBody =
    `Dryer Dudes: thanks for choosing us! If you had a good experience, would you leave us a quick review?\n${reviewUrl}`;

  const html =
    `<p>Hi ${escHtml(request.name || "there")},</p>` +
    `<p>Thanks for choosing Dryer Dudes for job <strong>${escHtml(booking.job_ref || "")}</strong>.</p>` +
    `<p>If you had a good experience, would you leave us a quick review?</p>` +
    `<p><a href="${reviewUrl}">Leave a review</a></p>` +
    `<p>— Dryer Dudes</p>`;

  const smsResult = request.phone
    ? await sendSmsTwilio({ to: cleanPhone(request.phone), body: smsBody })
    : { skipped: true, reason: "no phone" };

  const emailResult = request.email
    ? await sendEmailResend({
        to: request.email,
        subject: "How did Dryer Dudes do?",
        html,
      })
    : { skipped: true, reason: "no email" };

  return { smsResult, emailResult };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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
      return res.status(403).json({ ok: false, error: "Only techs can complete bookings." });
    }

    const bookingId = String(req.body?.booking_id || "").trim();
    const sendReview = req.body?.send_review === true || req.body?.send_review === "true";

    if (!bookingId) {
      return res.status(400).json({ ok: false, error: "Missing booking_id" });
    }

    const booking = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: bookingId },
      select: "id,request_id,assigned_tech_id,status,job_ref,property_manager_id,request_source,paid_by_property_manager",
    });

    if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });

    if (profile.role !== "admin" && booking.assigned_tech_id !== user.id) {
      return res.status(403).json({ ok: false, error: "This booking is not assigned to the signed-in tech." });
    }

    const billing = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_billing",
      filters: { booking_id: booking.id },
      select: "*",
    });

    if (!billing) {
      return res.status(400).json({
        ok: false,
        error: "Billing must be submitted before completing the job.",
      });
    }

    if (billing.status === "pm_approval_needed" || billing.pm_approval_status === "pending") {
      return res.status(400).json({
        ok: false,
        error: "This job is waiting on property manager approval.",
      });
    }

    if (billing.status === "parts_on_order" || booking.status === "parts_on_order") {
      return res.status(400).json({
        ok: false,
        error: "This job has parts on order and cannot be completed yet.",
      });
    }

    const publicCustomerOwesMoney =
      !booking.property_manager_id &&
      Number(billing.remaining_due_cents || 0) > 0 &&
      billing.payment_status !== "paid";

    if (publicCustomerOwesMoney) {
      return res.status(400).json({
        ok: false,
        error: "Customer payment is required before completing this job.",
      });
    }

    const request = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: booking.request_id },
      select: "id,name,phone,email,address",
    });

    const updated = await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: booking.id },
      patch: {
        status: "completed",
        completed_at: new Date().toISOString(),
        review_requested_at: sendReview ? new Date().toISOString() : null,
      },
    });

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_billing",
      filters: { booking_id: booking.id },
      patch: {
        status: "completed",
        updated_at: new Date().toISOString(),
      },
    });

    let reviewResult = { skipped: true };

    if (sendReview && request) {
      reviewResult = await sendReviewRequest({ request, booking });
    }

    await insertEvent({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingId: booking.id,
      actorUserId: user.id,
      eventType: "completed",
      metadata: {
        send_review: sendReview,
        reviewResult,
      },
    });

    return res.status(200).json({
      ok: true,
      booking: updated,
      reviewResult,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
