// /api/stripe-webhook.js (FULL REPLACEMENT — CommonJS, validates availability, auto-refunds on stale offers)
const Stripe = require("stripe");

// ---- fetch fallback (prevents crashes if global fetch is missing) ----
const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

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

module.exports.config = {
  api: { bodyParser: false },
};

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;
  return `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetchFn(url, { method, headers, body });
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

function okIgnored(res, reason, extra = {}) {
  console.warn("stripe-webhook ignored:", { reason, ...extra });
  return res.status(200).json({ received: true, ignored: true, reason });
}

function fail500(res, code, message, extra = {}) {
  console.error("stripe-webhook FAIL:", { code, message, ...extra });
  return res.status(500).json({ ok: false, code, message, ...extra });
}

function slotMatches(a, b) {
  if (!a || !b) return false;
  return (
    String(a.service_date || "") === String(b.service_date || "") &&
    Number(a.slot_index) === Number(b.slot_index) &&
    String(a.zone_code || "").toUpperCase() === String(b.zone_code || "").toUpperCase() &&
    String(a.start_time || "").slice(0, 8) === String(b.start_time || "").slice(0, 8) &&
    String(a.end_time || "").slice(0, 8) === String(b.end_time || "").slice(0, 8)
  );
}

async function refundIfPossible(stripe, session, reason) {
  const pi = session.payment_intent;
  if (!pi) {
    console.warn("refund skipped (no payment_intent)", { sessionId: session.id, reason });
    return { attempted: false, skipped: true, why: "no_payment_intent" };
  }

  try {
    // Use an idempotency key so webhook retries won't create multiple refunds
    const refund = await stripe.refunds.create(
      { payment_intent: pi, reason: "requested_by_customer", metadata: { reason: String(reason || "invalid_offer"), session_id: session.id } },
      { idempotencyKey: `refund_${session.id}_${String(reason || "invalid_offer")}` }
    );
    return { attempted: true, ok: true, refundId: refund.id };
  } catch (e) {
    // If it was already refunded, Stripe may error depending on state — log and move on.
    return { attempted: true, ok: false, error: e?.message || String(e) };
  }
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

    // Only process successful checkout completion
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: true });
    }

    const session = event.data.object;
    const m = session.metadata || {};
    const origin = getOrigin(req);

    const offerToken = String(m.offer_token || m.offerToken || "").trim();
    const jobRef = String(m.jobRef || m.jobref || m.job_reference || "").trim() || null;

    if (!offerToken) {
      // Misconfiguration you want to notice
      return fail500(res, "missing_offer_token", "Missing offer_token in Stripe session metadata", {
        sessionId: session.id,
        metadata: m,
      });
    }

    // 0) Idempotency: already processed this Stripe session?
    const existingUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?stripe_checkout_session_id=eq.${encodeURIComponent(session.id)}` +
      `&select=id&limit=1`;

    const existingResp = await sbFetchJson(existingUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!existingResp.ok) {
      return fail500(res, "supabase_existing_check_failed", "Supabase check for existing booking failed", {
        sessionId: session.id,
        status: existingResp.status,
        body: existingResp.text,
      });
    }

    const existing = Array.isArray(existingResp.data) ? existingResp.data[0] : null;
    if (existing) {
      return res.status(200).json({ received: true, already_processed: true });
    }

    // 1) Fetch offer row
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(offerToken)}` +
      `&select=id,request_id,offer_token,is_active,service_date,slot_index,zone_code,start_time,end_time,window_label`;

    const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!offerResp.ok) {
      return fail500(res, "offer_fetch_failed", "Supabase offer fetch failed", {
        sessionId: session.id,
        status: offerResp.status,
        body: offerResp.text,
      });
    }

    const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;

    // If offer missing/inactive: refund (customer paid for nothing) and stop retries
    if (!offerRow) {
      const refund = await refundIfPossible(stripe, session, "offer_not_found");
      return okIgnored(res, "offer_not_found_refunded", { sessionId: session.id, offerToken, refund });
    }

    if (offerRow.is_active === false) {
      const refund = await refundIfPossible(stripe, session, "offer_inactive");
      return okIgnored(res, "offer_inactive_refunded", { sessionId: session.id, offerToken, refund });
    }

    // 2) Fetch request to get appointment_type
    const reqUrl =
      `${SUPABASE_URL}/rest/v1/booking_requests` +
      `?id=eq.${encodeURIComponent(offerRow.request_id)}` +
      `&select=id,appointment_type&limit=1`;

    const reqResp = await sbFetchJson(reqUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!reqResp.ok) {
      return fail500(res, "request_fetch_failed", "Supabase booking_requests fetch failed", {
        sessionId: session.id,
        status: reqResp.status,
        body: reqResp.text,
        requestId: offerRow.request_id,
      });
    }

    const reqRow = Array.isArray(reqResp.data) ? reqResp.data[0] : null;
    if (!reqRow) {
      const refund = await refundIfPossible(stripe, session, "request_not_found");
      return okIgnored(res, "request_not_found_refunded", { sessionId: session.id, requestId: offerRow.request_id, refund });
    }

    const zoneCode = String(offerRow.zone_code || "").toUpperCase();
    const apptType = String(reqRow.appointment_type || "standard").toLowerCase();

    // 3) Validate against LIVE scheduler output (this captures: booked, started, two-zone rule, time-off filtering, etc)
    const schedUrl =
      `${origin}/api/get-available-slots` +
      `?zone=${encodeURIComponent(zoneCode)}` +
      `&type=${encodeURIComponent(apptType)}`;

    const schedResp = await fetchFn(schedUrl, { method: "GET" });
    const schedJson = await schedResp.json().catch(() => ({}));

    if (!schedResp.ok) {
      // If we can't validate, fail 500 so Stripe retries (better than charging without booking).
      return fail500(res, "scheduler_validate_failed", "Could not validate slot against scheduler", {
        sessionId: session.id,
        status: schedResp.status,
        body: JSON.stringify(schedJson).slice(0, 500),
      });
    }

    const candidates = [
      ...(Array.isArray(schedJson.primary) ? schedJson.primary : []),
      ...(Array.isArray(schedJson.more?.options) ? schedJson.more.options : []),
    ];

    const offeredNow = candidates.some((c) =>
      slotMatches(
        {
          service_date: offerRow.service_date,
          slot_index: offerRow.slot_index,
          zone_code: zoneCode,
          start_time: offerRow.start_time,
          end_time: offerRow.end_time,
        },
        c
      )
    );

    if (!offeredNow) {
      // Slot is no longer valid (time-off, booked, started, rule changes, etc) => refund + deactivate offer
      await sbFetchJson(
        `${SUPABASE_URL}/rest/v1/booking_request_offers?offer_token=eq.${encodeURIComponent(offerToken)}`,
        {
          method: "PATCH",
          headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
          body: JSON.stringify({ is_active: false }),
        }
      );

      const refund = await refundIfPossible(stripe, session, "slot_not_available_now");
      return okIgnored(res, "slot_not_available_refunded", { sessionId: session.id, zoneCode, refund });
    }

    // 4) Final conflict check in bookings table (race protection)
    const slotCode = computeSlotCode(offerRow.service_date, offerRow.slot_index);

    const conflictUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&select=id&limit=1`;

    const conflictResp = await sbFetchJson(conflictUrl, { headers: sbHeaders(SERVICE_ROLE) });
    if (!conflictResp.ok) {
      return fail500(res, "conflict_check_failed", "Supabase conflict check failed", {
        sessionId: session.id,
        status: conflictResp.status,
        body: conflictResp.text,
      });
    }

    const conflict = Array.isArray(conflictResp.data) ? conflictResp.data[0] : null;
    if (conflict) {
      // Someone else booked it between validation and now => refund + deactivate offer
      await sbFetchJson(
        `${SUPABASE_URL}/rest/v1/booking_request_offers?offer_token=eq.${encodeURIComponent(offerToken)}`,
        {
          method: "PATCH",
          headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
          body: JSON.stringify({ is_active: false }),
        }
      );

      const refund = await refundIfPossible(stripe, session, "slot_race_conflict");
      return okIgnored(res, "slot_already_booked_refunded", { sessionId: session.id, zoneCode, slotCode, refund });
    }

    // 5) Compute window_start/window_end (NOT NULL)
    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");
    const windowStart = makeLocalTimestamptz(offerRow.service_date, offerRow.start_time, tzOffset);
    const windowEnd = makeLocalTimestamptz(offerRow.service_date, offerRow.end_time, tzOffset);

    if (!windowStart || !windowEnd) {
      // Refund because we cannot create a valid booking window
      const refund = await refundIfPossible(stripe, session, "window_compute_failed");
      return okIgnored(res, "window_compute_failed_refunded", {
        sessionId: session.id,
        service_date: offerRow.service_date,
        start_time: offerRow.start_time,
        end_time: offerRow.end_time,
        refund,
      });
    }

    // 6) Insert booking
    const amountTotalCents = typeof session.amount_total === "number" ? session.amount_total : null;

    const bookingInsert = {
      request_id: offerRow.request_id,
      selected_option_id: offerRow.id,

      window_start: windowStart,
      window_end: windowEnd,

      slot_code: slotCode,
      zone_code: zoneCode,
      appointment_type: String(reqRow.appointment_type || "standard"),

      payment_status: "paid",
      collected_cents: amountTotalCents,

      stripe_checkout_session_id: session.id || null,
      stripe_payment_intent_id: session.payment_intent || null,

      status: "scheduled",
      job_ref: jobRef || null,
    };

    const bookingResp = await sbFetchJson(`${SUPABASE_URL}/rest/v1/bookings`, {
      method: "POST",
      headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=representation" },
      body: JSON.stringify(bookingInsert),
    });

    if (!bookingResp.ok) {
      // If insert fails due to a last-millisecond race, refund and stop retries
      const body = String(bookingResp.text || "");
      if (bookingResp.status === 409 || /duplicate|unique|constraint/i.test(body)) {
        await sbFetchJson(
          `${SUPABASE_URL}/rest/v1/booking_request_offers?offer_token=eq.${encodeURIComponent(offerToken)}`,
          {
            method: "PATCH",
            headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
            body: JSON.stringify({ is_active: false }),
          }
        );

        const refund = await refundIfPossible(stripe, session, "booking_insert_conflict");
        return okIgnored(res, "booking_insert_conflict_refunded", {
          sessionId: session.id,
          status: bookingResp.status,
          body: body.slice(0, 400),
          refund,
        });
      }

      // Unknown failure => refund and 200 (don’t keep money without booking)
      const refund = await refundIfPossible(stripe, session, "booking_insert_failed");
      return okIgnored(res, "booking_insert_failed_refunded", {
        sessionId: session.id,
        status: bookingResp.status,
        body: body.slice(0, 500),
        refund,
      });
    }

    const bookingRow = Array.isArray(bookingResp.data) ? bookingResp.data[0] : null;

    // 7) Invalidate ALL offers for that exact slot (prevents future old-link attempts)
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

    // 8) Mark request booked (best-effort)
    await sbFetchJson(`${SUPABASE_URL}/rest/v1/booking_requests?id=eq.${encodeURIComponent(offerRow.request_id)}`, {
      method: "PATCH",
      headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
      body: JSON.stringify({ status: "booked" }),
    });

    return res.status(200).json({ received: true, bookingId: bookingRow?.id || null });
  } catch (err) {
    console.error("stripe-webhook unhandled error:", err);
    return res.status(500).json({
      ok: false,
      code: "unhandled_exception",
      message: err?.message || String(err),
    });
  }
};
