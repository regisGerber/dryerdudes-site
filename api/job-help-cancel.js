import Stripe from "stripe";

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

function hoursUntil(value) {
  if (!value) return null;
  return (new Date(value).getTime() - Date.now()) / 36e5;
}

async function getBookingByJobRef({ supabaseUrl, serviceRole, jobRef }) {
  const url = new URL(`${supabaseUrl}/rest/v1/bookings`);
  url.searchParams.set(
    "select",
    [
      "id",
      "request_id",
      "selected_option_id",
      "slot_id",
      "job_ref",
      "status",
      "slot_code",
      "window_start",
      "window_end",
      "payment_status",
      "collected_cents",
      "stripe_payment_intent_id",
      "stripe_refund_id",
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

async function insertHelpRequest({ supabaseUrl, serviceRole, booking, request, topic, question }) {
  const r = await sbFetchJson(`${supabaseUrl}/rest/v1/job_help_requests`, {
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
        customer_name: request.name || null,
        topic,
        question,
        predicted_answer_key: topic,
        status: "new",
      },
    ]),
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
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";

    const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

    const jobRef = normalizeJobRef(req.body?.job_ref);
    const email = normalizeEmail(req.body?.email);
    const reason = String(req.body?.reason || "").trim();

    const confirmNoRefund = req.body?.confirm_no_refund === true;
    const typedConfirm = String(req.body?.typed_confirm || "").trim().toUpperCase();

    if (!jobRef || !email) {
      return res.status(400).json({
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

    const activeStatus = !["completed", "cancelled", "canceled", "no_show"].includes(
      String(booking.status || "").toLowerCase()
    );

    if (!activeStatus) {
      return res.status(400).json({
        ok: false,
        error: "This appointment is no longer active.",
      });
    }

    const isPmJob =
      String(booking.request_source || "").toLowerCase() === "property_manager" ||
      !!booking.property_manager_id ||
      String(request.request_source || "").toLowerCase() === "property_manager" ||
      !!request.property_manager_id;

    if (isPmJob) {
      await insertHelpRequest({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        booking,
        request,
        topic: "cancel",
        question:
          reason ||
          "Tenant requested cancellation online. This is a property manager job and needs admin/property manager review.",
      });

      return res.status(200).json({
        ok: true,
        requires_admin: true,
        message: "This job was created through a property manager. Your cancellation request was sent for review and Dryer Dudes will respond by email.",
      });
    }

    const hrs = hoursUntil(booking.window_start);
    const outside48 = hrs != null && hrs > 48;

    if (!outside48) {
      if (!confirmNoRefund || typedConfirm !== "CANCEL") {
        return res.status(400).json({
          ok: false,
          error: "Final no-refund cancellation confirmation is required.",
        });
      }
    }

    let refundResult = {
      refund_eligible: outside48,
      refund_issued: false,
      refund_id: null,
      refund_status: outside48 ? "not_needed" : "not_eligible_within_48_hours",
    };

    if (outside48 && Number(booking.collected_cents || 0) > 0) {
      if (booking.stripe_refund_id) {
        refundResult = {
          refund_eligible: true,
          refund_issued: true,
          refund_id: booking.stripe_refund_id,
          refund_status: "already_refunded",
        };
      } else if (booking.stripe_payment_intent_id && stripe) {
        const refund = await stripe.refunds.create({
          payment_intent: booking.stripe_payment_intent_id,
        });

        refundResult = {
          refund_eligible: true,
          refund_issued: true,
          refund_id: refund.id,
          refund_status: refund.status || "created",
        };
      } else {
        refundResult = {
          refund_eligible: true,
          refund_issued: false,
          refund_id: null,
          refund_status: "missing_payment_intent",
        };
      }
    }

    const cancelledSlotCode = booking.slot_code
      ? `${booking.slot_code}-CANCELLED-${Date.now()}`
      : `CANCELLED-${booking.job_ref}-${Date.now()}`;

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: booking.id },
      patch: {
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason || (outside48 ? "Customer cancelled online." : "Customer cancelled online within 48 hours. No refund."),
        refund_status: refundResult.refund_status,
        stripe_refund_id: refundResult.refund_id,
        slot_code: cancelledSlotCode,
      },
    });

    if (booking.slot_id) {
      await patchRows({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "schedule_slots",
        filters: { id: booking.slot_id },
        patch: {
          is_booked: false,
          booking_id: null,
          booked_at: null,
        },
      });
    }

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: request.id },
      patch: {
        status: "cancelled",
      },
    });

    await insertCustomerAction({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      booking,
      request,
      actionType: "cancelled",
      metadata: {
        outside_48_hours: outside48,
        hours_until_window: hrs,
        reason,
        refund: refundResult,
      },
    });

    if (refundResult.refund_issued) {
      await insertCustomerAction({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        booking,
        request,
        actionType: "refund_issued",
        metadata: refundResult,
      });
    }

    const emailResult = await sendEmailResend({
      to: request.email,
      subject: `Appointment cancelled — ${booking.job_ref}`,
      html:
        `<p>Hi ${escHtml(request.name || "there")},</p>` +
        `<p>Your Dryer Dudes appointment <strong>${escHtml(booking.job_ref)}</strong> has been cancelled.</p>` +
        `<p>${
          refundResult.refund_issued
            ? "A refund was issued back to the original payment method."
            : outside48
              ? "This appointment did not have a refundable online payment available."
              : "This cancellation was within 48 hours and is non-refundable."
        }</p>` +
        `<p>— Dryer Dudes</p>`,
    });

    return res.status(200).json({
      ok: true,
      cancelled: true,
      refund: refundResult,
      emailResult,
      message: refundResult.refund_issued
        ? "Appointment cancelled and refund issued."
        : outside48
          ? "Appointment cancelled."
          : "Appointment cancelled. This cancellation is non-refundable because it was within 48 hours.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
