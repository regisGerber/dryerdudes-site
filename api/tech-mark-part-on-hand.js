// /api/tech-mark-part-on-hand.js

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
    console.error("Event insert failed", r.status, r.text);
  }

  return r.data;
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

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

function normalizeE164US(phoneRaw) {
  const p = String(phoneRaw || "").trim();
  if (!p) return "";

  if (p.startsWith("+")) return p;

  const digits = p.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return p;
}

async function sendSmsTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;

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
      To: normalizeE164US(to),
      Body: String(body || ""),
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

async function notifyCustomerPartOnHand({ origin, request, booking }) {
  const jobRef = booking.job_ref || "";
  const helpUrl = `${origin}/job-help.html?job_ref=${encodeURIComponent(jobRef)}`;

  const smsBody =
    `Dryer Dudes: the part for job ${jobRef} is now on hand.\n\n` +
    `Your original repair visit already covers the return visit and installation for this ordered part.\n` +
    `Return visit help: ${helpUrl}\n` +
    `Reply STOP to opt out.`;

  const html =
    `<p>Hi ${escHtml(request.name || "there")},</p>` +
    `<p>The part for Dryer Dudes job <strong>${escHtml(jobRef)}</strong> is now on hand.</p>` +
    `<p><strong>Good news:</strong> your original repair visit already covers the return visit and installation for this ordered part. You do not need to pay another service visit charge for the return visit.</p>` +
    `<p>Use Appointment Help to request the return visit:</p>` +
    `<p><a href="${helpUrl}">Open Appointment Help</a></p>` +
    `<p>— Dryer Dudes</p>`;

  let smsResult = { skipped: true };
  let emailResult = { skipped: true };

  try {
    smsResult = request.phone
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
    emailResult = request.email
      ? await sendEmailResend({
          to: request.email,
          subject: `Dryer Dudes part is ready — ${jobRef}`,
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

  return { smsResult, emailResult, helpUrl };
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
      return res.status(403).json({
        ok: false,
        error: "Only techs can mark parts on hand.",
      });
    }

    const bookingId = String(req.body?.booking_id || "").trim();

    if (!bookingId) {
      return res.status(400).json({
        ok: false,
        error: "Missing booking_id",
      });
    }

    const booking = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: bookingId },
      select: "id,request_id,assigned_tech_id,status,job_ref",
    });

    if (!booking) {
      return res.status(404).json({
        ok: false,
        error: "Booking not found.",
      });
    }

    if (profile.role !== "admin" && String(booking.assigned_tech_id || "") !== String(user.id)) {
      return res.status(403).json({
        ok: false,
        error: "This booking is not assigned to the signed-in tech.",
      });
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
        error: "Billing record not found for this job.",
      });
    }

    const billingStatus = String(billing.status || "").toLowerCase();
    const partStatus = String(billing.part_status || "").toLowerCase();
    const destination = String(billing.part_delivery_destination || "tech").toLowerCase();

    if (billingStatus !== "parts_on_order" && !partStatus.includes("receiving")) {
      return res.status(400).json({
        ok: false,
        error: "This job is not currently waiting on an ordered part.",
      });
    }

    if (destination === "customer") {
      return res.status(400).json({
        ok: false,
        error: "This part is marked as customer delivery. Customer-arrived flow will be added next.",
      });
    }

    if (String(billing.payment_status || "").toLowerCase() !== "paid") {
      return res.status(400).json({
        ok: false,
        error: "The part must be paid before marking it on hand.",
      });
    }

    const request = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: booking.request_id },
      select: "id,name,email,phone,address",
    });

    const nowIso = new Date().toISOString();
    const origin = getOrigin(req);

    const updatedBilling = await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_billing",
      filters: { booking_id: booking.id },
      patch: {
        part_status: "tech_has_part",
        part_on_hand_at: nowIso,
        part_customer_notified_at: nowIso,
        return_visit_requested_at: nowIso,
        updated_at: nowIso,
      },
    });

    const updatedBooking = await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: booking.id },
      patch: {
        status: "return_visit_needed",
      },
    });

    let notifyResult = { skipped: true };

    if (request) {
      notifyResult = await notifyCustomerPartOnHand({
        origin,
        request,
        booking,
      });
    }

    await insertEvent({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingId: booking.id,
      actorUserId: user.id,
      eventType: "part_on_hand",
      metadata: {
        notifyResult,
        previous_part_status: billing.part_status || null,
        part_delivery_destination: destination,
      },
    });

    return res.status(200).json({
      ok: true,
      booking: updatedBooking,
      billing: updatedBilling,
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
