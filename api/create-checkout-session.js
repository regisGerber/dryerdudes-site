// /api/create-checkout-session.js (FULL REPLACEMENT)
import crypto from "crypto";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function makeJobRef() {
  return `DD-${Date.now().toString().slice(-6)}`;
}

async function stripeFetch(path, bodyObj) {
  const key = requireEnv("STRIPE_SECRET_KEY");

  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(bodyObj),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`Stripe error: ${resp.status} ${JSON.stringify(data)}`);
  return data;
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
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data, text };
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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

    const origin = `https://${req.headers.host}`;

    // Supabase envs for validation gate
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    // 1) Load offer by offer_token
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(String(token))}` +
      `&select=id,request_id,is_active,service_date,slot_index,zone_code,start_time,end_time,window_label` +
      `&limit=1`;

    const offerResp = await sbFetchJson(offerUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const offerRow = Array.isArray(offerResp.data) ? offerResp.data[0] : null;

    if (!offerResp.ok || !offerRow) {
      return res.status(409).json({
        ok: false,
        error: "offer_not_found",
        message: "That appointment option is no longer available. Please pick another time.",
      });
    }

    if (offerRow.is_active === false) {
      return res.status(409).json({
        ok: false,
        error: "offer_inactive",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    // 2) Check bookings table for same exact window+zone already scheduled
    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");
    const windowStart = makeLocalTimestamptz(offerRow.service_date, offerRow.start_time, tzOffset);
    const windowEnd = makeLocalTimestamptz(offerRow.service_date, offerRow.end_time, tzOffset);

    if (!windowStart || !windowEnd) {
      return res.status(409).json({
        ok: false,
        error: "bad_offer_times",
        message: "That appointment option is invalid. Please pick another time.",
      });
    }

    const checkUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(String(offerRow.zone_code || ""))}` +
      `&status=eq.scheduled` +
      `&window_start=eq.${encodeURIComponent(windowStart)}` +
      `&window_end=eq.${encodeURIComponent(windowEnd)}` +
      `&select=id&limit=1`;

    const checkResp = await sbFetchJson(checkUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const existingBooking = Array.isArray(checkResp.data) ? checkResp.data[0] : null;

    if (checkResp.ok && existingBooking) {
      return res.status(409).json({
        ok: false,
        error: "slot_already_booked",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    // 3) Create Stripe Checkout session
    const jobRef = makeJobRef();

    const session = await stripeFetch("checkout/sessions", {
      mode: "payment",

      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": "Dryer Dudes — Dryer Repair Appointment",
      "line_items[0][price_data][unit_amount]": "8000",
      "line_items[0][quantity]": "1",

      success_url: `${origin}/payment-success.html?jobRef=${encodeURIComponent(jobRef)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?token=${encodeURIComponent(token)}`,

      "metadata[jobRef]": jobRef,
      "metadata[offer_token]": String(token),
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || String(err),
    });
  }
}
