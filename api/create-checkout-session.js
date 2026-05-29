// /api/create-checkout-session.js
// DryerDudes checkout creator

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

  if (!resp.ok) {
    throw new Error(`Stripe error: ${resp.status} ${JSON.stringify(data)}`);
  }

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

function addMeta(meta, key, value) {
  if (value === undefined || value === null) return;

  const s = String(value).trim();
  if (!s) return;

  // Stripe metadata values must be strings and should stay reasonably short.
  meta[key] = s.slice(0, 500);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const token = String((req.body && req.body.token) || "").trim();

    const requestedTypeRaw = String(
      (req.body && req.body.appointment_type) || "standard"
    ).toLowerCase();

    const requestedType =
      requestedTypeRaw === "full_service" ? "full_service" : "standard";

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
    const appointmentDescription = `${dateText} • ${timeText}`;

    const unitAmount = requestedType === "full_service" ? "10000" : "8000";

    // Fetch request info for Stripe prefill + webhook metadata
    let requestInfo = null;

    if (row.request_id) {
      const reqUrl =
        `${SUPABASE_URL}/rest/v1/booking_requests` +
        `?id=eq.${encodeURIComponent(row.request_id)}` +
        `&select=email,phone,address,name` +
        `&limit=1`;

      const reqResp = await sbFetchJson(reqUrl, {
        headers: sbHeaders(SERVICE_ROLE),
      });

      if (reqResp.ok && Array.isArray(reqResp.data) && reqResp.data.length) {
        requestInfo = reqResp.data[0];
      }
    }

    /*
      IMPORTANT:
      Do not encode {CHECKOUT_SESSION_ID}.
      Stripe replaces this exact placeholder after checkout.
    */
    const successUrl =
      `${origin}/payment-success.html?session_id={CHECKOUT_SESSION_ID}` +
      `&job_ref=${encodeURIComponent(jobRef)}` +
      `&jobRef=${encodeURIComponent(jobRef)}`;

    const cancelUrl = `${origin}/checkout.html?token=${encodeURIComponent(token)}`;

    const stripeBody = {
      mode: "payment",

      billing_address_collection: "auto",
      "phone_number_collection[enabled]": "true",
      customer_creation: "always",

      client_reference_id: jobRef,

      // Reassurance text shown near the payment confirmation button
      "custom_text[submit][message]":
        "• Today's payment covers diagnosis and all visits required for this repair • After booking, you only pay for any needed parts",

      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]":
        "Dryer Repair Visit — Diagnosis & Labor Included",
      "line_items[0][price_data][product_data][description]": appointmentDescription,
      "line_items[0][price_data][unit_amount]": unitAmount,
      "line_items[0][quantity]": "1",

      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    // Prefill email when available
    if (requestInfo && requestInfo.email) {
      stripeBody.customer_email = String(requestInfo.email).trim();
    }

    // Metadata for webhook / post-payment processing
    const meta = {};

    addMeta(meta, "jobRef", jobRef);
    addMeta(meta, "job_ref", jobRef);
    addMeta(meta, "offer_token", token);
    addMeta(meta, "appointment_type", requestedType);
    addMeta(meta, "amount_cents", unitAmount);
    addMeta(meta, "appointment_description", appointmentDescription);

    if (row.request_id) addMeta(meta, "request_id", row.request_id);
    if (row.offer_id) addMeta(meta, "offer_id", row.offer_id);
    if (row.slot_id) addMeta(meta, "slot_id", row.slot_id);
    if (row.zone_code) addMeta(meta, "zone_code", row.zone_code);
    if (row.service_date) addMeta(meta, "service_date", row.service_date);

    if (row.slot_index !== undefined && row.slot_index !== null) {
      addMeta(meta, "slot_index", row.slot_index);
    }

    if (row.start_time) addMeta(meta, "start_time", row.start_time);
    if (row.end_time) addMeta(meta, "end_time", row.end_time);

    if (requestInfo && requestInfo.address) {
      addMeta(meta, "address", requestInfo.address);
      addMeta(meta, "service_address", requestInfo.address);
    }

    if (requestInfo && requestInfo.email) {
      addMeta(meta, "email", requestInfo.email);
      addMeta(meta, "customer_email", requestInfo.email);
    }

    if (requestInfo && requestInfo.phone) {
      addMeta(meta, "phone", requestInfo.phone);
      addMeta(meta, "customer_phone", requestInfo.phone);
    }

    if (requestInfo && requestInfo.name) {
      addMeta(meta, "name", requestInfo.name);
      addMeta(meta, "customer_name", requestInfo.name);
    }

    for (const [k, v] of Object.entries(meta)) {
      stripeBody[`metadata[${k}]`] = v;
    }

    const session = await stripeFetch("checkout/sessions", stripeBody);

    return res.status(200).json({
      ok: true,
      url: session.url,
      jobRef,
      session_id: session.id || null,
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
