// /api/send-review-requests.js
// Sends delayed Google review requests after tech-approved completed jobs.
// Intended for Vercel Cron.

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

  return {
    ok: resp.ok,
    status: resp.status,
    data,
    text,
  };
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
    return {
      skipped: true,
      reason: "Resend key or email missing",
    };
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
    return {
      skipped: false,
      ok: false,
      status: resp.status,
      data,
    };
  }

  return {
    skipped: false,
    ok: true,
    status: resp.status,
    data,
  };
}

async function loadDueReviewBookings({ supabaseUrl, serviceRole }) {
  const nowIso = new Date().toISOString();

  const url = new URL(`${supabaseUrl}/rest/v1/bookings`);
  url.searchParams.set(
    "select",
    "id,request_id,job_ref,completed_at,review_requested_at,review_request_due_at,review_request_status,review_request_sent_at"
  );
  url.searchParams.set("status", "eq.completed");
  url.searchParams.set("review_request_status", "eq.queued");
  url.searchParams.set("review_request_sent_at", "is.null");
  url.searchParams.set("review_request_due_at", `lte.${nowIso}`);
  url.searchParams.set("order", "review_request_due_at.asc");
  url.searchParams.set("limit", "25");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Could not load due review requests: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data : [];
}

function buildReviewSms({ request, booking, reviewUrl }) {
  const name = String(request?.name || "there").trim();

  return (
    `Dryer Dudes: thanks for choosing us, ${name}! ` +
    `If you had a good experience, would you leave us a quick Google review?\n` +
    `${reviewUrl}\n` +
    `Reply STOP to opt out.`
  );
}

function buildReviewEmailHtml({ request, booking, reviewUrl }) {
  return (
    `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:640px;margin:0 auto;">` +
      `<h2 style="margin:0 0 12px;">How did Dryer Dudes do?</h2>` +
      `<p>Hi ${escHtml(request?.name || "there")},</p>` +
      `<p>Thanks for choosing Dryer Dudes for job <strong>${escHtml(booking?.job_ref || "")}</strong>.</p>` +
      `<p>If you had a good experience, would you leave us a quick Google review?</p>` +
      `<p><a href="${escHtml(reviewUrl)}" style="font-weight:bold;">Leave a Google review</a></p>` +
      `<p>— Dryer Dudes</p>` +
    `</div>`
  );
}

async function sendReviewRequest({ request, booking, reviewUrl }) {
  let smsResult = { skipped: true };
  let emailResult = { skipped: true };

  try {
    smsResult = request?.phone
      ? await sendSmsTwilio({
          to: request.phone,
          body: buildReviewSms({ request, booking, reviewUrl }),
        })
      : {
          skipped: true,
          reason: "No phone",
        };
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
          subject: "How did Dryer Dudes do?",
          html: buildReviewEmailHtml({ request, booking, reviewUrl }),
        })
      : {
          skipped: true,
          reason: "No email",
        };
  } catch (emailErr) {
    emailResult = {
      skipped: false,
      ok: false,
      error: emailErr?.message || String(emailErr),
    };
  }

  return {
    smsResult,
    emailResult,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const REVIEW_URL = requireEnv("REVIEW_URL");

    const dueBookings = await loadDueReviewBookings({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
    });

    const results = [];

    for (const booking of dueBookings) {
      let claimed = null;

      try {
        claimed = await patchRows({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "bookings",
          filters: {
            id: booking.id,
            review_request_status: "queued",
          },
          patch: {
            review_request_status: "sending",
            review_request_error: null,
          },
        });
      } catch (claimErr) {
        results.push({
          booking_id: booking.id,
          ok: false,
          stage: "claim",
          error: claimErr?.message || String(claimErr),
        });
        continue;
      }

      if (!claimed?.id) {
        results.push({
          booking_id: booking.id,
          skipped: true,
          reason: "Already claimed or no longer queued.",
        });
        continue;
      }

      try {
        const request = await getSingle({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "booking_requests",
          filters: { id: booking.request_id },
          select: "id,name,phone,email",
        });

        if (!request) {
          throw new Error("Booking request not found.");
        }

        const sendResult = await sendReviewRequest({
          request,
          booking,
          reviewUrl: REVIEW_URL,
        });

        const nowIso = new Date().toISOString();

        await patchRows({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "bookings",
          filters: { id: booking.id },
          patch: {
            review_request_status: "sent",
            review_request_sent_at: nowIso,
            review_request_error: null,
          },
        });

        await insertEvent({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          bookingId: booking.id,
          eventType: "review_request_sent",
          metadata: {
            review_url: REVIEW_URL,
            sendResult,
          },
        });

        results.push({
          booking_id: booking.id,
          job_ref: booking.job_ref,
          ok: true,
          sent: true,
          sendResult,
        });
      } catch (sendErr) {
        const message = sendErr?.message || String(sendErr);

        await patchRows({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "bookings",
          filters: { id: booking.id },
          patch: {
            review_request_status: "error",
            review_request_error: message,
          },
        });

        await insertEvent({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          bookingId: booking.id,
          eventType: "review_request_error",
          metadata: {
            error: message,
          },
        });

        results.push({
          booking_id: booking.id,
          job_ref: booking.job_ref,
          ok: false,
          error: message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      due_count: dueBookings.length,
      sent_count: results.filter((r) => r.ok && r.sent).length,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
