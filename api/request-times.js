// /api/request-times.js  (CommonJS, Vercel-safe)
// Creates booking_requests + booking_request_offers and sends customer options.
// Assumes:
// - /api/resolve-zone exists and returns { zone_code, zone_name, lat, lng, ... }
// - /api/get-available-slots exists and returns { primary: [...], more: { options:[...] } }
// - Supabase tables: booking_requests, booking_request_offers, zone_tech_assignments, tech_time_off (optional)
// - Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_SIGNING_SECRET
//
// NOTE: This file is intentionally CommonJS (require/module.exports) to avoid
// "Cannot use import statement outside a module" in Vercel.

const crypto = require("crypto");

// ---- fetch fallback (prevents Vercel crashes when global fetch is missing) ----
const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

// -------------------- helpers --------------------
function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signToken(payloadObj, secret) {
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${payload}.${sig}`;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getOrigin(req) {
  const site = String(process.env.SITE_ORIGIN || "").trim();
  if (site && /^https?:\/\//i.test(site)) return site.replace(/\/+$/, "");
  return `https://${req.headers.host}`;
}

function fmtDateMDY(iso) {
  const s = String(iso || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${Number(m[2])}/${Number(m[3])}/${Number(m[1])}`;
}

function fmtTime12h(t) {
  if (!t) return "";
  const raw = String(t).slice(0, 5); // HH:MM
  const m = raw.match(/^(\d{2}):(\d{2})$/);
  if (!m) return raw;
  let hh = Number(m[1]);
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${mm} ${ampm}`;
}

function formatSlotLine(s) {
  const date = fmtDateMDY(s.service_date);
  const start = s.start_time ? fmtTime12h(s.start_time) : "";
  const end = s.end_time ? fmtTime12h(s.end_time) : "";
  const window =
    start && end ? `${start}–${end}` : s.window_label ? String(s.window_label) : "Arrival window";
  return `${date} • ${window}`;
}

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])
  );
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

async function supabaseInsert({ table, row, serviceRole, supabaseUrl }) {
  const resp = await fetchFn(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!resp.ok) {
    throw new Error(`Supabase insert failed (${table}): ${resp.status} ${text?.slice(0, 800)}`);
  }
  return Array.isArray(data) ? data[0] : data;
}

async function supabaseInsertMany({ table, rows, serviceRole, supabaseUrl }) {
  const resp = await fetchFn(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!resp.ok) {
    throw new Error(`Supabase insertMany failed (${table}): ${resp.status} ${text?.slice(0, 800)}`);
  }
  return data;
}

async function getTechIdForZone({ zone, supabaseUrl, serviceRole }) {
  const url =
    `${supabaseUrl}/rest/v1/zone_tech_assignments` +
    `?zone_code=eq.${encodeURIComponent(zone)}` +
    `&select=tech_id&limit=1`;

  const r = await sbFetchJson(url, { headers: sbHeaders(serviceRole) });
  if (!r.ok) throw new Error(`zone_tech_assignments lookup failed: ${r.status} ${r.text}`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  return row?.tech_id || null;
}

// Optional: Twilio SMS (only runs if env vars exist)
async function sendSmsTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return { skipped: true, reason: "Twilio env vars not set" };

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const resp = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });

  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!resp.ok) return { skipped: false, ok: false, status: resp.status, data };
  return { skipped: false, ok: true, status: resp.status, data };
}

