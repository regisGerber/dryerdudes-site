// api/stripe-webhook.js
import Stripe from "stripe";

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

export const config = {
  api: { bodyParser: false },
};

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;
  return `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();
  let data;
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

function computeSlotCode(service_date, slot_index) {
  return `${service_date}#${slot_index}`;
}

// Build "YYYY-MM-DDTHH:MM:SS-08:00"
function makeLocalTimestamptz(service_date, hhmmss, offset = "-08:00") {
  if (!service_date || !hhmmss) return null;
  const t = String(hhmmss).trim().slice(0, 8);
  const m = t.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = m[1];
  const mm = m[2];
  const ss = m[3] ?? "00";
  return `${service_date}T${hh}:${mm}:${ss}${offset}`;
}

function fail(res, code, message, extra = {}) {
  console.error("stripe-webhook FAIL:", { code, message, ...extra });
  return res.status(500).json({ ok: false, code, message, ...extra });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");
    const STRIPE_WEBHOOK_SECRET = requireEnv("STRIPE_WEBHOOK_SECRET");
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("Missing stripe-signature header");

    const rawBody = await getRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }

    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: true });
    }

    const session = event.data.object;
    const m = session.metadata || {};
    const origin = getOrigin(req);

    const offerToken = String(m.offer_token || m.offerToken || "").trim();
    const jobRef = String(m.jobRef || m.jobref || m.job_reference || "").trim() || null;

    if (!offerToken) {
      return fail(res, "missing_offer_token", "Missing offer_token in Stripe session metadata", {
        sessionId: session.id,
        metadata: m,
      });
    }

    const customerEmail =
      session.customer_details?.email ||
      session.customer_email ||
      null;

    const safeEmail = customerEmail ? String(customerEmail).trim() : "";

    // 0) Idempotency
    const existingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?stripe_checkout_session_id=eq.${encodeURIComponent(session.id)}` +
      `&select=id&limit=1`;

    const existingResp = await sbFetchJson(existingUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!existingResp.ok) {
      return fail(res, "supabase_existing_check_failed", "Supabase check for existing booking failed", {
        sessionId: session.id,
        status: existingResp.status,
        body: existingResp.text,
      });
    }
    const existing = Array.isArray(existingResp.data) ? existingResp.data[0] : null;
    if (existing) {
      return res.status(200).json({ received: true, already_processed: true });
    }

    // 1) Offer row (REMOVE window_start/window_end — they do not exist)
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(offerToken)}` +
      `&select=id,request_id,offer_token,is_active,service_date,slot_index,zone_code,start_time,end_time,window_label`;

    const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!offerResp.ok) {
      return fail(res, "offer_fetch_failed", "Supabase offer fetch failed", {
        sessionId: session.id,
        status: offerResp.status,
        body: offerResp.text,
        offerUrl,
      });
    }

    const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;
    if (!offerRow) {
      return fail(res, "offer_not_found", "Offer not found in booking_request_offers", {
        sessionId: session.id,
        offerToken,
      });
    }

    if (offerRow.is_active === false) {
      return fail(res, "offer_inactive", "Offer is inactive (slot already taken)", {
        sessionId: session.id,
        offerToken,
      });
    }

    // 2) booking_requests -> appointment_type
    const reqUrl =
      `${SUPABASE_URL}/rest/v1/booking_requests` +
      `?id=eq.${encodeURIComponent(offerRow.request_id)}` +
      `&select=id,appointment_type&limit=1`;

    const reqResp = await sbFetchJson(reqUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!reqResp.ok) {
      return fail(res, "request_fetch_failed", "Supabase booking_requests fetch failed", {
        sessionId: session.id,
        status: reqResp.status,
        body: reqResp.text,
        requestId: offerRow.request_id,
      });
    }

    const reqRow = Array.isArray(reqResp.data) ? reqResp.data[0] : null;
    if (!reqRow) {
      return fail(res, "request_not_found", "Booking request not found", {
        sessionId: session.id,
        requestId: offerRow.request_id,
      });
    }

    const slotCode = computeSlotCode(offerRow.service_date, offerRow.slot_index);
    const zoneCode = String(offerRow.zone_code || "");
    const apptType = String(reqRow.appointment_type || "standard");

    // 3) Compute NOT NULL bookings.window_start/window_end
    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");
    const windowStart = makeLocalTimestamptz(offerRow.service_date, offerRow.start_time, tzOffset);
    const windowEnd = makeLocalTimestamptz(offerRow.service_date, offerRow.end_time, tzOffset);

    if (!windowStart || !windowEnd) {
      return fail(res, "window_compute_failed", "Could not compute bookings.window_start/window_end", {
        sessionId: session.id,
        service_date: offerRow.service_date,
        start_time: offerRow.start_time,
        end_time: offerRow.end_time,
        tzOffset,
      });
    }

    // 4) Insert booking
    const amountTotalCents =
      typeof session.amount_total === "number" ? session.amount_total : null;

    const bookingInsert = {
      request_id: offerRow.request_id,
      selected_option_id: offerRow.id,
      window_start: windowStart,
      window_end: windowEnd,
      slot_code: slotCode,
      zone_code: zoneCode,
      appointment_type: apptType,
      payment_status: "paid",
      collected_cents: amountTotalCents,
      stripe_checkout_session_id: session.id || null,
      stripe_payment_intent_id: session.payment_intent || null,
      status: "booked",
    };

    const bookingResp = await sbFetchJson(`${SUPABASE_URL}/rest/v1/bookings`, {
      method: "POST",
      headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=representation" },
      body: JSON.stringify(bookingInsert),
    });

    if (!bookingResp.ok) {
      return fail(res, "booking_insert_failed", "Booking insert failed", {
        sessionId: session.id,
        status: bookingResp.status,
        body: bookingResp.text,
        bookingInsert,
      });
    }

    const bookingRow = Array.isArray(bookingResp.data) ? bookingResp.data[0] : null;

    // 5) Invalidate offers (don’t filter appointment_type)
    const invalidateUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&service_date=eq.${encodeURIComponent(offerRow.service_date)}` +
      `&slot_index=eq.${encodeURIComponent(offerRow.slot_index)}`;

    await sbFetchJson(invalidateUrl, {
      method: "PATCH",
      headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
      body: JSON.stringify({ is_active: false }),
    });

    // 6) Mark request booked (optional)
    const reqPatchUrl =
      `${SUPABASE_URL}/rest/v1/booking_requests?id=eq.${encodeURIComponent(offerRow.request_id)}`;

    await sbFetchJson(reqPatchUrl, {
      method: "PATCH",
      headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
      body: JSON.stringify({ status: "booked" }),
    });

    // 7) Send email (only after booking insert succeeded)
    if (safeEmail) {
      const start = offerRow.start_time ? fmtTime12h(offerRow.start_time) : "";
      const end = offerRow.end_time ? fmtTime12h(offerRow.end_time) : "";
      const timeWindow =
        start && end ? `${start}–${end}` : (offerRow.window_label ? String(offerRow.window_label) : "TBD");

      const payload = {
        customerEmail: safeEmail,
        customerName: session.customer_details?.name || "there",
        service: m.service || "Dryer Repair",
        date: String(offerRow.service_date || "Scheduled"),
        timeWindow,
        address: m.address || "",
        notes: m.notes || "",
        jobRef,
        stripeSessionId: session.id,
      };

      const r = await fetch(`${origin}/api/send-booking-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const text = await r.text();
      if (!r.ok) {
        console.error("send-booking-email failed", { sessionId: session.id, status: r.status, body: text });
      }
    }

    return res.status(200).json({ received: true, bookingId: bookingRow?.id || null });
  } catch (err) {
    console.error("stripe-webhook unhandled error:", err);
    return res.status(500).json({
      ok: false,
      code: "unhandled_exception",
      message: err?.message || String(err),
    });
  }
}
