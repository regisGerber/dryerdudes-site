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

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
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

/**
 * Timezone helpers
 *
 * Stripe/public booking used to pass a fixed "-08:00" into finalize_paid_booking.
 * That breaks during daylight saving time because Oregon is "-07:00" in summer.
 *
 * This calculates the correct offset from the selected schedule slot's actual
 * service_date + start_time in America/Los_Angeles.
 */
function getTimeZoneOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = dtf.formatToParts(date);
  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  return asUTC - date.getTime();
}

function getUtcMsForLocalSlot(serviceDate, timeValue, timeZone) {
  const dateMatch = String(serviceDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue || "").slice(0, 8).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!dateMatch || !timeMatch) {
    return null;
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || "00");

  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  let utcMs = localAsUtc;

  for (let i = 0; i < 3; i++) {
    const offset = getTimeZoneOffsetMs(timeZone, new Date(utcMs));
    const nextUtcMs = localAsUtc - offset;

    if (Math.abs(nextUtcMs - utcMs) < 1) {
      utcMs = nextUtcMs;
      break;
    }

    utcMs = nextUtcMs;
  }

  return utcMs;
}

function formatOffsetForMinutes(totalMinutes) {
  const sign = totalMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(totalMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");

  return `${sign}${hh}:${mm}`;
}

function getOffsetForLocalSlot(serviceDate, timeValue, timeZone = "America/Los_Angeles") {
  const utcMs = getUtcMsForLocalSlot(serviceDate, timeValue, timeZone);

  if (utcMs == null) {
    return process.env.LOCAL_TZ_OFFSET || "-08:00";
  }

  const offsetMs = getTimeZoneOffsetMs(timeZone, new Date(utcMs));
  const offsetMinutes = Math.round(offsetMs / 60000);

  return formatOffsetForMinutes(offsetMinutes);
}

async function getSelectedScheduleSlotForOffer({
  SUPABASE_URL,
  SERVICE_ROLE,
  offerToken,
}) {
  const offerLookupUrl = new URL(`${SUPABASE_URL}/rest/v1/booking_request_offers`);
  offerLookupUrl.searchParams.set("select", "id,slot_id,route_zone_code");
  offerLookupUrl.searchParams.set("offer_token", `eq.${offerToken}`);
  offerLookupUrl.searchParams.set("limit", "1");

  const offerLookupResp = await sbFetchJson(offerLookupUrl.toString(), {
    method: "GET",
    headers: sbHeaders(SERVICE_ROLE),
  });

  if (
    !offerLookupResp.ok ||
    !Array.isArray(offerLookupResp.data) ||
    !offerLookupResp.data[0]?.slot_id
  ) {
    return {
      ok: false,
      error: "Could not look up selected offer slot.",
      details: offerLookupResp.data,
      status: offerLookupResp.status,
    };
  }

  const selectedSlotId = offerLookupResp.data[0].slot_id;

  const slotLookupUrl = new URL(`${SUPABASE_URL}/rest/v1/schedule_slots`);
  slotLookupUrl.searchParams.set("select", "id,service_date,start_time,end_time,window_label,slot_index,zone_code");
  slotLookupUrl.searchParams.set("id", `eq.${selectedSlotId}`);
  slotLookupUrl.searchParams.set("limit", "1");

  const slotLookupResp = await sbFetchJson(slotLookupUrl.toString(), {
    method: "GET",
    headers: sbHeaders(SERVICE_ROLE),
  });

  if (
    !slotLookupResp.ok ||
    !Array.isArray(slotLookupResp.data) ||
    !slotLookupResp.data[0]
  ) {
    return {
      ok: false,
      error: "Could not look up selected schedule slot.",
      details: slotLookupResp.data,
      status: slotLookupResp.status,
    };
  }

  return {
    ok: true,
    slot: slotLookupResp.data[0],
  };
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
      return res.status(200).json({ received: true });
    }

    const session = event.data.object;
    const metadata = session.metadata || {};
    const origin = getOrigin(req);
    if (metadata.kind === "tech_balance") {
  const bookingId = String(metadata.booking_id || "").trim();
  const stripePaymentIntent = session.payment_intent || null;
  const amountTotal =
    typeof session.amount_total === "number"
      ? session.amount_total
      : 0;

  if (!bookingId) {
    return res.status(200).json({ received: true, skipped: "missing_booking_id" });
  }

  const billingUrl =
    `${SUPABASE_URL}/rest/v1/booking_billing` +
    `?booking_id=eq.${encodeURIComponent(bookingId)}` +
    `&select=id,booking_id,remaining_due_cents,payment_status&limit=1`;

  const billingResp = await sbFetchJson(billingUrl, {
    headers: sbHeaders(SERVICE_ROLE),
  });

  const billingRow = Array.isArray(billingResp.data)
    ? billingResp.data[0]
    : null;

  if (!billingRow) {
    console.error("tech_balance webhook: billing row not found", { bookingId });
    return res.status(200).json({ received: true, skipped: "billing_not_found" });
  }

  if (billingRow.payment_status === "paid") {
    return res.status(200).json({ received: true, skipped: "already_paid" });
  }

  const bookingUrl =
    `${SUPABASE_URL}/rest/v1/bookings` +
    `?id=eq.${encodeURIComponent(bookingId)}` +
    `&select=id,collected_cents,status&limit=1`;

  const bookingResp = await sbFetchJson(bookingUrl, {
    headers: sbHeaders(SERVICE_ROLE),
  });

  const bookingRow = Array.isArray(bookingResp.data)
    ? bookingResp.data[0]
    : null;

  const newCollected =
    Number(bookingRow?.collected_cents || 0) + amountTotal;

  const patchBillingUrl =
    `${SUPABASE_URL}/rest/v1/booking_billing` +
    `?booking_id=eq.${encodeURIComponent(bookingId)}`;

  await sbFetchJson(patchBillingUrl, {
    method: "PATCH",
    headers: {
      ...sbHeaders(SERVICE_ROLE),
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      payment_status: "paid",
      status: "paid",
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: stripePaymentIntent,
      updated_at: new Date().toISOString(),
    }),
  });

  const patchBookingUrl =
    `${SUPABASE_URL}/rest/v1/bookings` +
    `?id=eq.${encodeURIComponent(bookingId)}`;

  await sbFetchJson(patchBookingUrl, {
    method: "PATCH",
    headers: {
      ...sbHeaders(SERVICE_ROLE),
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      status: "billing_pending",
      collected_cents: newCollected,
      payment_status: "paid",
    }),
  });

  return res.status(200).json({
    received: true,
    handled: true,
    kind: "tech_balance",
    bookingId,
  });
}

    const offerToken = String(metadata.offer_token || "").trim();
    const jobRef = String(metadata.jobRef || "").trim() || null;
    const appointmentType = String(metadata.appointment_type || "standard").trim();

    const stripePaymentIntent = session.payment_intent || null;

    const collectedCents =
      typeof session.amount_total === "number"
        ? session.amount_total
        : 0;

    if (!offerToken) {
      return res.status(200).json({ received: true });
    }

    // Idempotency check
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
      return res.status(200).json({ received: true });
    }

    /**
     * Look up the selected schedule slot and calculate the correct timezone offset
     * for the exact service date.
     *
     * This prevents public paid bookings from being stored one hour late during
     * daylight saving time.
     */
    const slotLookup = await getSelectedScheduleSlotForOffer({
      SUPABASE_URL,
      SERVICE_ROLE,
      offerToken,
    });

    if (!slotLookup.ok) {
      console.error("Selected slot lookup failed before finalize", slotLookup);

      // Payment already happened. Returning 200 avoids endless Stripe retries.
      // Do not finalize a booking with a guessed timezone offset if slot lookup fails.
      try {
        if (stripePaymentIntent) {
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
            await stripe.refunds.create({
              payment_intent: stripePaymentIntent,
            });

            console.log("Refund issued because selected slot lookup failed");
          } else {
            console.log("Refund already exists");
          }
        }
      } catch (refundErr) {
        console.error("Refund attempt failed after selected slot lookup failure", refundErr);
      }

      return res.status(200).json({
        received: true,
        handled: true,
        error: "selected_slot_lookup_failed",
      });
    }

    const selectedSlot = slotLookup.slot;
    const serviceTimeZone = process.env.SERVICE_TIME_ZONE || "America/Los_Angeles";

    const slotTzOffset = getOffsetForLocalSlot(
      selectedSlot.service_date,
      selectedSlot.start_time,
      serviceTimeZone
    );

    console.log("Finalizing paid booking with timezone offset", {
      service_date: selectedSlot.service_date,
      start_time: selectedSlot.start_time,
      window_label: selectedSlot.window_label,
      zone_code: selectedSlot.zone_code,
      serviceTimeZone,
      slotTzOffset,
    });

    // Finalize booking
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
        p_tz_offset: slotTzOffset,
      }),
    });

    if (!finalizeResp.ok) {
      console.error("Booking finalize failed", finalizeResp.text);

      try {
        if (stripePaymentIntent) {
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
            await stripe.refunds.create({
              payment_intent: stripePaymentIntent,
            });

            console.log("Refund issued");
          } else {
            console.log("Refund already exists");
          }
        }
      } catch (refundErr) {
        console.error("Refund attempt failed", refundErr);
      }

      return res.status(200).json({
        received: true,
        handled: true,
      });
    }

    const resultRow = Array.isArray(finalizeResp.data)
      ? finalizeResp.data[0]
      : null;

    const bookingId = resultRow?.booking_id || null;

    // Confirmation email
    const customerEmail =
      session.customer_details?.email ||
      session.customer_email ||
      null;

    if (customerEmail && resultRow) {
      const payload = {
        customerEmail: String(customerEmail).trim(),
        customerName:
          session.customer_details?.name || "there",

        service: "Dryer Repair",

        date: fmtDateMDY(resultRow.service_date),

        timeWindow:
          `${fmtTime12h(resultRow.start_time)}–${fmtTime12h(resultRow.end_time)}`,

        address: metadata.address || "",

        notes: "",

        jobRef: jobRef,

        stripeSessionId: session.id,
      };

      try {
        await fetch(`${origin}/api/send-booking-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (emailErr) {
        console.error("Email send failed", emailErr);
      }
    }

    return res.status(200).json({
      received: true,
      bookingId,
    });

  } catch (err) {
    console.error("Stripe webhook fatal error", err);

    return res.status(500).json({
      error: "Webhook failure",
    });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
