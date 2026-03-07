// /api/create-checkout-session.js
// DryerDudes checkout creator (UX improved, Stripe-form-encoded safe)

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function makeJobRef() {
  return `DD-${Date.now().toString().slice(-6)}`;
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

  const data = await resp.json().catch(() => ({}));
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

function humanMessageForStatus(status) {
  switch (status) {
    case "already_booked":
      return "That appointment option was already taken. Please pick another time.";
    case "inactive_offer":
      return "That appointment option is no longer active. Please pick another time.";
    case "offer_not_found":
      return "That appointment option is no longer available. Please pick another time.";
    case "invalid":
      return "That appointment option is invalid. Please pick another time.";
    default:
      return "That appointment option is no longer available. Please pick another time.";
  }
}

function formatDate(d) {
  try {
    return new Date(d).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return d;
  }
}

function formatTime(t) {
  if (!t) return "";
  const parts = String(t).split(":");
  if (parts.length < 2) return String(t);

  let h = Number(parts[0]);
  const mm = parts[1];
  const ampm = h >= 12 ? "PM" : "AM";

  h = h % 12;
  if (h === 0) h = 12;

  return `${h}:${mm} ${ampm}`;
}

module.exports = async function handler(req, res) {
  try {

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const token = String((req.body && req.body.token) || "").trim();
    const requestedType = String((req.body && req.body.appointment_type) || "standard").toLowerCase();

    if (!token) {
      return res.status(400).json({ ok: false, error: "missing_token" });
    }

    const origin = getOrigin(req);

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    // Validate offer using DB RPC
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/verify_offer_for_checkout`;

    const rpcResp = await sbFetchJson(rpcUrl, {
      method: "POST",
      headers: sbHeaders(SERVICE_ROLE),
      body: JSON.stringify({ p_token: token }),
    });

    if (!rpcResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "offer_verify_failed",
        message: "Could not validate that appointment option.",
        details: rpcResp.text,
      });
    }

    const row = Array.isArray(rpcResp.data) ? (rpcResp.data[0] || null) : null;

    if (!row) {
      return res.status(409).json({
        ok: false,
        error: "offer_not_found",
        message: "That appointment option is no longer available. Please pick another time.",
      });
    }

    const status = String(row.availability_status || "invalid");

    if (status !== "valid") {
      return res.status(409).json({
        ok: false,
        error: "offer_not_available",
        availability_status: status,
        message: humanMessageForStatus(status),
      });
    }

    const jobRef = makeJobRef();

    const dateText = formatDate(row.service_date);
    const timeText = `${formatTime(row.start_time)}–${formatTime(row.end_time)}`;

    // cleaner customer description
    const appointmentDescription = `${dateText} • ${timeText}`;

    // determine price
    const unitAmount = requestedType === "full_service" ? "10000" : "8000";

    const stripeBody = {
      mode: "payment",

      billing_address_collection: "auto",
      "phone_number_collection[enabled]": "true",

      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": "Dryer Dudes Repair Appointment",
      "line_items[0][price_data][product_data][description]": appointmentDescription,
      "line_items[0][price_data][unit_amount]": unitAmount,
      "line_items[0][quantity]": "1",

      success_url: `${origin}/payment-success.html?jobRef=${encodeURIComponent(jobRef)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?token=${encodeURIComponent(token)}`,
    };

    const meta = {
      jobRef,
      offer_token: token,
      appointment_type: requestedType
    };

    if (row.request_id) meta.request_id = String(row.request_id);
    if (row.offer_id) meta.offer_id = String(row.offer_id);
    if (row.slot_id) meta.slot_id = String(row.slot_id);
    if (row.zone_code) meta.zone_code = String(row.zone_code);
    if (row.service_date) meta.service_date = String(row.service_date);

    if (row.slot_index !== undefined && row.slot_index !== null) {
      meta.slot_index = String(row.slot_index);
    }

    for (const [k, v] of Object.entries(meta)) {
      stripeBody[`metadata[${k}]`] = v;
    }

    const session = await stripeFetch("checkout/sessions", stripeBody);

    return res.status(200).json({
      ok: true,
      url: session.url,
    });

  } catch (err) {

    console.error("create-checkout-session error:", err);

    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err && err.message ? err.message : String(err),
    });
  }
};