// Optional: Resend email (only runs if env var exists)
async function sendEmailResend({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true, reason: "RESEND_API_KEY not set" };

  const resp = await fetchFn("https://api.resend.com/emails", {
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

  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!resp.ok) return { skipped: false, ok: false, status: resp.status, data };
  return { skipped: false, ok: true, status: resp.status, data };
}

// -------------------- handler --------------------
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const b = req.body || {};
    const name = String(b.name || "").trim();
    const phone = String(b.phone || "").trim();
    const email = String(b.email || "").trim();
    const contact_method = String(b.contact_method || "text").toLowerCase(); // text|email|both
    const address = String(b.address || "").trim();

    // IMPORTANT: request-appointment-options sends: standard | full_service | no_one_home
    // get-available-slots expects: standard | parts | no_one_home (based on your current code)
    // We'll map full_service -> standard unless/until you add support in get-available-slots.
    let appointment_type = String(b.appointment_type || "standard").trim().toLowerCase();
    if (appointment_type === "full_service") appointment_type = "standard";

    if (!address) return res.status(400).json({ ok: false, error: "address is required" });

    const useText = contact_method === "text" || contact_method === "both";
    const useEmail = contact_method === "email" || contact_method === "both";
    if (useText && !phone) return res.status(400).json({ ok: false, error: "phone is required for text/both" });
    if (useEmail && !email) return res.status(400).json({ ok: false, error: "email is required for email/both" });

    const origin = getOrigin(req);

    // 1) Resolve zone from address
    const rzResp = await fetchFn(`${origin}/api/resolve-zone?address=${encodeURIComponent(address)}`);
    const rzText = await rzResp.text();
    let rz = {};
    try { rz = rzText ? JSON.parse(rzText) : {}; } catch { rz = { raw: rzText }; }

    if (!rzResp.ok) {
      return res.status(502).json({ ok: false, error: "resolve-zone failed", details: rz });
    }

    const zone = String(rz.zone_code || "").trim().toUpperCase();
    if (!zone) {
      return res.status(400).json({ ok: false, error: "Could not resolve zone for address", details: rz });
    }

    // 1.5) Require a tech assigned for that zone (your “root fix” rule)
    const techId = await getTechIdForZone({ zone, supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE });
    if (!techId) {
      return res.status(200).json({
        ok: true,
        zone,
        message: "No technician assigned for this zone yet.",
      });
    }

    // 2) Get candidate slots (time-off filtering happens inside get-available-slots now)
    const slotsUrl =
      `${origin}/api/get-available-slots?zone=${encodeURIComponent(zone)}&type=${encodeURIComponent(appointment_type)}`;

    const slotsResp = await fetchFn(slotsUrl);
    const slotsText = await slotsResp.text();
    let slotsJson = {};
    try { slotsJson = slotsText ? JSON.parse(slotsText) : {}; } catch { slotsJson = { raw: slotsText }; }

    if (!slotsResp.ok) {
      return res.status(502).json({ ok: false, error: "get-available-slots failed", details: slotsJson });
    }

    const primary = Array.isArray(slotsJson.primary) ? slotsJson.primary : [];
    const moreOptions = Array.isArray(slotsJson?.more?.options) ? slotsJson.more.options : [];

    if (primary.length < 1) {
      return res.status(200).json({
        ok: true,
        zone,
        message: "No appointment options available right now.",
        details: slotsJson,
      });
    }

    // 3) Store request
    const requestRow = await supabaseInsert({
      table: "booking_requests",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      row: {
        name: name || null,
        phone: phone || null,
        email: email || null,
        contact_method,
        address,
        appointment_type,
        lat: typeof rz.lat === "number" ? rz.lat : null,
        lng: typeof rz.lng === "number" ? rz.lng : null,
        zone_code: zone,
        zone_name: rz.zone_name || null,
        status: "sent",
      },
    });

    const requestId = requestRow?.id;
    if (!requestId) throw new Error("booking_requests insert did not return an id");

    // 4) Create offer tokens + store offers
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 3; // 3 days
    const offersToStore = [];

    function makeOffer(slot, group) {
      const payload = {
        v: 1,
        request_id: requestId,
        appointment_type,
        zone: (slot.zone_code || zone),
        service_date: slot.service_date,
        slot_index: slot.slot_index,
        exp: expiresAt,
      };

      const token = signToken(payload, TOKEN_SECRET);

      offersToStore.push({
        request_id: requestId,
        offer_group: group,
        service_date: slot.service_date,
        slot_index: slot.slot_index,
        zone_code: slot.zone_code || zone,
        window_label: slot.window_label || null,
        start_time: slot.start_time || null,
        end_time: slot.end_time || null,
        offer_token: token,
        is_active: true,
        // If you added tech_id on booking_request_offers, uncomment this:
        // tech_id: techId,
      });

      return { ...slot, offer_token: token };
    }

    const primaryWithTokens = primary.slice(0, 3).map((s) => makeOffer(s, "primary"));
    const moreWithTokens = moreOptions.map((s) => makeOffer(s, "more"));

    await supabaseInsertMany({
      table: "booking_request_offers",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      rows: offersToStore,
    });

    const requestToken = signToken({ v: 1, request_id: requestId, exp: expiresAt, kind: "request" }, TOKEN_SECRET);

    // 5) Build message content
    const selectBase = `${origin}/checkout.html?token=`;

    const lines = primaryWithTokens.map((s, i) => {
      return `Option ${i + 1}: ${formatSlotLine(s)}\n${selectBase}${encodeURIComponent(s.offer_token)}`;
    });

    const moreLink =
      slotsJson?.more?.show_no_one_home_cta
        ? `${origin}/more-options.html?request=${encodeURIComponent(requestId)}`
        : "";

    const smsBody =
      `Dryer Dudes — your best appointment options:\n\n` +
      lines.join("\n\n") +
      (moreLink ? `\n\nMore options: ${moreLink}` : "") +
      `\n\nReply STOP to opt out.`;

    const niceName = name || "there";
    const emailSubject = "Your Dryer Dudes appointment options";

    const emailHtml =
      `<p>Hi ${escHtml(niceName)},</p>` +
      `<p>Here are your appointment options (each is an <strong>arrival window</strong>):</p>` +
      `<ol>` +
      primaryWithTokens
        .map((s) => {
          const line = escHtml(formatSlotLine(s));
          const link = `${selectBase}${encodeURIComponent(s.offer_token)}`;
          return `<li style="margin:10px 0;"><strong>${line}</strong><br/><a href="${link}">Select this option</a></li>`;
        })
        .join("") +
      `</ol>` +
      (moreLink ? `<p><a href="${moreLink}">View more options</a></p>` : "") +
      `<p style="opacity:.85;">Reminder: the technician can arrive any time within the window.</p>` +
      `<p>— Dryer Dudes</p>`;

    // 6) Send (or skip) — never let delivery failures crash scheduling
    let smsResult = { skipped: true };
    let emailResult = { skipped: true };

    if (useText) {
      try {
        smsResult = await sendSmsTwilio({ to: phone, body: smsBody });
      } catch (e) {
        smsResult = { skipped: false, ok: false, error: e?.message || String(e) };
      }
    }

    if (useEmail) {
      try {
        emailResult = await sendEmailResend({ to: email, subject: emailSubject, html: emailHtml });
      } catch (e) {
        emailResult = { skipped: false, ok: false, error: e?.message || String(e) };
      }
    }

    return res.status(200).json({
      ok: true,
      request_id: requestId,
      token: requestToken,
      zone,
      appointment_type,
      primary: primaryWithTokens,
      more: { ...slotsJson.more, options: moreWithTokens },
      delivery: { smsResult, emailResult },
    });
  } catch (err) {
    // Always return JSON (prevents "Upstream returned non-JSON")
    return res.status(500).json({
      ok: false,
      error: "request-times crashed",
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 4000) : null,
    });
  }
};

