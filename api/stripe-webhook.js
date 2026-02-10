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

// OPTIONAL: if you want to populate bookings.window_start/window_end (timestamptz)
// This makes a timestamp like "2026-02-12T10:00:00-08:00"
// If you don't need these fields yet, you can leave them null IF your DB allows null.
function makeLocalTimestamptz(service_date, hhmm, offset = "-08:00") {
  if (!service_date || !hhmm) return null;
  const t = String(hhmm).slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(t)) return null;
  return `${service_date}T${t}:00${offset}`;
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

    const origin = getOrigin(req);

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const m = session.metadata || {};

        const offerToken = String(m.offer_token || m.offerToken || "").trim();
        const jobRef = String(m.jobRef || m.jobref || m.job_reference || "").trim() || null;

        const customerEmail =
          session.customer_details?.email ||
          session.customer_email ||
          null;

        const safeEmail = customerEmail ? String(customerEmail).trim() : "";

        if (!offerToken) {
          console.error("Webhook: missing offer_token metadata", { sessionId: session.id, jobRef });
          break;
        }

        // ---- Idempotency: if we already processed this Stripe session, stop. ----
        const existingUrl =
          `${SUPABASE_URL}/rest/v1/bookings` +
          `?stripe_checkout_session_id=eq.${encodeURIComponent(session.id)}` +
          `&select=id&limit=1`;

        const existingResp = await sbFetchJson(existingUrl, { headers: sbHeaders(SERVICE_ROLE) });
        const existing = Array.isArray(existingResp.data) ? existingResp.data[0] : null;
        if (existing) {
          console.log("Webhook: already processed stripe session", { sessionId: session.id });
          break;
        }

        // 1) Load offer row (IMPORTANT: do NOT select appointment_type here)
        const offerUrl =
          `${SUPABASE_URL}/rest/v1/booking_request_offers` +
          `?offer_token=eq.${encodeURIComponent(offerToken)}` +
          `&select=id,request_id,offer_token,is_active,service_date,slot_index,zone_code,start_time,end_time,window_label`;

        const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });
        const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;

        if (!offerResp.ok || !offerRow) {
          console.error("Webhook: offer fetch failed", {
            status: offerResp.status,
            body: offerResp.text,
            sessionId: session.id,
            offerToken,
          });
          break;
        }

        if (offerRow.is_active === false) {
          console.warn("Webhook: offer already inactive (slot taken)", {
            sessionId: session.id,
            offerToken,
          });
          break;
        }

        // 2) Load booking request to get appointment_type (since offers table doesn't have it)
        const reqUrl =
          `${SUPABASE_URL}/rest/v1/booking_requests` +
          `?id=eq.${encodeURIComponent(offerRow.request_id)}` +
          `&select=id,appointment_type&limit=1`;

        const reqResp = await sbFetchJson(reqUrl, { headers: sbHeaders(SERVICE_ROLE) });
        const reqRow = Array.isArray(reqResp.data) ? reqResp.data[0] : null;

        if (!reqResp.ok || !reqRow) {
          console.error("Webhook: booking_request fetch failed", {
            status: reqResp.status,
            body: reqResp.text,
            sessionId: session.id,
            requestId: offerRow.request_id,
          });
          break;
        }

        const slotCode = computeSlotCode(offerRow.service_date, offerRow.slot_index);
        const zoneCode = String(offerRow.zone_code || "");
        const apptType = String(reqRow.appointment_type || "standard");

        // If your bookings.window_start/window_end allow NULL, you can leave them null.
        // If they are NOT NULL, set them using service_date + start/end time.
        // NOTE: This uses a fixed offset; if you want DST-correct, we can do that next.
        const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");
        const windowStart = makeLocalTimestamptz(offerRow.service_date, offerRow.start_time, tzOffset);
        const windowEnd = makeLocalTimestamptz(offerRow.service_date, offerRow.end_time, tzOffset);

        // 3) GLOBAL LOCK via bookings insert
        const amountTotalCents =
          typeof session.amount_total === "number" ? session.amount_total : null;

        const bookingInsert = {
          request_id: offerRow.request_id,
          selected_option_id: offerRow.id,

          // If your DB allows null, these can be null.
          // If NOT NULL, the computed windowStart/windowEnd will satisfy it.
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
          console.error("Webhook: booking insert failed (this is why bookings stays empty)", {
            status: bookingResp.status,
            body: bookingResp.text,
            sessionId: session.id,
            slotCode,
            zoneCode,
            apptType,
            bookingInsert,
          });
          break;
        }

        console.log("Webhook: booking inserted", {
          sessionId: session.id,
          bookingId: Array.isArray(bookingResp.data) ? bookingResp.data?.[0]?.id : undefined,
          slotCode,
          zoneCode,
          apptType,
        });

        // 4) GLOBAL INVALIDATION: flip is_active for all offers with same slot (across ALL requests)
        // IMPORTANT: do NOT filter appointment_type here (offers table doesn't have it)
        const invalidateUrl =
          `${SUPABASE_URL}/rest/v1/booking_request_offers` +
          `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
          `&service_date=eq.${encodeURIComponent(offerRow.service_date)}` +
          `&slot_index=eq.${encodeURIComponent(offerRow.slot_index)}`;

        const invalResp = await sbFetchJson(invalidateUrl, {
          method: "PATCH",
          headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
          body: JSON.stringify({ is_active: false }),
        });

        if (!invalResp.ok) {
          console.error("Webhook: offer invalidation failed", {
            status: invalResp.status,
            body: invalResp.text,
            sessionId: session.id,
          });
          // Don't break; booking is already locked, email can still go out.
        }

        // 5) mark the winning request as booked (optional)
        const reqPatchUrl =
          `${SUPABASE_URL}/rest/v1/booking_requests?id=eq.${encodeURIComponent(offerRow.request_id)}`;

        await sbFetchJson(reqPatchUrl, {
          method: "PATCH",
          headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
          body: JSON.stringify({ status: "booked" }),
        });

        // 6) send booking email (only after booking insert succeeded)
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

          try {
            const r = await fetch(`${origin}/api/send-booking-email`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });

            const text = await r.text();
            if (!r.ok) {
              console.error("Webhook -> send-booking-email failed", {
                status: r.status,
                body: text,
                jobRef,
                sessionId: session.id,
              });
            } else {
              console.log("Webhook -> booking email sent", { sessionId: session.id, jobRef });
            }
          } catch (e) {
            console.error("Webhook fetch error calling send-booking-email", e);
          }
        } else {
          console.warn("Webhook: no customer email available; email skipped", { sessionId: session.id });
        }

        break;
      }

      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
        break;

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("stripe-webhook error:", err);
    return res.status(500).json({
      error: "Webhook server error",
      message: err?.message || String(err),
    });
  }
}
