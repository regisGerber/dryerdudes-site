const Stripe = require("stripe");

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

module.exports.config = { api: { bodyParser: false } };

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

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
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

async function sendResendEmail({ to, subject, html }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY || !to) {
    return {
      skipped: true,
      reason: "Missing RESEND_API_KEY or recipient"
    };
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "Dryer Dudes <scheduling@dryerdudes.com>",
      reply_to: "scheduling@dryerdudes.com",
      to: [to],
      subject,
      html
    })
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
    data
  };
}

async function sendBookingFailureCustomerEmail({
  customerEmail,
  customerName,
  jobRef,
  stripeSessionId,
  refundResult,
  origin
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

      <p>
        If you need help, use Appointment Help:
        <br>
        <a href="${esc(helpUrl)}">${esc(helpUrl)}</a>
      </p>

      <p style="font-size: 0.9em; color:#555;">Stripe session: ${esc(stripeSessionId || "")}</p>

      <p><strong>— Dryer Dudes</strong></p>
    </div>
  `;

  return sendResendEmail({
    to: customerEmail,
    subject: `Payment refund started — appointment not confirmed${jobRef ? ` (${jobRef})` : ""}`,
    html
  });
}

async function sendInternalFailureAlert({
  customerEmail,
  customerName,
  jobRef,
  stripeSessionId,
  paymentIntent,
  finalizeText,
  refundResult
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
    html
  });
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
    console.error("Could not fetch booking request for confirmation SMS", r.status, r.text);
    return null;
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

function shouldTextRequest(requestRow, metadata) {
  const cm = String(requestRow?.contact_method || metadata?.contact_method || "").toLowerCase();

  if (cm === "text" || cm === "both") return true;

  // Safety fallback: if the customer entered a phone in metadata but contact_method was not stored,
  // do NOT automatically text. We only text if they chose text/both.
  return false;
}

async function sendBookingSmsViaApi({
  origin,
  requestRow,
  resultRow,
  finalJobRef,
  metadata
}) {
  const toPhone =
    requestRow?.phone ||
    metadata?.customer_phone ||
    metadata?.phone ||
    "";

  if (!toPhone) {
    return { skipped: true, reason: "No phone on request." };
  }

  if (!shouldTextRequest(requestRow, metadata)) {
    return { skipped: true, reason: "Customer did not choose text/both." };
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
    headers: { "Content-Type": "application/json" },
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

module.exports = async function handler(req, res) {
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
      apiVersion: "2024-06-20"
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
      return res.status(200).json({ received: true });
    }

    const session = event.data.object;
    const metadata = session.metadata || {};
    const origin = getOrigin(req);

    // Tech balance payments are separate from initial appointment booking.
    // Leave those alone for now so we do not break billing.
    if (metadata.kind === "tech_balance") {
      return res.status(200).json({ received: true, ignored: "tech_balance" });
    }

    const offerToken = String(metadata.offer_token || "").trim();
    const jobRef = String(metadata.jobRef || metadata.job_ref || "").trim() || null;
    const appointmentType = String(metadata.appointment_type || "standard").trim();

    const stripePaymentIntent = session.payment_intent || null;

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
      return res.status(200).json({ received: true });
    }

    const existingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?stripe_checkout_session_id=eq.${encodeURIComponent(session.id)}` +
      `&select=id&limit=1`;

    const existingResp = await sbFetchJson(existingUrl, {
      headers: sbHeaders(SERVICE_ROLE)
    });

    const existing = Array.isArray(existingResp.data)
      ? existingResp.data[0]
      : null;

    if (existing) {
      console.log("Webhook replay detected");
      return res.status(200).json({ received: true });
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
        p_tz_offset: process.env.LOCAL_TZ_OFFSET || "-08:00"
      })
    });

    if (!finalizeResp.ok) {
      console.error("Booking finalize failed", finalizeResp.text);

      const refundResult = {
        attempted: false,
        issued: false,
        alreadyRefunded: false,
        error: null,
        refundId: null
      };

      try {
        if (stripePaymentIntent) {
          refundResult.attempted = true;

          const pi = await stripe.paymentIntents.retrieve(
            stripePaymentIntent,
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
              payment_intent: stripePaymentIntent
            });

            refundResult.issued = true;
            refundResult.refundId = refund.id || null;

            console.log("Refund issued", refund.id || "");
          } else {
            refundResult.alreadyRefunded = true;
            console.log("Refund already exists");
          }
        }
      } catch (refundErr) {
        refundResult.error = refundErr?.message || String(refundErr);
        console.error("Refund attempt failed", refundErr);
      }

      try {
        if (customerEmail) {
          const customerEmailResult = await sendBookingFailureCustomerEmail({
            customerEmail: String(customerEmail).trim(),
            customerName,
            jobRef,
            stripeSessionId: session.id,
            refundResult,
            origin
          });

          console.log("Failure customer email result", customerEmailResult);
        }
      } catch (customerEmailErr) {
        console.error("Failure customer email failed", customerEmailErr);
      }

      try {
        const alertResult = await sendInternalFailureAlert({
          customerEmail,
          customerName,
          jobRef,
          stripeSessionId: session.id,
          paymentIntent: stripePaymentIntent,
          finalizeText: finalizeResp.text,
          refundResult
        });

        console.log("Internal failure alert result", alertResult);
      } catch (alertErr) {
        console.error("Internal failure alert failed", alertErr);
      }

      try {
        await sbFetchJson(`${SUPABASE_URL}/rest/v1/booking_failure_events`, {
          method: "POST",
          headers: {
            ...sbHeaders(SERVICE_ROLE),
            Prefer: "return=representation"
          },
          body: JSON.stringify([{
            job_ref: jobRef || null,
            customer_email: customerEmail || null,
            customer_name: customerName || null,
            stripe_checkout_session_id: session.id || null,
            stripe_payment_intent_id: stripePaymentIntent || null,
            amount_cents: collectedCents || 0,

            refund_attempted: !!refundResult?.attempted,
            refund_issued: !!refundResult?.issued,
            refund_id: refundResult?.refundId || null,
            refund_error: refundResult?.error || null,

            finalize_error: finalizeResp?.text || null,
            raw: {
              metadata,
              refund: refundResult
            },
            status: "new"
          }])
        });
      } catch (eventErr) {
        console.error("Could not record booking failure event", eventErr);
      }

      return res.status(200).json({
        received: true,
        handled: true,
        bookingFinalized: false,
        refund: refundResult
      });
    }

    const resultRow = Array.isArray(finalizeResp.data)
      ? finalizeResp.data[0]
      : null;

    const bookingId = resultRow?.booking_id || null;
    const finalJobRef = resultRow?.job_ref || jobRef;

    let emailResult = { skipped: true };
    let smsResult = { skipped: true };

    const requestRow = resultRow?.request_id
      ? await getBookingRequest({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          requestId: resultRow.request_id,
        })
      : null;

    if (customerEmail && resultRow) {
      const payload = {
        customerEmail: String(customerEmail).trim(),
        customerName,
        service: "Dryer Repair",
        date: fmtDateMDY(resultRow.service_date),
        timeWindow:
          `${fmtTime12h(resultRow.start_time)}–${fmtTime12h(resultRow.end_time)}`,
        address:
          requestRow?.address ||
          metadata.address ||
          metadata.service_address ||
          "",
        notes: "",
        jobRef: finalJobRef,
        stripeSessionId: session.id
      };

      try {
        const emailResp = await fetch(`${origin}/api/send-booking-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        emailResult = await emailResp.json().catch(() => ({
          ok: emailResp.ok,
          status: emailResp.status
        }));
      } catch (emailErr) {
        emailResult = { ok: false, error: emailErr?.message || String(emailErr) };
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
        smsResult = { ok: false, error: smsErr?.message || String(smsErr) };
        console.error("Booking SMS send failed", smsErr);
      }
    }

    return res.status(200).json({
      received: true,
      bookingId,
      jobRef: finalJobRef,
      emailResult,
      smsResult
    });
  } catch (err) {
    console.error("Stripe webhook fatal error", err);

    return res.status(500).json({
      error: "Webhook failure"
    });
  }
};
