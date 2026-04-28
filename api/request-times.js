// /api/request-times.js
// Lean-schema compatible + restored SMS/email delivery

import crypto from "crypto";

// -------------------- token helpers --------------------
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
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;

  const proto = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host =
    String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req?.headers?.host || "").trim();

  return `${proto}://${host}`;
}

// -------------------- formatting helpers --------------------
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

function formatSlotLine(s) {
  const date = fmtDateMDY(s.service_date);
  const start = s.start_time ? fmtTime12h(s.start_time) : "";
  const end = s.end_time ? fmtTime12h(s.end_time) : "";
  const window =
    start && end
      ? `${start}–${end}`
      : s.window_label
      ? String(s.window_label)
      : "Arrival window";
  return `${date} • ${window}`;
}

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) =>
    ({
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
    })[c]
  );
}

// -------------------- supabase REST helpers --------------------
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

async function supabaseInsert({ table, row, serviceRole, supabaseUrl }) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(serviceRole), Prefer: "return=representation" },
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
    headers: { ...sbHeaders(serviceRole), Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`Supabase insertMany failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// -------------------- delivery helpers --------------------
async function sendSmsTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    return { skipped: true, reason: "Twilio env vars not set" };
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Body: body,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { skipped: false, ok: false, status: resp.status, data };
  }

  return { skipped: false, ok: true, status: resp.status, data };
}

async function sendEmailResend({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return { skipped: true, reason: "RESEND_API_KEY not set" };
  }

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
  if (!resp.ok) {
    return { skipped: false, ok: false, status: resp.status, data };
  }

  return { skipped: false, ok: true, status: resp.status, data };
}

// -------------------- slot-id backfill helpers --------------------
function pickSlotIdFromCandidate(c) {
  return c?.id || c?.slot_id || c?.schedule_slot_id || null;
}

function buildScheduleSlotsOrFilter(keys) {
  const parts = keys.map((k) => {
    const d = String(k.service_date);
    const idx = Number(k.slot_index);
    const z = String(k.zone_code);
    return `and(service_date.eq.${d},slot_index.eq.${idx},zone_code.eq.${z})`;
  });
  return `or=(${parts.join(",")})`;
}

async function fetchScheduleSlotMap({ keys, supabaseUrl, serviceRole }) {
  if (!keys.length) return new Map();

  const seen = new Set();
  const uniq = [];

  for (const k of keys) {
    const key = `${k.zone_code}#${k.service_date}#${k.slot_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(k);
  }

  const orFilter = buildScheduleSlotsOrFilter(uniq);

  const url =
    `${supabaseUrl}/rest/v1/schedule_slots` +
    `?select=id,service_date,slot_index,zone_code,start_time,end_time,window_label,tech_id,is_booked` +
    `&${orFilter}` +
    `&limit=${Math.max(uniq.length, 10)}`;

  const r = await sbFetchJson(url, { headers: sbHeaders(serviceRole) });
  if (!r.ok) {
    throw new Error(`Supabase schedule_slots lookup failed: ${r.status} ${r.text}`);
  }

  const map = new Map();
  for (const row of r.data || []) {
    const key = `${row.zone_code}#${row.service_date}#${row.slot_index}`;
    map.set(key, row);
  }

  return map;
}

// -------------------- handler --------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

   const {
  name = "",
  phone = "",
  email = "",
  contact_method = "email",
  address = "",
  appointment_type = "standard",
  suppress_delivery = false,
} = req.body || {};

