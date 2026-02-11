// /api/request-times.js (FULL REPLACEMENT)
import crypto from "crypto";

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
  if (site) return site.replace(/\/+$/, "");
  return `https://${req.headers.host}`;
}

function fmtDateMDY(iso) {
  const s = String(iso || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return `${mo}/${d}/${y}`;
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
  const window = start && end ? `${start}–${end}` : (s.window_label ? String(s.window_label) : "Arrival window");
  return `${date} • ${window}`;
}

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
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

// Safer: compare booking windows in epoch ms (UTC)
function toMs(isoString) {
  const d = new Date(isoString);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
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

async function supabaseInsert({ table, row, serviceRole, supabaseUrl }) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`Supabase insert failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }
  return data?.[0] ?? null;
}

async function supabaseInsertMany({ table, rows, serviceRole, supabaseUrl }) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`Supabase insertMany failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// Optional: Twilio SMS (only runs if env vars exist)
async function sendSmsTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return { skipped: true, reason: "Twilio env vars not set" };

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return { skipped: false, ok: false, status: resp.status, data };
  return { skipped: false, ok: true, status: resp.status, data };
}

// Optional: Resend email (only runs if env var exists)
async function sendEmailResend({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true, reason: "RESEND_API_KEY not set" };

  const resp = await fetch("https://api.resend.com/emails", {
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

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return { skipped: false, ok: false, status: resp.status, data };
  return { skipped: false, ok: true, status: resp.status, data };
}

// -------------------- handler --------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const {
      name = "",
      phone = "",
      email = "",
      contact_method = "text", // text | email | both
      address = "",
      appointment_type = "standard", // standard | full_service | no_one_home | parts_in
    } = req.body || {};

    const cleanAddress = String(address || "").trim();
    if (!cleanAddress) return res.status(400).json({ error: "address is required" });

    const cm = String(contact_method || "text").toLowerCase();
    const useText = cm === "text" || cm === "both";
    const useEmail = cm === "email" || cm === "both";

    if (useText && !String(phone).trim()) return res.status(400).json({ error: "phone is required for text/both" });
    if (useEmail && !String(email).trim()) return res.status(400).json({ error: "email is required for email/both" });

    const origin = getOrigin(req);

    // 1) Resolve zone from address
    const rzResp = await fetch(`${origin}/api/resolve-zone?address=${encodeURIComponent(cleanAddress)}`);
    const rz = await rzResp.json().catch(() => ({}));
    if (!rzResp.ok) return res.status(502).json({ error: "resolve-zone failed", details: rz });

    const zone = rz.zone_code;
    if (!zone) return res.status(400).json({ error: "Could not resolve zone for address", details: rz });

    // 2) Get candidate slots
    const slotsResp = await fetch(
      `${origin}/api/get-available-slots?zone=${encodeURIComponent(zone)}&type=${encodeURIComponent(appointment_type)}`
    );
    const slotsJson = await slotsResp.json().catch(() => ({}));
    if (!slotsResp.ok) return res.status(502).json({ error: "get-available-slots failed", details: slotsJson });

    let primary = Array.isArray(slotsJson.primary) ? slotsJson.primary : [];
    let moreOptions = Array.isArray(slotsJson.more?.options) ? slotsJson.more.options : [];

    if (primary.length < 1) {
      return res.status(200).json({
        ok: true,
        zone,
        message: "No appointment options available right now.",
        details: slotsJson,
      });
    }

    // 2.5) FILTER OUT SLOTS ALREADY IN BOOKINGS (status='scheduled')
    // We do this by comparing window_start/window_end timestamps.
    const tzOffset = String(process.env.LOCAL_TZ_OFFSET || "-08:00");

    // Collect distinct service_dates present in candidates
    const datesSet = new Set(
      [...primary, ...moreOptions].map((s) => String(s.service_date || "").trim()).filter(Boolean)
    );
    const dates = Array.from(datesSet);

    // Fetch bookings for each date (small list)
    const bookedWindows = []; // [{date, startMs, endMs}]
    for (const d of dates) {
      // Create a local midnight range for that day
      const dayStartIso = `${d}T00:00:00${tzOffset}`;
      const nextDay = new Date(`${d}T00:00:00${tzOffset}`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const dayEndIso = nextDay.toISOString(); // UTC ISO

      // We can filter by window_start >= dayStartIso and < dayEndIso
      // NOTE: PostgREST accepts ISO timestamps in filters.
      const url =
        `${SUPABASE_URL}/rest/v1/bookings` +
        `?zone_code=eq.${encodeURIComponent(zone)}` +
        `&status=eq.scheduled` +
        `&window_start=gte.${encodeURIComponent(dayStartIso)}` +
        `&window_start=lt.${encodeURIComponent(dayEndIso)}` +
        `&select=window_start,window_end`;

      const r = await sbFetchJson(url, { headers: sbHeaders(SERVICE_ROLE) });
      if (r.ok && Array.isArray(r.data)) {
        for (const b of r.data) {
          const sMs = toMs(b.window_start);
          const eMs = toMs(b.window_end);
          if (sMs != null && eMs != null) {
            bookedWindows.push({ date: d, startMs: sMs, endMs: eMs });
          }
        }
      }
    }

    function isBooked(slot) {
      const d = String(slot.service_date || "").trim();
      const sIso = makeLocalTimestamptz(d, slot.start_time, tzOffset);
      const eIso = makeLocalTimestamptz(d, slot.end_time, tzOffset);
      const sMs = sIso ? toMs(sIso) : null;
      const eMs = eIso ? toMs(eIso) : null;
      if (sMs == null || eMs == null) return false;

      // Exact-match block (same window). If you want “overlap blocks”, change this logic.
      return bookedWindows.some((b) => b.date === d && b.startMs === sMs && b.endMs === eMs);
    }

    primary = primary.filter((s) => !isBooked(s));
    moreOptions = moreOptions.filter((s) => !isBooked(s));

    if (primary.length < 1) {
      return res.status(200).json({
        ok: true,
        zone,
        message: "No appointment options available right now (all candidates were already booked).",
        details: slotsJson,
      });
    }

    // 3) Store request
    const requestRow = await supabaseInsert({
      table: "booking_requests",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      row: {
        name: String(name || "").trim() || null,
        phone: String(phone || "").trim() || null,
        email: String(email || "").trim() || null,
        contact_method: cm,
        address: cleanAddress,
        appointment_type: String(appointment_type || "standard"),
        lat: typeof rz.lat === "number" ? rz.lat : null,
        lng: typeof rz.lng === "number" ? rz.lng : null,
        zone_code: rz.zone_code || null,
        zone_name: rz.zone_name || null,
        status: "sent",
      },
    });

    const requestId = requestRow.id;

    // 4) Create offer tokens + store offers
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 3; // 3 days
    const offersToStore = [];

    function makeOffer(slot, group) {
      const payload = {
        v: 1,
        request_id: requestId,
        appointment_type,
        zone: slot.zone_code || zone,
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
        is_active: true, // ✅ important (explicit)
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
      slotsJson.more?.show_no_one_home_cta
        ? `${origin}/more-options.html?request=${encodeURIComponent(requestId)}`
        : "";

    const smsBody =
      `Dryer Dudes — your best appointment options:\n\n` +
      lines.join("\n\n") +
      (moreLink ? `\n\nMore options: ${moreLink}` : "") +
      `\n\nReply STOP to opt out.`;

    const niceName = String(name || "").trim() || "there";
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
        smsResult = await sendSmsTwilio({ to: String(phone).trim(), body: smsBody });
      } catch (e) {
        smsResult = { skipped: false, ok: false, error: e?.message || String(e) };
      }
    }

    if (useEmail) {
      try {
        emailResult = await sendEmailResend({ to: String(email).trim(), subject: emailSubject, html: emailHtml });
      } catch (e) {
        emailResult = { skipped: false, ok: false, error: e?.message || String(e) };
      }
    }

    return res.status(200).json({
      ok: true,
      request_id: requestId,
      token: requestToken,
      zone: rz.zone_code,
      appointment_type,
      primary: primaryWithTokens,
      more: { ...slotsJson.more, options: moreWithTokens },
      delivery: { smsResult, emailResult },
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", message: err?.message || String(err) });
  }
}
