const Stripe = require("stripe");
const crypto = require("crypto");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
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

function esc(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

function isTruthy(v) {
  return (
    v === true ||
    v === "true" ||
    v === "1" ||
    v === 1 ||
    v === "yes" ||
    v === "on"
  );
}

function fmtDateMDY(iso) {
  const s = String(iso || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function fmtTime12h(t) {
  if (!t) return "";

  const raw = String(t).slice(0, 5);
  const m = raw.match(/^(\d{2}):(\d{2})$/);

  if (!m) return raw;

  let hh = Number(m[1]);
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";

  hh = hh % 12;
  if (hh === 0) hh = 12;

  return `${hh}:${mm} ${ampm}`;
}

function dollars(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
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

function makeReturnVisitToken() {
  return `rv_${crypto.randomUUID()}_${crypto.randomBytes(12).toString("hex")}`;
}

function buildReturnVisitUrl(origin, token) {
  if (!token) return "";
  return `${String(origin || "").replace(/\/+$/, "")}/return-visit.html?t=${encodeURIComponent(token)}`;
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

async function sendResendEmail({ to, subject, html }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY || !to) {
    return {
      skipped: true,
      reason: "Missing RESEND_API_KEY or recipient",
    };
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
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

  if (!r.ok) {
    console.error("Booking event insert failed", r.status, r.text);
  }

  return r.data;
}

async function getBookingRequest({ supabaseUrl, serviceRole, requestId }) {
  if (!requestId) return null;

  const url =
    `${supabaseUrl}/rest/v1/booking_requests` +
    `?id=eq.${encodeURIComponent(requestId)}` +
    `&select=id,name,phone,email,address,contact_method` +
    `&limit=1`;

  const r = await sbFetchJson(url, {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    console.error("Could not fetch booking request", r.status, r.text);
    return null;
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

function shouldTextRequest(requestRow, metadata) {
  const cm = String(requestRow?.contact_method || metadata?.contact_method || "").toLowerCase();
  return cm === "text" || cm === "both";
}

async function sendBookingSmsViaApi({
  origin,
  requestRow,
  resultRow,
  finalJobRef,
  metadata,
}) {
  const toPhone =
    requestRow?.phone ||
    metadata?.customer_phone ||
    metadata?.phone ||
    "";

  if (!toPhone) {
    return {
      skipped: true,
      reason: "No phone on request.",
    };
  }

  if (!shouldTextRequest(requestRow, metadata)) {
    return {
      skipped: true,
      reason: "Customer did not choose text/both.",
    };
  }

  const payload = {
    toPhone,
    customerName:
      requestRow?.name ||
      metadata?.customer_name ||
      metadata?.name ||
      "there",
    serviceDate: resultRow.service_date,
    arrivalStart: fmtTime12h(resultRow.start_time),
    arrivalEnd: fmtTime12h(resultRow.end_time),
    addressLine:
      requestRow?.address ||
      metadata?.service_address ||
      metadata?.address ||
      "",
    jobRef: finalJobRef,
  };

  const resp = await fetch(`${origin}/api/send-booking-sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || !data.ok) {
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

async function sendBookingFailureCustomerEmail({
  customerEmail,
  customerName,
  jobRef,
  stripeSessionId,
  refundResult,
  origin,
}) {
  const helpUrl =
    `${origin}/job-help.html` +
    (jobRef ? `?job_ref=${encodeURIComponent(jobRef)}` : "");

  const refundLine = refundResult?.issued
    ? "A refund has been started back to the original payment method."
    : refundResult?.alreadyRefunded
      ? "A refund was already started for this payment."
      : "We attempted to start a refund, but it may need manual review. Dryer Dudes has been alerted.";

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color:#111;">
      <h2 style="margin:0 0 12px 0;">Appointment not confirmed</h2>
      <p>Hi ${esc(customerName || "there")},</p>
      <p>Your Dryer Dudes payment was received, but our system could not confirm the appointment in the schedule.</p>
      <p><strong>${esc(refundLine)}</strong></p>
      ${jobRef ? `<p><strong>Job number shown during checkout:</strong> ${esc(jobRef)}</p>` : ""}
      <p>Please do not book the same appointment again until the refund is complete or you receive a clear confirmation from Dryer Dudes.</p>
      <p>If you need help, use Appointment Help:<br><a href="${esc(helpUrl)}">${esc(helpUrl)}</a></p>
      <p style="font-size: 0.9em; color:#555;">Stripe session: ${esc(stripeSessionId || "")}</p>
      <p><strong>— Dryer Dudes</strong></p>
    </div>
  `;

  return sendResendEmail({
    to: customerEmail,
    subject: `Payment refund started — appointment not confirmed${jobRef ? ` (${jobRef})` : ""}`,
    html,
  });
}

async function sendInternalFailureAlert({
  customerEmail,
  customerName,
  jobRef,
  stripeSessionId,
  paymentIntent,
  finalizeText,
  refundResult,
}) {
  const to = process.env.ADMIN_ALERT_EMAIL || "info@dryerdudes.com";

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color:#111;">
      <h2>Booking finalization failed</h2>
      <p><strong>Customer:</strong> ${esc(customerName || "")}</p>
      <p><strong>Email:</strong> ${esc(customerEmail || "")}</p>
      <p><strong>Job ref:</strong> ${esc(jobRef || "")}</p>
      <p><strong>Stripe session:</strong> ${esc(stripeSessionId || "")}</p>
      <p><strong>Payment intent:</strong> ${esc(paymentIntent || "")}</p>
      <p><strong>Refund result:</strong></p>
      <pre style="white-space:pre-wrap;background:#f4f4f4;padding:10px;border-radius:8px;">${esc(JSON.stringify(refundResult || {}, null, 2))}</pre>
      <p><strong>Finalize error:</strong></p>
      <pre style="white-space:pre-wrap;background:#f4f4f4;padding:10px;border-radius:8px;">${esc(finalizeText || "")}</pre>
    </div>
  `;

  return sendResendEmail({
    to,
    subject: `ALERT: Booking finalization failed${jobRef ? ` (${jobRef})` : ""}`,
    html,
  });
}

async function recordBookingFailureEvent({
  supabaseUrl,
  serviceRole,
  jobRef,
  customerEmail,
  customerName,
  stripeSessionId,
  paymentIntent,
  amountCents,
  finalizeText,
  refundResult,
  metadata,
}) {
  try {
    await sbFetchJson(`${supabaseUrl}/rest/v1/booking_failure_events`, {
      method: "POST",
      headers: {
        ...sbHeaders(serviceRole),
        Prefer: "return=representation",
      },
      body: JSON.stringify([{
        job_ref: jobRef || null,
        customer_email: customerEmail || null,
        customer_name: customerName || null,
        stripe_checkout_session_id: stripeSessionId || null,
        stripe_payment_intent_id: paymentIntent || null,
        amount_cents: amountCents || 0,

        refund_attempted: !!refundResult?.attempted,
        refund_issued: !!refundResult?.issued,
        refund_id: refundResult?.refundId || null,
        refund_error: refundResult?.error || null,

        finalize_error: finalizeText || null,
        raw: {
          metadata,
          refund: refundResult,
        },
        status: "new",
      }]),
    });
  } catch (eventErr) {
    console.error("Could not record booking failure event", eventErr);
  }
}

async function getSavedPaymentMethodSnapshot({ stripe, paymentIntentId }) {
  if (!paymentIntentId) {
    return {
      stripe_customer_id: null,
      stripe_payment_method_id: null,
      saved_payment_method_brand: null,
      saved_payment_method_last4: null,
      saved_payment_method_exp_month: null,
      saved_payment_method_exp_year: null,
    };
  }

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["payment_method"],
  });

  const paymentMethod = pi.payment_method || null;

  const customerId =
    typeof pi.customer === "string"
      ? pi.customer
      : pi.customer?.id || null;

  if (!paymentMethod || typeof paymentMethod === "string") {
    return {
      stripe_customer_id: customerId,
      stripe_payment_method_id: typeof paymentMethod === "string" ? paymentMethod : null,
      saved_payment_method_brand: null,
      saved_payment_method_last4: null,
      saved_payment_method_exp_month: null,
      saved_payment_method_exp_year: null,
    };
  }

  const card = paymentMethod.card || {};

  return {
    stripe_customer_id: customerId,
    stripe_payment_method_id: paymentMethod.id || null,
    saved_payment_method_brand: card.brand || null,
    saved_payment_method_last4: card.last4 || null,
    saved_payment_method_exp_month: card.exp_month || null,
    saved_payment_method_exp_year: card.exp_year || null,
  };
}

async function saveCardOnFileToBooking({
  supabaseUrl,
  serviceRole,
  bookingId,
  cardSnapshot,
  isAuthorizedEntry,
}) {
  if (!bookingId || !cardSnapshot) {
    return {
      skipped: true,
      reason: "Missing bookingId or cardSnapshot",
    };
  }

  const url = new URL(`${supabaseUrl}/rest/v1/bookings`);
  url.searchParams.set("id", `eq.${bookingId}`);

  const hasPaymentMethod = !!cardSnapshot.stripe_payment_method_id;

  const patch = {
    stripe_customer_id: cardSnapshot.stripe_customer_id || null,
    stripe_payment_method_id: cardSnapshot.stripe_payment_method_id || null,
    saved_payment_method_brand: cardSnapshot.saved_payment_method_brand || null,
    saved_payment_method_last4: cardSnapshot.saved_payment_method_last4 || null,
    saved_payment_method_exp_month: cardSnapshot.saved_payment_method_exp_month || null,
    saved_payment_method_exp_year: cardSnapshot.saved_payment_method_exp_year || null,

    card_on_file_status: hasPaymentMethod ? "saved" : "not_saved",
    card_on_file_saved_at: hasPaymentMethod ? new Date().toISOString() : null,
    card_use_authorized: hasPaymentMethod,

    authorized_entry_parts_limit_cents: isAuthorizedEntry ? 7500 : 0,
    authorized_entry_parts_preapproval_status: isAuthorizedEntry ? "active" : "not_applicable",
  };

  const r = await sbFetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: r.text,
    };
  }

  return {
    ok: true,
    booking: Array.isArray(r.data) ? r.data[0] || null : null,
  };
}

function buildBalancePaymentNoticeHtml({
  request,
  booking,
  billing,
  paidNowCents,
  totalPaidCents,
  paymentIntent,
  isPartsOnOrder,
  partDeliveryDestination,
  returnVisitUrl,
}) {
  const jobRef = booking.job_ref || billing?.job_ref || "";
  const partsCostCents = Number(billing?.parts_cost_cents || 0);
  const addFullServiceCents = Number(billing?.add_full_service_cents || 0);

  const partsLine =
    partsCostCents > 0
      ? `<li><strong>Parts:</strong> ${dollars(partsCostCents)}</li>`
      : "";

  const fullServiceLine =
    addFullServiceCents > 0
      ? `<li><strong>Full Service add-on:</strong> ${dollars(addFullServiceCents)}</li>`
      : "";

  if (isPartsOnOrder) {
    return `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:680px;margin:0 auto;">
        <h2 style="margin:0 0 12px;">Parts payment received</h2>

        <p>Hi ${esc(request?.name || "there")},</p>

        <p>Your parts payment for job <strong>${esc(jobRef)}</strong> was received.</p>

        ${billing?.tech_notes ? `<p>${esc(billing.tech_notes)}</p>` : ""}

        <p>
          <strong>Good news:</strong> your original repair visit already covers the return visit and installation for this ordered part.
          You do not need to pay another service visit charge for the return visit.
        </p>

        <ul>
          ${partsLine}
          ${fullServiceLine}
          <li><strong>Paid now:</strong> ${dollars(paidNowCents)}</li>
        </ul>

        ${
          partDeliveryDestination === "customer" && returnVisitUrl
            ? `
              <p>The part is being sent to your home.</p>
              <p><strong>Do not schedule the return visit until the part has arrived at your home.</strong></p>
              <p>When the part arrives, use this link to schedule your return visit:<br>
                <a href="${esc(returnVisitUrl)}">Schedule return visit after part arrives</a>
              </p>
            `
            : `<p>Dryer Dudes will order the part. Once the part is ready, we will follow up about the return visit.</p>`
        }

        <p><strong>This is not the final receipt.</strong> Your final receipt and service summary will be sent after the repair is completed.</p>

        ${paymentIntent ? `<p style="font-size:12px;color:#555;">Payment intent: ${esc(paymentIntent)}</p>` : ""}

        <p>— Dryer Dudes</p>
      </div>
    `;
  }

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:680px;margin:0 auto;">
      <h2 style="margin:0 0 12px;">Payment received</h2>

      <p>Hi ${esc(request?.name || "there")},</p>

      <p>Your payment for job <strong>${esc(jobRef)}</strong> was received.</p>

      ${billing?.tech_notes ? `<p>${esc(billing.tech_notes)}</p>` : ""}

      <ul>
        ${partsLine}
        ${fullServiceLine}
        <li><strong>Paid now:</strong> ${dollars(paidNowCents)}</li>
        <li><strong>Total paid so far:</strong> ${dollars(totalPaidCents)}</li>
      </ul>

      <p><strong>This is not the final receipt.</strong> Your final receipt and service summary will be sent after the technician marks the job complete.</p>

      ${paymentIntent ? `<p style="font-size:12px;color:#555;">Payment intent: ${esc(paymentIntent)}</p>` : ""}

      <p>— Dryer Dudes</p>
    </div>
  `;
}

function buildBalancePaymentNoticeSms({
  booking,
  paidNowCents,
  isPartsOnOrder,
  partDeliveryDestination,
  returnVisitUrl,
}) {
  const jobRef = booking.job_ref || "your Dryer Dudes job";

  if (isPartsOnOrder) {
    return (
      `Dryer Dudes: parts payment received for job ${jobRef}.\n` +
      `Paid now: ${dollars(paidNowCents)}\n\n` +
      `Your original repair visit covers the return visit and installation for this ordered part.` +
      (
        partDeliveryDestination === "customer" && returnVisitUrl
          ? `\n\nThe part is being sent to your home. Do not schedule until the part has arrived.\n${returnVisitUrl}`
          : ""
      ) +
      `\n\nReply STOP to opt out.`
    );
  }

  return (
    `Dryer Dudes: payment received for job ${jobRef}.\n` +
    `Paid now: ${dollars(paidNowCents)}\n` +
    `Your final receipt will be sent after the job is marked complete.\n` +
    `Reply STOP to opt out.`
  );
}

async function sendBalancePaymentNotice({
  request,
  booking,
  billing,
  paidNowCents,
  totalPaidCents,
  paymentIntent,
  isPartsOnOrder,
  partDeliveryDestination,
  returnVisitUrl,
}) {
  const email = request?.email || null;
  const phone = request?.phone || null;

  const html = buildBalancePaymentNoticeHtml({
    request,
    booking,
    billing,
    paidNowCents,
    totalPaidCents,
    paymentIntent,
    isPartsOnOrder,
    partDeliveryDestination,
    returnVisitUrl,
  });

  const smsBody = buildBalancePaymentNoticeSms({
    booking,
    paidNowCents,
    isPartsOnOrder,
    partDeliveryDestination,
    returnVisitUrl,
  });

  let emailResult = { skipped: true };
  let smsResult = { skipped: true };

  try {
    emailResult = email
      ? await sendResendEmail({
          to: String(email).trim(),
          subject: isPartsOnOrder
            ? `Dryer Dudes parts payment received — ${booking.job_ref || "job"}`
            : `Dryer Dudes payment received — ${booking.job_ref || "job"}`,
          html,
        })
      : { skipped: true, reason: "No customer email found" };
  } catch (emailErr) {
    emailResult = {
      ok: false,
      error: emailErr?.message || String(emailErr),
    };
  }

  try {
    smsResult = phone
      ? await sendSmsTwilio({
          to: phone,
          body: smsBody,
        })
      : { skipped: true, reason: "No customer phone found" };
  } catch (smsErr) {
    smsResult = {
      ok: false,
      error: smsErr?.message || String(smsErr),
    };
  }

  return {
    emailResult,
    smsResult,
  };
}

async function patchBillingPaidWithFallback({
  supabaseUrl,
  serviceRole,
  bookingId,
  patch,
}) {
  try {
    return await patchRows({
      supabaseUrl,
      serviceRole,
      table: "booking_billing",
      filters: { booking_id: bookingId },
      patch,
    });
  } catch (err) {
    const safePatch = { ...patch };

    delete safePatch.paid_at;
    delete safePatch.payment_url;

    return patchRows({
      supabaseUrl,
      serviceRole,
      table: "booking_billing",
      filters: { booking_id: bookingId },
      patch: safePatch,
    });
  }
}

async function handleTechBalancePayment({
  session,
  metadata,
  origin,
  supabaseUrl,
  serviceRole,
}) {
  const bookingId = String(metadata.booking_id || "").trim();
  const jobRef = String(metadata.job_ref || "").trim();

  const stripePaymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id || null;

  const paidNowCents =
    typeof session.amount_total === "number"
      ? session.amount_total
      : 0;

  if (!bookingId) {
    console.error("tech_balance payment missing booking_id", metadata);

    return {
      received: true,
      handled: false,
      reason: "missing_booking_id",
    };
  }

  const booking = await getSingle({
    supabaseUrl,
    serviceRole,
    table: "bookings",
    filters: { id: bookingId },
    select: "id,request_id,job_ref,status,payment_status,collected_cents,base_fee_cents,full_service_cents",
  });

  if (!booking) {
    console.error("tech_balance booking not found", bookingId);

    return {
      received: true,
      handled: false,
      reason: "booking_not_found",
    };
  }

  const request = await getSingle({
    supabaseUrl,
    serviceRole,
    table: "booking_requests",
    filters: { id: booking.request_id },
    select: "id,name,email,phone,address",
  });

  const billing = await getSingle({
    supabaseUrl,
    serviceRole,
    table: "booking_billing",
    filters: { booking_id: booking.id },
    select: "*",
  });

  if (!billing) {
    console.error("tech_balance billing row not found", booking.id);

    return {
      received: true,
      handled: false,
      reason: "billing_not_found",
    };
  }

  if (
    String(billing.payment_status || "").toLowerCase() === "paid" &&
    String(billing.stripe_checkout_session_id || "") === String(session.id)
  ) {
    console.log("tech_balance replay detected");

    return {
      received: true,
      handled: true,
      duplicate: true,
    };
  }

  const previousPaidCents = Number(booking.collected_cents || 0);
  const totalPaidCents = previousPaidCents + paidNowCents;

  const partStatusLower = String(billing.part_status || "").toLowerCase();
  const billingStatusLower = String(billing.status || "").toLowerCase();
  const bookingStatusLower = String(booking.status || "").toLowerCase();

  const isPartsOnOrder =
    billingStatusLower === "parts_on_order" ||
    isTruthy(billing.parts_on_order) ||
    bookingStatusLower === "parts_on_order" ||
    ["awaiting_payment", "tech_receiving", "customer_receiving"].includes(partStatusLower);

  const partDeliveryDestination =
    String(billing.part_delivery_destination || "").toLowerCase() === "customer"
      ? "customer"
      : "tech";

  const partStatusAfterPayment =
    !isPartsOnOrder
      ? (billing.part_status || "not_needed")
      : partDeliveryDestination === "customer"
        ? "customer_receiving"
        : "tech_receiving";

  const returnVisitToken =
    isPartsOnOrder && partDeliveryDestination === "customer"
      ? (
          billing.return_visit_token ||
          makeReturnVisitToken()
        )
      : null;

  const returnVisitUrl =
    returnVisitToken
      ? buildReturnVisitUrl(origin, returnVisitToken)
      : "";

  const nowIso = new Date().toISOString();

  const billingStatusAfterPayment = isPartsOnOrder ? "parts_on_order" : "paid";
  const nextBookingStatus = isPartsOnOrder ? "parts_on_order" : "billing_pending";

  const billingPatch = {
    payment_status: "paid",
    status: billingStatusAfterPayment,
    stripe_checkout_session_id: session.id,
    payment_url: null,
    paid_at: nowIso,
    updated_at: nowIso,
  };

  if (isPartsOnOrder) {
    billingPatch.part_paid_at = billing.part_paid_at || nowIso;
    billingPatch.part_ordered_at = billing.part_ordered_at || nowIso;
    billingPatch.part_status = partStatusAfterPayment;

    if (returnVisitToken) {
      billingPatch.return_visit_token = returnVisitToken;
      billingPatch.return_visit_token_created_at =
        billing.return_visit_token_created_at || nowIso;
    }
  }

  const billingRow = await patchBillingPaidWithFallback({
    supabaseUrl,
    serviceRole,
    bookingId: booking.id,
    patch: billingPatch,
  });

  const updatedBooking = await patchRows({
    supabaseUrl,
    serviceRole,
    table: "bookings",
    filters: { id: booking.id },
    patch: {
      payment_status: "paid",
      collected_cents: totalPaidCents,
      status: nextBookingStatus,
    },
  });

  let noticeResult = { skipped: true };

  try {
    noticeResult = await sendBalancePaymentNotice({
      request,
      booking: {
        ...booking,
        ...updatedBooking,
        collected_cents: totalPaidCents,
      },
      billing: {
        ...billing,
        ...billingRow,
      },
      paidNowCents,
      totalPaidCents,
      paymentIntent: stripePaymentIntent,
      isPartsOnOrder,
      partDeliveryDestination,
      returnVisitUrl,
    });
  } catch (noticeErr) {
    noticeResult = {
      ok: false,
      error: noticeErr?.message || String(noticeErr),
    };

    console.error("Balance payment notice failed", noticeErr);
  }

  await insertEvent({
    supabaseUrl,
    serviceRole,
    bookingId: booking.id,
    eventType: "balance_payment_paid",
    metadata: {
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: stripePaymentIntent,
      amount_paid_cents: paidNowCents,
      previous_collected_cents: previousPaidCents,
      total_collected_cents: totalPaidCents,
      job_ref: booking.job_ref || jobRef,
      is_parts_on_order: isPartsOnOrder,
      part_delivery_destination: partDeliveryDestination,
      return_visit_token_created: !!returnVisitToken,
      final_receipt_deferred_until_complete: true,
      noticeResult,
    },
  });

  return {
    received: true,
    handled: true,
    kind: "tech_balance",
    bookingId: booking.id,
    jobRef: booking.job_ref || jobRef,
    paidNowCents,
    totalPaidCents,
    bookingStatus: nextBookingStatus,
    billingStatus: billingStatusAfterPayment,
    noticeResult,
  };
}

async function refundFailedBookingPayment({ stripe, paymentIntent }) {
  const refundResult = {
    attempted: false,
    issued: false,
    alreadyRefunded: false,
    error: null,
    refundId: null,
  };

  try {
    if (!paymentIntent) return refundResult;

    refundResult.attempted = true;

    const pi = await stripe.paymentIntents.retrieve(
      paymentIntent,
      { expand: ["latest_charge.refunds"] }
    );

    const charge = pi.latest_charge;

    const alreadyRefunded =
      charge &&
      charge.refunds &&
      charge.refunds.data &&
      charge.refunds.data.length > 0;

    if (!alreadyRefunded) {
      const refund = await stripe.refunds.create({
        payment_intent: paymentIntent,
      });

      refundResult.issued = true;
      refundResult.refundId = refund.id || null;

      console.log("Refund issued", refund.id || "");
    } else {
      refundResult.alreadyRefunded = true;
      console.log("Refund already exists");
    }
  } catch (refundErr) {
    refundResult.error = refundErr?.message || String(refundErr);
    console.error("Refund attempt failed", refundErr);
  }

  return refundResult;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");
    const STRIPE_WEBHOOK_SECRET = requireEnv("STRIPE_WEBHOOK_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    });

    const sig = req.headers["stripe-signature"];
    const rawBody = await getRawBody(req);

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed", err);
      return res.status(400).send("Invalid signature");
    }

    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({
        received: true,
      });
    }

    const session = event.data.object;
    const metadata = session.metadata || {};
    const origin = getOrigin(req);

    if (metadata.kind === "tech_balance") {
      const result = await handleTechBalancePayment({
        session,
        metadata,
        origin,
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
      });

      return res.status(200).json(result);
    }

    const offerToken = String(metadata.offer_token || "").trim();
    const jobRef = String(metadata.jobRef || metadata.job_ref || "").trim() || null;
    const appointmentType = String(metadata.appointment_type || "standard").trim();

    const stripePaymentIntent =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null;

    const collectedCents =
      typeof session.amount_total === "number"
        ? session.amount_total
        : 0;

    const customerEmail =
      session.customer_details?.email ||
      session.customer_email ||
      metadata.email ||
      metadata.customer_email ||
      null;

    const customerName =
      session.customer_details?.name ||
      metadata.name ||
      metadata.customer_name ||
      "there";

    if (!offerToken) {
      return res.status(200).json({
        received: true,
        ignored: "missing_offer_token",
      });
    }

    const existingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?stripe_checkout_session_id=eq.${encodeURIComponent(session.id)}` +
      `&select=id&limit=1`;

    const existingResp = await sbFetchJson(existingUrl, {
      headers: sbHeaders(SERVICE_ROLE),
    });

    const existing = Array.isArray(existingResp.data)
      ? existingResp.data[0]
      : null;

    if (existing) {
      console.log("Webhook replay detected");
      return res.status(200).json({
        received: true,
      });
    }

    const finalizeUrl = `${SUPABASE_URL}/rest/v1/rpc/finalize_paid_booking`;

    const finalizeResp = await sbFetchJson(finalizeUrl, {
      method: "POST",
      headers: sbHeaders(SERVICE_ROLE),
      body: JSON.stringify({
        p_offer_token: offerToken,
        p_stripe_checkout_session_id: session.id,
        p_stripe_payment_intent_id: stripePaymentIntent,
        p_collected_cents: collectedCents,
        p_job_ref: jobRef,
        p_appointment_type: appointmentType,
        p_tz_offset: process.env.LOCAL_TZ_OFFSET || "-08:00",
      }),
    });

    if (!finalizeResp.ok) {
      console.error("Booking finalize failed", finalizeResp.text);

      const refundResult = await refundFailedBookingPayment({
        stripe,
        paymentIntent: stripePaymentIntent,
      });

      try {
        if (customerEmail) {
          await sendBookingFailureCustomerEmail({
            customerEmail: String(customerEmail).trim(),
            customerName,
            jobRef,
            stripeSessionId: session.id,
            refundResult,
            origin,
          });
        }
      } catch (customerEmailErr) {
        console.error("Failure customer email failed", customerEmailErr);
      }

      try {
        await sendInternalFailureAlert({
          customerEmail,
          customerName,
          jobRef,
          stripeSessionId: session.id,
          paymentIntent: stripePaymentIntent,
          finalizeText: finalizeResp.text,
          refundResult,
        });
      } catch (alertErr) {
        console.error("Internal failure alert failed", alertErr);
      }

      await recordBookingFailureEvent({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        jobRef,
        customerEmail,
        customerName,
        stripeSessionId: session.id,
        paymentIntent: stripePaymentIntent,
        amountCents: collectedCents,
        finalizeText: finalizeResp.text,
        refundResult,
        metadata,
      });

      return res.status(200).json({
        received: true,
        handled: true,
        bookingFinalized: false,
        refund: refundResult,
      });
    }

    const resultRow = Array.isArray(finalizeResp.data)
      ? finalizeResp.data[0]
      : null;

    const bookingId = resultRow?.booking_id || null;
    const finalJobRef = resultRow?.job_ref || jobRef;

    let cardOnFileResult = {
      skipped: true,
    };

    try {
      const isAuthorizedEntry =
        String(appointmentType || "").toLowerCase() === "no_one_home" ||
        String(metadata.authorized_entry || "").toLowerCase() === "true";

      const cardSnapshot = await getSavedPaymentMethodSnapshot({
        stripe,
        paymentIntentId: stripePaymentIntent,
      });

      cardOnFileResult = await saveCardOnFileToBooking({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        bookingId,
        cardSnapshot,
        isAuthorizedEntry,
      });

      console.log("Card-on-file save result", cardOnFileResult);
    } catch (cardErr) {
      cardOnFileResult = {
        ok: false,
        error: cardErr?.message || String(cardErr),
      };

      console.error("Card-on-file save failed", cardErr);
    }

    let emailResult = {
      skipped: true,
    };

    let smsResult = {
      skipped: true,
    };

    const requestRow = resultRow?.request_id
      ? await getBookingRequest({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          requestId: resultRow.request_id,
        })
      : null;

    const confirmationEmail =
      customerEmail ||
      requestRow?.email ||
      null;

    if (confirmationEmail && resultRow) {
      const payload = {
        customerEmail: String(confirmationEmail).trim(),
        customerName: requestRow?.name || customerName,
        service: "Dryer Repair",
        date: fmtDateMDY(resultRow.service_date),
        timeWindow: `${fmtTime12h(resultRow.start_time)}–${fmtTime12h(resultRow.end_time)}`,
        address:
          requestRow?.address ||
          metadata.address ||
          metadata.service_address ||
          "",
        notes: "",
        jobRef: finalJobRef,
        stripeSessionId: session.id,
      };

      try {
        const emailResp = await fetch(`${origin}/api/send-booking-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        emailResult = await emailResp.json().catch(() => ({
          ok: emailResp.ok,
          status: emailResp.status,
        }));
      } catch (emailErr) {
        emailResult = {
          ok: false,
          error: emailErr?.message || String(emailErr),
        };

        console.error("Email send failed", emailErr);
      }
    }

    if (resultRow) {
      try {
        smsResult = await sendBookingSmsViaApi({
          origin,
          requestRow,
          resultRow,
          finalJobRef,
          metadata,
        });
      } catch (smsErr) {
        smsResult = {
          ok: false,
          error: smsErr?.message || String(smsErr),
        };

        console.error("Booking SMS send failed", smsErr);
      }
    }

    return res.status(200).json({
      received: true,
      bookingId,
      jobRef: finalJobRef,
      cardOnFileResult,
      emailResult,
      smsResult,
    });
  } catch (err) {
    console.error("Stripe webhook fatal error", err);

    return res.status(500).json({
      error: "Webhook failure",
      message: err?.message || String(err),
    });
  }
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