const suppressDelivery =
  suppress_delivery === true ||
  suppress_delivery === "true" ||
  suppress_delivery === 1 ||
  suppress_delivery === "1";

    const cleanAddress = String(address || "").trim();
    if (!cleanAddress) {
      return res.status(400).json({ ok: false, error: "address is required" });
    }

    const cm = String(contact_method || "email").toLowerCase();
    const useText = cm === "text" || cm === "both";
    const useEmail = cm === "email" || cm === "both";

    if (useText && !String(phone).trim()) {
      return res.status(400).json({ ok: false, error: "phone is required for text/both" });
    }
    if (useEmail && !String(email).trim()) {
      return res.status(400).json({ ok: false, error: "email is required for email/both" });
    }

    const origin = getOrigin(req);

    // 1) Resolve zone from address
    const rzResp = await fetch(`${origin}/api/resolve-zone?address=${encodeURIComponent(cleanAddress)}`);
    const rz = await rzResp.json().catch(() => ({}));

    if (!rzResp.ok) {
      return res.status(502).json({ ok: false, error: "resolve-zone failed", details: rz });
    }

    const zone = String(rz.zone_code || "").trim();
    if (!zone) {
      return res.status(400).json({
        ok: false,
        error: "Could not resolve zone for address",
        details: rz,
      });
    }

    // 2) Get candidate slots from scheduling logic
    const slotsResp = await fetch(
      `${origin}/api/get-available-slots?zone=${encodeURIComponent(zone)}&type=${encodeURIComponent(appointment_type)}`
    );
    const slotsJson = await slotsResp.json().catch(() => ({}));

    if (!slotsResp.ok) {
      return res.status(502).json({ ok: false, error: "get-available-slots failed", details: slotsJson });
    }

    const primary = Array.isArray(slotsJson.primary) ? slotsJson.primary : [];
    const moreOptions = Array.isArray(slotsJson.more?.options) ? slotsJson.more.options : [];

    if (primary.length < 1) {
      return res.status(200).json({
        ok: true,
        zone,
        message: "No appointment options available right now.",
        details: slotsJson,
      });
    }

    // 3) Backfill slot_id by matching schedule_slots on (zone_code, service_date, slot_index)
    const all = [...primary, ...moreOptions].map((c) => ({
      ...c,
      zone_code: String(c.zone_code || zone),
      service_date: String(c.service_date || "").trim(),
      slot_index: Number(c.slot_index),
      _slot_id: pickSlotIdFromCandidate(c),
    }));

    const needLookup = all.filter((c) => !c._slot_id && c.service_date && Number.isFinite(c.slot_index));
    const keyTriples = needLookup.map((c) => ({
      zone_code: c.zone_code,
      service_date: c.service_date,
      slot_index: c.slot_index,
    }));

    const slotMap = await fetchScheduleSlotMap({
      keys: keyTriples,
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
    });

    const allEnriched = all.map((c) => {
      if (c._slot_id) return { ...c, slot_id: c._slot_id };
      const key = `${c.zone_code}#${c.service_date}#${c.slot_index}`;
      const row = slotMap.get(key);
      return { ...c, slot_id: row?.id || null, _slot_row: row || null };
    });

    const keep = allEnriched.filter((c) => !!c.slot_id);

    const primaryKeep = keep.slice(0, primary.length).filter(Boolean);
    const moreKeep = keep.slice(primary.length).filter(Boolean);

    if (primaryKeep.length < 1) {
      return res.status(500).json({
        ok: false,
        error: "Scheduler returned options but none could be matched to schedule_slots (slot_id mapping failed).",
        debug: {
          zone,
          appointment_type,
          primary_sample: primary[0] || null,
          more_sample: moreOptions[0] || null,
          needed_lookup_count: needLookup.length,
        },
      });
    }

    // 4) Store request
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
        zone_code: zone,
        zone_name: rz.zone_name || null,
        status: "sent",
      },
    });

    const requestId = requestRow.id;

    // 5) Create offer tokens + store offers
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 3;
    const offersToStore = [];

    function makeOffer(candidate, group) {
      const payload = {
        v: 2,
        request_id: requestId,
        appointment_type,
        zone: candidate.zone_code || zone,
        service_date: candidate.service_date,
        slot_index: candidate.slot_index,
        slot_id: candidate.slot_id,
        exp: expiresAt,
      };

      const token = signToken(payload, TOKEN_SECRET);

      offersToStore.push({
        request_id: requestId,
        offer_group: group,
        offer_token: token,
        is_active: true,
        appointment_type: String(appointment_type || "standard"),
        route_zone_code: String(candidate.zone_code || zone),
        slot_id: candidate.slot_id,
      });

      const sr = candidate._slot_row || {};
      return {
        service_date: sr.service_date || candidate.service_date,
        slot_index: sr.slot_index ?? candidate.slot_index,
        zone_code: sr.zone_code || candidate.zone_code || zone,
        start_time: sr.start_time || candidate.start_time || null,
        end_time: sr.end_time || candidate.end_time || null,
        window_label: sr.window_label || candidate.window_label || null,
        slot_id: candidate.slot_id,
        offer_token: token,
      };
    }

    const primaryWithTokens = primaryKeep.slice(0, 3).map((c) => makeOffer(c, "primary"));
    const moreWithTokens = moreKeep.map((c) => makeOffer(c, "more"));

    await supabaseInsertMany({
      table: "booking_request_offers",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      rows: offersToStore,
    });

    const requestToken = signToken(
      { v: 1, request_id: requestId, exp: expiresAt, kind: "request" },
      TOKEN_SECRET
    );

    // 6) Build message content using your older format
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

    // 7) Send delivery without crashing scheduling if delivery fails
    let smsResult = { skipped: true };
    let emailResult = { skipped: true };

 if (suppressDelivery) {
  smsResult = { skipped: true, suppressed: true };
  emailResult = { skipped: true, suppressed: true };
} else {
  if (useText) {
    try {
      smsResult = await sendSmsTwilio({
        to: String(phone).trim(),
        body: smsBody,
      });
    } catch (e) {
      smsResult = { skipped: false, ok: false, error: e?.message || String(e) };
    }
  }

  if (useEmail) {
    try {
      emailResult = await sendEmailResend({
        to: String(email).trim(),
        subject: emailSubject,
        html: emailHtml,
      });
    } catch (e) {
      emailResult = { skipped: false, ok: false, error: e?.message || String(e) };
    }
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
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
