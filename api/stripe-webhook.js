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

        // ---- Idempotency: if we already inserted this Stripe session, stop. ----
        const existingUrl =
          `${SUPABASE_URL}/rest/v1/bookings` +
          `?stripe_checkout_session_id=eq.${encodeURIComponent(session.id)}` +
          `&select=id&limit=1`;

        const existingResp = await sbFetchJson(existingUrl, { headers: sbHeaders(SERVICE_ROLE) });
        const existing = Array.isArray(existingResp.data) ? existingResp.data[0] : null;
        if (existing) {
          // already processed (Stripe retry)
          break;
        }

        // 1) Load offer row (NO slot_code on offers table)
        const offerUrl =
          `${SUPABASE_URL}/rest/v1/booking_request_offers` +
          `?offer_token=eq.${encodeURIComponent(offerToken)}` +
          `&select=id,request_id,offer_token,is_active,service_date,slot_index,zone_code,start_time,end_time,window_label,appointment_type`;

        const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });
        const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;

        if (!offerResp.ok || !offerRow) {
          console.error("Webhook: offer not found / supabase error", {
            status: offerResp.status,
            body: offerResp.text,
            sessionId: session.id,
          });
          break;
        }

        // If offer is inactive, that means slot was taken earlier.
        if (offerRow.is_active === false) {
          console.warn("Webhook: offer already inactive (slot taken)", {
            sessionId: session.id,
            offerToken,
          });
          break;
        }

        const slotCode = computeSlotCode(offerRow.service_date, offerRow.slot_index);
        const zoneCode = String(offerRow.zone_code || "");
        const apptType = String(offerRow.appointment_type || "standard");

        // 2) GLOBAL LOCK via bookings insert (unique should be zone+appt+slot_code)
        const amountTotalCents =
          typeof session.amount_total === "number" ? session.amount_total : null;

        const bookingInsert = {
          request_id: offerRow.request_id,
          selected_option_id: offerRow.id,

          window_start: offerRow.start_time ? null : null, // keep null (you don't currently store exact timestamp start here)
          window_end: offerRow.end_time ? null : null,     // (you DO store window_start/window_end in bookings table already; if you want, we can set these precisely later)

          slot_code: slotCode,
          zone_code: zoneCode,
          appointment_type: apptType,

          payment_status: "paid",
          collected_cents: amountTotalCents,

          stripe_checkout_session_id: session.id || null,
          stripe_payment_intent_id: session.payment_intent || null,

          status: "booked",
        };

        // NOTE: We are not setting window_start/window_end because your offers store start_time/end_time (time-only),
        // while bookings expects timestamps. If you want, we can convert service_date + start_time into a timestamp.

        const bookingResp = await sbFetchJson(`${SUPABASE_URL}/rest/v1/bookings`, {
          method: "POST",
          headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=representation" },
          body: JSON.stringify(bookingInsert),
        });

        if (!bookingResp.ok) {
          console.error("Webhook: booking insert failed (slot likely already booked)", {
            status: bookingResp.status,
            body: bookingResp.text,
            sessionId: session.id,
            slotCode,
            zoneCode,
            apptType,
          });
          break;
        }

        // 3) GLOBAL INVALIDATION: flip is_active for all offers with same slot (across ALL requests)
        const invalidateUrl =
          `${SUPABASE_URL}/rest/v1/booking_request_offers` +
          `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
          `&appointment_type=eq.${encodeURIComponent(apptType)}` +
          `&service_date=eq.${encodeURIComponent(offerRow.service_date)}` +
          `&slot_index=eq.${encodeURIComponent(offerRow.slot_index)}`;

        await sbFetchJson(invalidateUrl, {
          method: "PATCH",
          headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
          body: JSON.stringify({ is_active: false }),
        });

        // 4) mark the winning request as booked (optional)
        const reqPatchUrl =
          `${SUPABASE_URL}/rest/v1/booking_requests?id=eq.${encodeURIComponent(offerRow.request_id)}`;

        await sbFetchJson(reqPatchUrl, {
          method: "PATCH",
          headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "return=minimal" },
          body: JSON.stringify({ status: "booked" }),
        });

        // 5) send booking email
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
            }
          } catch (e) {
            console.error("Webhook fetch error calling send-booking-email", e);
          }
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
