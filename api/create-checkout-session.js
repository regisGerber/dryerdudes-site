// /api/create-checkout-session.js (FULL REPLACEMENT — CommonJS)
// Bulletproof gatekeeper BEFORE Stripe Checkout:
// - validates offer token exists + active
// - validates not expired
// - validates slot not already booked (multiple statuses)
// - validates slot not started yet
// - validates tech not on time off (slot exact OR overlap for am/pm/all_day)
// - deactivates offer when invalid so old links die fast
// - creates Stripe session ONLY if valid
// - ensures Stripe has an email for receipts (customer_email + customer_creation)

const crypto = require("crypto");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function makeJobRef() {
  return `DD-${Date.now().toString().slice(-6)}`;
}

function base64urlToString(b64url) {
  const s = String(b64url || "");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

function sign(payloadB64url, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(payloadB64url)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function parseAndVerifyToken(token, secret) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 2) return { ok: false, code: "bad_token_format" };
  const [payloadB64url, sig] = parts;

  const expected = sign(payloadB64url, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return { ok: false, code: "bad_signature" };
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return { ok: false, code: "bad_signature" };

  let payload;
  try {
    payload = JSON.parse(base64urlToString(payloadB64url));
  } catch {
    return { ok: false, code: "bad_payload" };
  }

  if (payload?.exp && Date.now() > Number(payload.exp)) {
    return { ok: false, code: "expired", payload };
  }

  return { ok: true, payload };
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

// Treat schedule slots as Pacific
const SCHED_TZ = "America/Los_Angeles";

function dtPartsInTZ(d, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}:${map.second}`,
  };
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

function toMs(isoString) {
  const d = new Date(isoString);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function rangesOverlapMs(aStartMs, aEndMs, bStartMs, bEndMs) {
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

function computeSlotCode(service_date, slot_index) {
  return `${service_date}#${slot_index}`;
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

async function deactivateOfferByToken({ supabaseUrl, serviceRole, token }) {
  const url = `${supabaseUrl}/rest/v1/booking_request_offers?offer_token=eq.${encodeURIComponent(token)}`;
  await sbFetchJson(url, {
    method: "PATCH",
    headers: { ...sbHeaders(serviceRole), Prefer: "return=minimal" },
    body: JSON.stringify({ is_active: false }),
  });
}

async function invalidateAllOffersForSlot({ supabaseUrl, serviceRole, zoneCode, serviceDate, slotIndex }) {
  // Optional “nuke the slot’s offers” so ANY old link for that slot dies.
  const url =
    `${supabaseUrl}/rest/v1/booking_request_offers` +
    `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
    `&service_date=eq.${encodeURIComponent(serviceDate)}` +
    `&slot_index=eq.${encodeURIComponent(slotIndex)}`;
  await sbFetchJson(url, {
    method: "PATCH",
    headers: { ...sbHeaders(serviceRole), Prefer: "return=minimal" },
    body: JSON.stringify({ is_active: false }),
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const { token } = req.body || {};
    const tokenStr = String(token || "").trim();
    if (!tokenStr) return res.status(400).json({ ok: false, error: "missing_token" });

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");

    const origin = getOrigin(req);

    // 0) Verify token signature + exp (fast fail)
    const tv = parseAndVerifyToken(tokenStr, TOKEN_SECRET);
    if (!tv.ok) {
      // expire -> 410, others -> 409
      const status = tv.code === "expired" ? 410 : 409;
      return res.status(status).json({
        ok: false,
        error: tv.code,
        message: tv.code === "expired" ? "This link has expired. Please start over." : "This link is not valid. Please start over.",
      });
    }

    // 1) Load offer row
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(tokenStr)}` +
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

    const zoneCode = String(offerRow.zone_code || "").toUpperCase();
    const serviceDate = String(offerRow.service_date || "");
    const slotIndex = Number(offerRow.slot_index);

    // 2) Compute window timestamps (required)
    const windowStart = makeLocalTimestamptz(serviceDate, offerRow.start_time, tzOffset);
    const windowEnd = makeLocalTimestamptz(serviceDate, offerRow.end_time, tzOffset);

    if (!windowStart || !windowEnd) {
      await deactivateOfferByToken({ supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, token: tokenStr });
      return res.status(409).json({
        ok: false,
        error: "bad_offer_times",
        message: "That appointment option is invalid. Please pick another time.",
      });
    }

    // 3) Block if slot already started (Pacific time)
    const nowMs = Date.now();
    const startMs = toMs(windowStart);
    if (startMs != null && nowMs >= startMs) {
      await invalidateAllOffersForSlot({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        zoneCode,
        serviceDate,
        slotIndex,
      });
      return res.status(409).json({
        ok: false,
        error: "slot_started",
        message: "That appointment window has already started. Please choose a different time.",
      });
    }

    // 4) Block if slot already booked (use slot_code + broader statuses)
    const slotCode = computeSlotCode(serviceDate, slotIndex);
    const BOOKED_STATUSES = ["scheduled", "en_route", "on_site", "completed"];

    // Prefer slot_code check (matches your webhook)
    const conflictUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&slot_code=eq.${encodeURIComponent(slotCode)}` +
      `&status=in.(${BOOKED_STATUSES.map((s) => `"${s}"`).join(",")})` +
      `&select=id&limit=1`;

    const conflictResp = await sbFetchJson(conflictUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const conflictRow = Array.isArray(conflictResp.data) ? conflictResp.data[0] : null;

    if (!conflictResp.ok) {
      // If we can't verify, fail closed (don’t charge)
      return res.status(500).json({
        ok: false,
        error: "availability_check_failed",
        message: "Could not verify availability. Please try again.",
      });
    }

    if (conflictRow) {
      await invalidateAllOffersForSlot({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        zoneCode,
        serviceDate,
        slotIndex,
      });
      return res.status(409).json({
        ok: false,
        error: "slot_already_booked",
        message: "That appointment option was already taken. Please pick another time.",
      });
    }

    // 5) Block if tech is on time off for that window
    // Lookup assigned tech for this zone
    const techUrl =
      `${SUPABASE_URL}/rest/v1/zone_tech_assignments` +
      `?zone_code=eq.${encodeURIComponent(zoneCode)}` +
      `&select=tech_id&limit=1`;

    const techResp = await sbFetchJson(techUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const techRow = Array.isArray(techResp.data) ? techResp.data[0] : null;
    const techId = techRow?.tech_id ? String(techRow.tech_id) : null;

    if (!techResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "tech_lookup_failed",
        message: "Could not verify availability. Please try again.",
      });
    }

    // If no tech assigned, fail closed (don’t let them pay)
    if (!techId) {
      await invalidateAllOffersForSlot({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        zoneCode,
        serviceDate,
        slotIndex,
      });
      return res.status(409).json({
        ok: false,
        error: "no_tech_assigned",
        message: "That appointment option is not available right now. Please choose a different time.",
      });
    }

    const offUrl =
      `${SUPABASE_URL}/rest/v1/tech_time_off` +
      `?tech_id=eq.${encodeURIComponent(techId)}` +
      `&end_ts=gte.${encodeURIComponent(windowStart)}` +
      `&start_ts=lte.${encodeURIComponent(windowEnd)}` +
      `&select=start_ts,end_ts,type`;

    const offResp = await sbFetchJson(offUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const offRows = Array.isArray(offResp.data) ? offResp.data : [];

    if (!offResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "time_off_check_failed",
        message: "Could not verify availability. Please try again.",
      });
    }

    const wStartMs = toMs(windowStart);
    const wEndMs = toMs(windowEnd);

    const slotIsOff =
      wStartMs != null &&
      wEndMs != null &&
      offRows.some((o) => {
        const os = o?.start_ts ? toMs(o.start_ts) : null;
        const oe = o?.end_ts ? toMs(o.end_ts) : null;
        if (os == null || oe == null) return false;

        const t = String(o?.type || "").toLowerCase();
        if (t === "slot") {
          return os === wStartMs && oe === wEndMs;
        }
        return rangesOverlapMs(wStartMs, wEndMs, os, oe);
      });

    if (slotIsOff) {
      await invalidateAllOffersForSlot({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        zoneCode,
        serviceDate,
        slotIndex,
      });
      return res.status(409).json({
        ok: false,
        error: "tech_unavailable",
        message: "That appointment option is no longer available. Please pick another time.",
      });
    }

    // 6) Fetch booking request to get customer email/address for Stripe receipts + metadata
    const reqUrl =
      `${SUPABASE_URL}/rest/v1/booking_requests` +
      `?id=eq.${encodeURIComponent(offerRow.request_id)}` +
      `&select=id,name,email,phone,address,appointment_type&limit=1`;

    const reqResp = await sbFetchJson(reqUrl, { headers: sbHeaders(SERVICE_ROLE) });
    const reqRow = Array.isArray(reqResp.data) ? reqResp.data[0] : null;

    const customerEmail = reqRow?.email ? String(reqRow.email).trim() : "";
    const customerName = reqRow?.name ? String(reqRow.name).trim() : "";
    const customerAddress = reqRow?.address ? String(reqRow.address).trim() : "";
    const apptType = reqRow?.appointment_type ? String(reqRow.appointment_type) : "";

    // 7) Create Stripe Checkout session (ONLY now)
    const jobRef = makeJobRef();

    const session = await stripeFetch("checkout/sessions", {
      mode: "payment",

      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": "Dryer Dudes — Dryer Repair Appointment",
      "line_items[0][price_data][unit_amount]": "8000",
      "line_items[0][quantity]": "1",

      // ✅ Make sure Stripe has an email for receipts
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      customer_creation: "always",

      // Optional but helps data quality + receipts consistency
      billing_address_collection: "required",

      success_url: `${origin}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?token=${encodeURIComponent(tokenStr)}`,

      "metadata[offer_token]": tokenStr,
      "metadata[jobRef]": jobRef,
      "metadata[request_id]": String(offerRow.request_id),
      "metadata[zone]": zoneCode,
      "metadata[service_date]": serviceDate,
      "metadata[slot_index]": String(slotIndex),
      "metadata[address]": customerAddress,
      "metadata[name]": customerName,
      "metadata[appointment_type]": apptType,
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
};
