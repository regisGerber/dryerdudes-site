const Stripe = require("stripe");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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

async function insertRows({ supabaseUrl, serviceRole, table, rows }) {
  const r = await sbFetchJson(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  if (!r.ok) {
    throw new Error(`Supabase insert failed (${table}): ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data : [];
}

async function upsertBilling({ supabaseUrl, serviceRole, row }) {
  const existing = await getSingle({
    supabaseUrl,
    serviceRole,
    table: "booking_billing",
    filters: { booking_id: row.booking_id },
    select: "id, booking_id",
  });

  if (existing?.id) {
    return patchRows({
      supabaseUrl,
      serviceRole,
      table: "booking_billing",
      filters: { booking_id: row.booking_id },
      patch: row,
    });
  }

  const inserted = await insertRows({
    supabaseUrl,
    serviceRole,
    table: "booking_billing",
    rows: [row],
  });

  return inserted[0] || null;
}

async function insertEvent({ supabaseUrl, serviceRole, bookingId, actorUserId, eventType, metadata }) {
  return insertRows({
    supabaseUrl,
    serviceRole,
    table: "booking_events",
    rows: [{
      booking_id: bookingId,
      actor_user_id: actorUserId,
      event_type: eventType,
      metadata: metadata || null,
    }],
  });
}

function centsFromDollars(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 100));
}

function isTruthy(v) {
  return v === true || v === "true" || v === "1" || v === 1 || v === "yes" || v === "on";
}

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

function cleanPhone(p) {
  return String(p || "").replace(/[^\d+]/g, "");
}

function isPmJob({ booking, request }) {
  return (
    String(booking?.request_source || "").toLowerCase() === "property_manager" ||
    String(request?.request_source || "").toLowerCase() === "property_manager" ||
    !!booking?.property_manager_id ||
    !!request?.property_manager_id ||
    booking?.paid_by_property_manager === true
  );
}

function isAuthorizedEntryJob({ booking, request }) {
  return (
    String(booking?.appointment_type || "").toLowerCase() === "no_one_home" ||
    request?.authorized_entry === true
  );
}

const ISSUE_STATEMENTS = {
  thermal_fuse: "The dryer had a failed thermal fuse. The failed part was addressed and the dryer was tested after service.",
  heating_element: "The dryer had a heating element issue. The heating system was serviced and the dryer was tested after service.",
  belt: "The dryer had a belt issue. The belt system was serviced and the dryer was tested after service.",
  rollers: "The dryer had worn drum rollers. The roller system was serviced and the dryer was tested after service.",
  idler_pulley: "The dryer had an idler pulley issue. The belt tension system was serviced and the dryer was tested after service.",
  motor: "The dryer had a motor-related issue. The dryer was diagnosed and serviced based on the motor findings.",
  timer: "The dryer had a timer/control issue. The control system was checked and serviced based on the findings.",
  start_switch: "The dryer had a start switch issue. The start circuit was serviced and the dryer was tested after service.",
  door_switch: "The dryer had a door switch issue. The door switch circuit was serviced and the dryer was tested after service.",
  venting_airflow: "The dryer had an airflow restriction or venting-related issue. Airflow was checked and recommendations were made as needed.",
  noise: "The dryer was making abnormal noise. The moving components were inspected and serviced based on the findings.",
  not_heating: "The dryer was not heating properly. The heating system was diagnosed and serviced based on the findings.",
  not_starting: "The dryer was not starting. The start circuit and related components were diagnosed and serviced based on the findings.",
  takes_too_long: "The dryer was taking too long to dry. Airflow, heating, and related components were checked and serviced based on the findings.",
  other: ""
};

function buildCustomerSummary({
  issueCode,
  issueOther,
  noPartsNeeded,
  partsCostCents,
  fullServiceIncluded,
  fullServiceAdded,
  partsOnOrder,
  additionalComment
}) {
  let base = ISSUE_STATEMENTS[issueCode] || "";

  if (issueCode === "other") {
    base = issueOther
      ? `The dryer was diagnosed for the following issue: ${issueOther}.`
      : "The dryer was diagnosed and serviced based on the findings.";
  }

  if (!base) {
    base = "The dryer was diagnosed and serviced based on the findings.";
  }

  const lines = [base];

  if (noPartsNeeded) {
    lines.push("No additional parts were needed for this visit.");
  } else if (partsCostCents > 0) {
    lines.push("Parts were used or recommended as part of this service.");
  }

  if (fullServiceIncluded) {
    lines.push("Full Service was included with this appointment.");
  } else if (fullServiceAdded) {
    lines.push("Full Service was added during this visit.");
  }

  if (partsOnOrder) {
    lines.push("Parts need to be ordered before the repair can be fully completed.");
  }

  if (additionalComment) {
    lines.push(additionalComment);
  }

  return lines.join(" ");
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
  if (!resp.ok) return { skipped: false, ok: false, status: resp.status, data };
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
  if (!resp.ok) return { skipped: false, ok: false, status: resp.status, data };
  return { skipped: false, ok: true, status: resp.status, data };
}

async function uploadPhotoDataUrl({ supabaseUrl, serviceRole, bookingId, dataUrl }) {
  const s = String(dataUrl || "");

  const m = s.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  if (!m) {
    throw new Error("Dryer photo must be a JPG, PNG, or WEBP image.");
  }

  const ext = m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase();
  const mime = `image/${ext}`;
  const base64 = m[2];
  const buf = Buffer.from(base64, "base64");

  if (buf.length > 4 * 1024 * 1024) {
    throw new Error("Dryer photo is too large. Please use a smaller photo.");
  }

  const objectPath = `bookings/${bookingId}/dryer-${Date.now()}.${ext === "jpeg" ? "jpg" : ext}`;

  const resp = await fetch(
    `${supabaseUrl}/storage/v1/object/job-photos/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        "Content-Type": mime,
        "x-upsert": "true",
      },
      body: buf,
    }
  );

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Photo upload failed: ${resp.status} ${JSON.stringify(data)}`);
  }

  return objectPath;
}

async function sendBillingLink({
  request,
  booking,
  checkoutUrl,
  remainingDueCents,
  partsCostCents,
  addFullServiceCents,
  customerSummary
}) {
  const dollars = (remainingDueCents / 100).toFixed(2);

  const smsBody =
    `Dryer Dudes: your remaining balance is $${dollars} for job ${booking.job_ref}. ` +
    `Pay here: ${checkoutUrl}`;

  const partsLine =
    partsCostCents > 0
      ? `<li><strong>Parts:</strong> $${(partsCostCents / 100).toFixed(2)}</li>`
      : "";

  const fullServiceLine =
    addFullServiceCents > 0
      ? `<li><strong>Full Service add-on:</strong> $20.00</li>`
      : "";

  const html =
    `<p>Hi ${escHtml(request.name || "there")},</p>` +
    `<p>Your Dryer Dudes technician finished the billing summary for job <strong>${escHtml(booking.job_ref)}</strong>.</p>` +
    `<p>${escHtml(customerSummary)}</p>` +
    `<ul>` +
    partsLine +
    fullServiceLine +
    `<li><strong>Remaining balance:</strong> $${escHtml(dollars)}</li>` +
    `</ul>` +
    `<p><a href="${checkoutUrl}">Pay remaining balance</a></p>` +
    `<p>The technician can mark the job complete after payment is received.</p>` +
    `<p>— Dryer Dudes</p>`;

  const smsResult = request.phone
    ? await sendSmsTwilio({ to: cleanPhone(request.phone), body: smsBody })
    : { skipped: true, reason: "no phone" };

  const emailResult = request.email
    ? await sendEmailResend({
        to: request.email,
        subject: `Dryer Dudes remaining balance — ${booking.job_ref}`,
        html,
      })
    : { skipped: true, reason: "no email" };

  return { smsResult, emailResult };
}

async function sendPmBillingNotice({
  pm,
  request,
  booking,
  customerSummary,
  partsCostCents,
  addFullServiceCents,
  totalJobCents,
  pmApprovalRequired
}) {
  if (!pm?.email) {
    return { skipped: true, reason: "PM email missing" };
  }

  const html =
    `<p>Hi ${escHtml(pm.contact_name || pm.company_name || "there")},</p>` +
    `<p>A Dryer Dudes job update was submitted for <strong>${escHtml(request.name || "tenant")}</strong>.</p>` +
    `<p><strong>Job:</strong> ${escHtml(booking.job_ref || "")}</p>` +
    `<p><strong>Address:</strong> ${escHtml(request.address || "")}</p>` +
    `<p>${escHtml(customerSummary)}</p>` +
    `<ul>` +
    `<li><strong>Parts:</strong> $${(partsCostCents / 100).toFixed(2)}</li>` +
    `<li><strong>Full Service add-on:</strong> $${(addFullServiceCents / 100).toFixed(2)}</li>` +
    `<li><strong>Total job amount:</strong> $${(totalJobCents / 100).toFixed(2)}</li>` +
    `</ul>` +
    `<p>${pmApprovalRequired ? "This job needs approval because it is over the pre-approved limit." : "This job was recorded for property manager billing."}</p>` +
    `<p>— Dryer Dudes</p>`;

  return sendEmailResend({
    to: pm.email,
    subject: pmApprovalRequired
      ? `Approval needed — ${booking.job_ref || "Dryer Dudes job"}`
      : `Dryer Dudes job update — ${booking.job_ref || "job"}`,
    html,
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    });

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
      return res.status(403).json({ ok: false, error: "Only techs can submit billing." });
    }

    const b = req.body || {};

    const bookingId = String(b.booking_id || "").trim();
    const issueCode = String(b.issue_code || "").trim();
    const issueOther = String(b.issue_other || "").trim();
    const noPartsNeeded = isTruthy(b.no_parts_needed);
    const partsCostCents = noPartsNeeded ? 0 : centsFromDollars(b.parts_cost);
    const addFullService = isTruthy(b.add_full_service);
    const partsOnOrder = isTruthy(b.parts_on_order);
    const partsOrderNotes = String(b.parts_order_notes || "").trim();
    const additionalComment = String(b.tech_notes || "").trim();
    const photoDataUrl = String(b.dryer_photo_data_url || "").trim();

    const applianceYearMadeRaw = b.appliance_year_made;
    const applianceYearMade =
      applianceYearMadeRaw === "" || applianceYearMadeRaw == null
        ? null
        : Number(applianceYearMadeRaw);

    const dryerMatchesWasher =
      b.dryer_matches_washer === "" || b.dryer_matches_washer == null
        ? null
        : isTruthy(b.dryer_matches_washer);

    if (!bookingId) return res.status(400).json({ ok: false, error: "Missing booking_id" });
    if (!issueCode) return res.status(400).json({ ok: false, error: "Issue is required." });
    if (issueCode === "other" && !issueOther) {
      return res.status(400).json({ ok: false, error: "Please describe the issue." });
    }
    if (!noPartsNeeded && partsCostCents < 1) {
      return res.status(400).json({ ok: false, error: "Enter a part cost or choose no parts needed." });
    }

    const booking = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: bookingId },
      select: "id,request_id,assigned_tech_id,window_start,window_end,status,appointment_type,job_ref,base_fee_cents,full_service_cents,collected_cents,property_manager_id,request_source,paid_by_property_manager",
    });

    if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });

    if (profile.role !== "admin" && booking.assigned_tech_id !== user.id) {
      return res.status(403).json({ ok: false, error: "This booking is not assigned to the signed-in tech." });
    }

    const request = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: booking.request_id },
      select: "id,name,phone,email,address,total_job_approval_limit_cents,property_manager_id,request_source,authorized_entry",
    });

    if (!request) return res.status(404).json({ ok: false, error: "Request not found" });

    const pmJob = isPmJob({ booking, request });
    const authorizedEntryJob = isAuthorizedEntryJob({ booking, request });

    const requirePhoto = pmJob || authorizedEntryJob;
    const requireYearMade = pmJob;

    if (requireYearMade) {
      const currentYear = new Date().getFullYear();

      if (
        !Number.isFinite(applianceYearMade) ||
        applianceYearMade < 1980 ||
        applianceYearMade > currentYear + 1
      ) {
        return res.status(400).json({
          ok: false,
          error: "Dryer year made is required for property manager jobs.",
        });
      }
    }

    if (requirePhoto && !photoDataUrl) {
      return res.status(400).json({
        ok: false,
        error: pmJob
          ? "Dryer photo is required for property manager jobs."
          : "Dryer photo is required for authorized-entry jobs.",
      });
    }

    const origin = getOrigin(req);

    let dryerPhotoPath = null;

    if (photoDataUrl) {
      dryerPhotoPath = await uploadPhotoDataUrl({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        bookingId,
        dataUrl: photoDataUrl,
      });
    }

    const fullServiceIncluded =
      String(booking.appointment_type || "").toLowerCase() === "full_service" ||
      Number(booking.full_service_cents || 0) > 0;

    const addFullServiceCents =
      addFullService && !fullServiceIncluded
        ? 2000
        : 0;

    const amountAlreadyCollectedCents = Number(booking.collected_cents || 0);
    const baseFeeCents = Number(booking.base_fee_cents || 8000);
    const originalFullServiceCents = Number(booking.full_service_cents || 0);

    const totalJobCents =
      baseFeeCents +
      originalFullServiceCents +
      addFullServiceCents +
      partsCostCents;

    const remainingDueCents =
      Math.max(0, totalJobCents - amountAlreadyCollectedCents);

    const customerSummary = buildCustomerSummary({
      issueCode,
      issueOther,
      noPartsNeeded,
      partsCostCents,
      fullServiceIncluded,
      fullServiceAdded: addFullServiceCents > 0,
      partsOnOrder,
      additionalComment
    });

    const pmApprovalLimitCents =
      Number(request.total_job_approval_limit_cents || 15000);

    const pmApprovalRequired =
      pmJob && totalJobCents > pmApprovalLimitCents;

    let billingStatus = "draft";
    let paymentStatus = "not_required";
    let checkoutUrl = null;
    let stripeCheckoutSessionId = null;
    let nextBookingStatus = "billing_pending";
    let pmApprovalStatus = "not_required";
    let notification = { skipped: true };
    let pmNotice = { skipped: true };

    if (pmJob) {
      paymentStatus = "not_required";

      if (pmApprovalRequired) {
        billingStatus = "pm_approval_needed";
        pmApprovalStatus = "pending";
        nextBookingStatus = "parts_approval_needed";
      } else if (partsOnOrder) {
        billingStatus = "parts_on_order";
        pmApprovalStatus = "not_required";
        nextBookingStatus = "parts_on_order";
      } else {
        billingStatus = "pm_unbilled";
        pmApprovalStatus = "not_required";
        nextBookingStatus = "billing_pending";
      }

      const pmId = booking.property_manager_id || request.property_manager_id;
      const pm = pmId
        ? await getSingle({
            supabaseUrl: SUPABASE_URL,
            serviceRole: SERVICE_ROLE,
            table: "property_managers",
            filters: { id: pmId },
            select: "id,company_name,contact_name,email,phone",
          })
        : null;

      pmNotice = await sendPmBillingNotice({
        pm,
        request,
        booking,
        customerSummary,
        partsCostCents,
        addFullServiceCents,
        totalJobCents,
        pmApprovalRequired,
      });
    } else if (remainingDueCents > 0) {
      const lineItems = [];

      if (partsCostCents > 0) {
        lineItems.push({
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: partsCostCents,
            product_data: {
              name: `Dryer repair parts - ${booking.job_ref || "job"}`,
            },
          },
        });
      }

      if (addFullServiceCents > 0) {
        lineItems.push({
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: addFullServiceCents,
            product_data: {
              name: `Full Service add-on - ${booking.job_ref || "job"}`,
            },
          },
        });
      }

      if (!lineItems.length) {
        lineItems.push({
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: remainingDueCents,
            product_data: {
              name: `Dryer Dudes remaining balance - ${booking.job_ref || "job"}`,
            },
          },
        });
      }

      const checkoutSession = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: request.email || undefined,
        success_url: `${origin}/payment-success.html?job_ref=${encodeURIComponent(booking.job_ref || "")}`,
        cancel_url: `${origin}/payment-cancelled.html?job_ref=${encodeURIComponent(booking.job_ref || "")}`,
        metadata: {
          kind: "tech_balance",
          booking_id: booking.id,
          job_ref: booking.job_ref || "",
        },
        line_items: lineItems,
      });

      checkoutUrl = checkoutSession.url;
      stripeCheckoutSessionId = checkoutSession.id;

      billingStatus = partsOnOrder ? "parts_on_order" : "sent_to_customer";
      paymentStatus = "checkout_sent";
      nextBookingStatus = "awaiting_payment";

      notification = await sendBillingLink({
        request,
        booking,
        checkoutUrl,
        remainingDueCents,
        partsCostCents,
        addFullServiceCents,
        customerSummary,
      });
    } else {
      billingStatus = partsOnOrder ? "parts_on_order" : "paid";
      paymentStatus = "paid";
      nextBookingStatus = partsOnOrder ? "parts_on_order" : "billing_pending";
    }

    const billingRow = await upsertBilling({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      row: {
        booking_id: booking.id,
        request_id: booking.request_id,
        created_by_user_id: user.id,
        updated_by_user_id: user.id,

        issue_code: issueCode,
        issue_other: issueOther || null,

        no_parts_needed: noPartsNeeded,
        parts_cost_cents: partsCostCents,

        add_full_service: addFullService,
        add_full_service_cents: addFullServiceCents,

        appliance_year_made: applianceYearMade,
        appliance_age_years: null,
        dryer_matches_washer: pmJob ? dryerMatchesWasher : null,

        dryer_photo_path: dryerPhotoPath,
        tech_notes: customerSummary,

        amount_already_collected_cents: amountAlreadyCollectedCents,
        remaining_due_cents: remainingDueCents,
        total_job_cents: totalJobCents,

        pm_approval_required: pmApprovalRequired,
        pm_approval_status: pmApprovalStatus,

        payment_status: paymentStatus,
        stripe_checkout_session_id: stripeCheckoutSessionId,
        payment_url: checkoutUrl,

        status: billingStatus,
        updated_at: new Date().toISOString(),
      },
    });

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: booking.id },
      patch: {
        status: nextBookingStatus,
        billing_started_at: new Date().toISOString(),
        billing_sent_at: new Date().toISOString(),
        tech_notes: customerSummary,
        full_service_cents: Number(booking.full_service_cents || 0) + addFullServiceCents,
      },
    });

    await insertEvent({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingId: booking.id,
      actorUserId: user.id,
      eventType: "billing_submitted",
      metadata: {
        billing_id: billingRow?.id,
        issue_code: issueCode,
        parts_cost_cents: partsCostCents,
        add_full_service_cents: addFullServiceCents,
        remaining_due_cents: remainingDueCents,
        total_job_cents: totalJobCents,
        pm_approval_required: pmApprovalRequired,
        require_photo: requirePhoto,
        require_year_made: requireYearMade,
        customer_summary: customerSummary,
        notification,
        pmNotice,
      },
    });

    return res.status(200).json({
      ok: true,
      booking_status: nextBookingStatus,
      billing: billingRow,
      checkout_url: checkoutUrl,
      notification,
      pmNotice,
      requirements: {
        is_pm_job: pmJob,
        is_authorized_entry: authorizedEntryJob,
        require_photo: requirePhoto,
        require_year_made: requireYearMade,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
