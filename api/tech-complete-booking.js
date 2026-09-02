// /api/tech-complete-booking.js

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

  return {
    ok: resp.ok,
    status: resp.status,
    data,
    text,
  };
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

async function insertEvent({
  supabaseUrl,
  serviceRole,
  bookingId,
  actorUserId,
  eventType,
  metadata,
}) {
  const r = await sbFetchJson(`${supabaseUrl}/rest/v1/booking_events`, {
    method: "POST",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify([
      {
        booking_id: bookingId,
        actor_user_id: actorUserId || null,
        event_type: eventType,
        metadata: metadata || null,
      },
    ]),
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

function normalizeE164US(phoneRaw) {
  const p = String(phoneRaw || "").trim();
  if (!p) return "";

  if (p.startsWith("+")) return p;

  const digits = p.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return p;
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function fmtDateLocal(value) {
  if (!value) return "";

  return new Date(value).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

function fmtTimeLocal(value) {
  if (!value) return "";

  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

function appointmentWindowText(booking) {
  if (!booking?.window_start || !booking?.window_end) return "";

  return `${fmtDateLocal(booking.window_start)} • ${fmtTimeLocal(booking.window_start)}–${fmtTimeLocal(booking.window_end)}`;
}

async function sendSmsTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !from || !to) {
    return {
      skipped: true,
      reason: "Twilio env vars or phone missing",
    };
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

function finalReceiptMath({ booking, billing }) {
  const baseFeeCents = Number(booking?.base_fee_cents || 8000);

  const originalFullServiceCents = Number(booking?.full_service_cents || 0);
  const addedFullServiceCents = Number(billing?.add_full_service_cents || 0);
  const fullServiceCents = originalFullServiceCents + addedFullServiceCents;

  const partsCostCents = Number(billing?.parts_cost_cents || 0);

  const totalJobCents =
    Number(billing?.total_job_cents || 0) ||
    baseFeeCents + fullServiceCents + partsCostCents;

  const amountAlreadyCollectedCents =
    Number(billing?.amount_already_collected_cents || 0) ||
    baseFeeCents + originalFullServiceCents;

  const totalPaidCents =
    String(billing?.payment_status || "").toLowerCase() === "paid"
      ? Math.max(Number(booking?.collected_cents || 0), totalJobCents)
      : Math.max(Number(booking?.collected_cents || 0), amountAlreadyCollectedCents);

  const paidAfterServiceCents = Math.max(0, totalPaidCents - amountAlreadyCollectedCents);
  const remainingBalanceCents = Math.max(0, totalJobCents - totalPaidCents);

  return {
    baseFeeCents,
    originalFullServiceCents,
    addedFullServiceCents,
    fullServiceCents,
    partsCostCents,
    totalJobCents,
    amountAlreadyCollectedCents,
    paidAfterServiceCents,
    totalPaidCents,
    remainingBalanceCents,
  };
}

function buildFinalReceiptHtml({ request, booking, billing }) {
  const m = finalReceiptMath({ booking, billing });

  const jobRef = booking?.job_ref || "";
  const windowText = appointmentWindowText(booking);

  const serviceSummary =
    billing?.tech_notes ||
    booking?.tech_notes ||
    "The dryer was diagnosed and serviced based on the findings.";

  const itemRows = [];

  itemRows.push(`
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Dryer repair visit — diagnostic and labor</td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;">${money(m.baseFeeCents)}</td>
    </tr>
  `);

  if (m.originalFullServiceCents > 0) {
    itemRows.push(`
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Full Service add-on — selected at booking</td>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;">${money(m.originalFullServiceCents)}</td>
      </tr>
    `);
  }

  if (m.addedFullServiceCents > 0) {
    itemRows.push(`
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Full Service add-on — added during visit</td>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;">${money(m.addedFullServiceCents)}</td>
      </tr>
    `);
  }

  if (m.partsCostCents > 0) {
    itemRows.push(`
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Parts used for repair</td>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;">${money(m.partsCostCents)}</td>
      </tr>
    `);
  } else {
    itemRows.push(`
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Parts</td>
        <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;">$0.00</td>
      </tr>
    `);
  }

  const helpUrl = `https://www.dryerdudes.com/job-help.html?job_ref=${encodeURIComponent(jobRef)}`;

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:680px;margin:0 auto;">
      <h2 style="margin:0 0 12px;">Dryer Dudes final receipt</h2>

      <p>Hi ${escHtml(request?.name || "there")},</p>

      <p>Job <strong>${escHtml(jobRef)}</strong> has been marked complete. Here is your final service summary and receipt.</p>

      ${windowText ? `<p><strong>Appointment:</strong><br>${escHtml(windowText)}</p>` : ""}

      <p><strong>Service address:</strong><br>${escHtml(request?.address || "")}</p>

      <div style="padding:12px;border:1px solid #ddd;border-radius:10px;background:#fafafa;margin:14px 0;">
        <strong>Service summary / diagnosis:</strong><br>
        ${escHtml(serviceSummary)}
      </div>

      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 0;border-bottom:2px solid #111;">Item</th>
            <th style="text-align:right;padding:8px 0;border-bottom:2px solid #111;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows.join("")}

          <tr>
            <td style="padding:10px 0;border-top:2px solid #111;"><strong>Total job amount</strong></td>
            <td style="padding:10px 0;border-top:2px solid #111;text-align:right;"><strong>${money(m.totalJobCents)}</strong></td>
          </tr>

          <tr>
            <td style="padding:6px 0;">Paid at booking</td>
            <td style="padding:6px 0;text-align:right;">${money(m.amountAlreadyCollectedCents)}</td>
          </tr>

          <tr>
            <td style="padding:6px 0;">Paid after service</td>
            <td style="padding:6px 0;text-align:right;">${money(m.paidAfterServiceCents)}</td>
          </tr>

          <tr>
            <td style="padding:10px 0;border-top:1px solid #ddd;"><strong>Total paid</strong></td>
            <td style="padding:10px 0;border-top:1px solid #ddd;text-align:right;"><strong>${money(m.totalPaidCents)}</strong></td>
          </tr>

          <tr>
            <td style="padding:6px 0;"><strong>Remaining balance</strong></td>
            <td style="padding:6px 0;text-align:right;"><strong>${money(m.remainingBalanceCents)}</strong></td>
          </tr>
        </tbody>
      </table>

      <p><strong>Payment status:</strong> ${m.remainingBalanceCents === 0 ? "Paid" : "Balance due"}</p>

      <div style="padding:12px;border:1px solid #ddd;border-radius:10px;background:#fafafa;margin:14px 0;">
        <strong>1-year limited repair warranty:</strong><br>
        Dryer Dudes provides a 1-year limited repair warranty on the same repaired issue.
        If a covered issue returns within 1 year, Dryer Dudes may, at its discretion, redo the covered repair, replace a covered part, or refund the amount paid for the original covered repair. A refund resolves and ends that warranty claim.
        New or unrelated issues are treated as a new service visit.
      </div>

      <p>If you need help with this job, use Appointment Help with your job number:<br>
        <a href="${helpUrl}">Appointment Help</a>
      </p>

      <p><strong>— Dryer Dudes</strong></p>
    </div>
  `;
}

async function sendFinalReceipt({ request, booking, billing }) {
  const m = finalReceiptMath({ booking, billing });
  const jobRef = booking?.job_ref || "";

  const smsBody =
    `Dryer Dudes: job ${jobRef} is complete.\n` +
    `Total paid: ${money(m.totalPaidCents)}\n` +
    `Your final receipt and service summary were sent by email.\n` +
    `Reply STOP to opt out.`;

  const html = buildFinalReceiptHtml({
    request,
    booking,
    billing,
  });

  let smsResult = { skipped: true };
  let emailResult = { skipped: true };

  try {
    smsResult = request?.phone
      ? await sendSmsTwilio({
          to: request.phone,
          body: smsBody,
        })
      : {
          skipped: true,
          reason: "no phone",
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
          subject: `Dryer Dudes final receipt — ${jobRef || "job"}`,
          html,
        })
      : {
          skipped: true,
          reason: "no email",
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
    receipt: {
      job_ref: jobRef,
      ...m,
    },
  };
}

function looksLikeMissingReviewColumnError(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  return (
    msg.includes("review_request_due_at") ||
    msg.includes("review_request_sent_at") ||
    msg.includes("review_request_status") ||
    msg.includes("review_request_error") ||
    msg.includes("could not find") && msg.includes("review_request")
  );
}

async function patchBookingCompletedWithReviewFallback({
  supabaseUrl,
  serviceRole,
  bookingId,
  completedAtIso,
  sendReview,
  reviewDueAtIso,
}) {
  try {
    const updated = await patchRows({
      supabaseUrl,
      serviceRole,
      table: "bookings",
      filters: { id: bookingId },
      patch: {
        status: "completed",
        completed_at: completedAtIso,

        review_requested_at: sendReview ? completedAtIso : null,
        review_request_due_at: reviewDueAtIso,
        review_request_sent_at: null,
        review_request_status: sendReview ? "queued" : "not_requested",
        review_request_error: null,
      },
    });

    return {
      updated,
      reviewQueueAvailable: true,
    };
  } catch (err) {
    if (!looksLikeMissingReviewColumnError(err)) {
      throw err;
    }

    try {
      const updated = await patchRows({
        supabaseUrl,
        serviceRole,
        table: "bookings",
        filters: { id: bookingId },
        patch: {
          status: "completed",
          completed_at: completedAtIso,
          review_requested_at: sendReview ? completedAtIso : null,
        },
      });

      return {
        updated,
        reviewQueueAvailable: false,
        fallbackReason: "Review queue columns are missing. Completion succeeded without queued review automation.",
      };
    } catch (fallbackErr) {
      const updated = await patchRows({
        supabaseUrl,
        serviceRole,
        table: "bookings",
        filters: { id: bookingId },
        patch: {
          status: "completed",
          completed_at: completedAtIso,
        },
      });

      return {
        updated,
        reviewQueueAvailable: false,
        fallbackReason: "Review queue columns and review_requested_at are missing. Completion succeeded without review fields.",
      };
    }
  }
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
        error: "Only techs can complete bookings.",
      });
    }

    const bookingId = String(req.body?.booking_id || "").trim();
    const sendReview =
      req.body?.send_review === true ||
      req.body?.send_review === "true";

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
      select:
        "id,request_id,assigned_tech_id,status,job_ref,property_manager_id,request_source,paid_by_property_manager,base_fee_cents,full_service_cents,collected_cents,payment_status,window_start,window_end,tech_notes",
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

    if (
      String(billing.status || "").toLowerCase() === "pm_approval_needed" ||
      String(billing.pm_approval_status || "").toLowerCase() === "pending"
    ) {
      return res.status(400).json({
        ok: false,
        error: "This job is waiting on property manager approval.",
      });
    }

    if (
      String(billing.status || "").toLowerCase() === "parts_on_order" ||
      String(booking.status || "").toLowerCase() === "parts_on_order"
    ) {
      return res.status(400).json({
        ok: false,
        error: "This job has parts on order and cannot be completed yet.",
      });
    }

    const publicCustomerOwesMoney =
      !booking.property_manager_id &&
      !booking.paid_by_property_manager &&
      Number(billing.remaining_due_cents || 0) > 0 &&
      String(billing.payment_status || "").toLowerCase() !== "paid";

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

    const completedAtIso = new Date().toISOString();

    const reviewDueAtIso = sendReview
      ? new Date(Date.now() + 10 * 60 * 1000).toISOString()
      : null;

    const bookingPatchResult = await patchBookingCompletedWithReviewFallback({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingId: booking.id,
      completedAtIso,
      sendReview,
      reviewDueAtIso,
    });

    const updated = bookingPatchResult.updated;

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_billing",
      filters: { booking_id: booking.id },
      patch: {
        status: "completed",
        updated_at: completedAtIso,
      },
    });

    const completedBookingForReceipt = {
      ...booking,
      ...updated,
      status: "completed",
      completed_at: completedAtIso,
    };

    let finalReceiptResult = { skipped: true };

    if (request) {
      finalReceiptResult = await sendFinalReceipt({
        request,
        booking: completedBookingForReceipt,
        billing,
      });
    }

    const reviewResult = sendReview
      ? bookingPatchResult.reviewQueueAvailable
        ? {
            queued: true,
            due_at: reviewDueAtIso,
            message: "Review request queued for delayed send.",
          }
        : {
            queued: false,
            due_at: null,
            warning: bookingPatchResult.fallbackReason || "Review queue columns are missing.",
          }
      : {
          skipped: true,
          reason: "Tech chose not to send a review request.",
        };

    await insertEvent({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingId: booking.id,
      actorUserId: user.id,
      eventType: "completed",
      metadata: {
        send_review: sendReview,
        finalReceiptResult,
        reviewResult,
      },
    });

    return res.status(200).json({
      ok: true,
      booking: updated,
      finalReceiptResult,
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
