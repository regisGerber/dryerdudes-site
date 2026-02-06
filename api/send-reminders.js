// /api/send-reminders.js
const { sendSmsTwilio } = require("./_twilio");

// ---- Pacific time helpers ----
const SCHED_TZ = "America/Los_Angeles";

function getNowInTZ(tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const date = `${map.year}-${map.month}-${map.day}`; // YYYY-MM-DD
  const hh = map.hour;
  const mm = map.minute;
  return { date, hh, mm };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function sbFetch(path, { method = "GET", body } = {}) {
  const SUPABASE_URL = requireEnv("SUPABASE_URL");
  const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const txt = await resp.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }

  if (!resp.ok) {
    throw new Error(`Supabase error ${resp.status}: ${txt.slice(0, 800)}`);
  }
  return json;
}

function buildNightBeforeBody({ customerName, serviceDate, start, end, jobRef }) {
  const name = (customerName || "there").trim();
  return (
    `Dryer Dudes reminder:\n` +
    `\nHi ${name}, your service is tomorrow.` +
    `\nArrival window: ${start}–${end} on ${serviceDate}` +
    `\n\nQuick prep helps the visit go fast:` +
    `\n• Please keep the dryer accessible` +
    `\n• No clothes inside` +
    `\n• Clear space to pull it out (if needed)` +
    `\n\nIf you want to show your dryer some love with Full Service, just ask the tech when they arrive.` +
    `\n\nJob ref: ${jobRef}` +
    `\nReply STOP to opt out.`
  );
}

function buildMorningOfBody({ customerName, serviceDate, start, end, jobRef }) {
  const name = (customerName || "there").trim();
  return (
    `Dryer Dudes today:\n` +
    `\nHi ${name} — your technician will arrive any time between ${start}–${end}.` +
    `\n\nPlease have the dryer accessible (no clothes inside) and space to pull it out if needed.` +
    `\n\nNot too late to show your dryer some love with Full Service — just ask the tech when they arrive.` +
    `\n\nJob ref: ${jobRef}` +
    `\nReply STOP to opt out.`
  );
}

module.exports = async (req, res) => {
  // Vercel cron hits with GET by default
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const now = getNowInTZ(SCHED_TZ);

    // Fire windows (Pacific):
    const isNightBefore = now.hh === "18" && now.mm === "00";
    const isMorningOf = now.hh === "07" && now.mm === "45";

    // If cron is running every 5 minutes, most calls do nothing
    if (!isNightBefore && !isMorningOf) {
      return res.status(200).json({ ok: true, ran: false, reason: "not_a_send_minute", now });
    }

    const reminderType = isNightBefore ? "night_before" : "morning_of";

    // Which service_date?
    // night_before => tomorrow
    // morning_of => today
    const today = now.date;

    // Calculate tomorrow in a safe way
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (isNightBefore ? 1 : 0));
    const serviceDate = dt.toISOString().slice(0, 10);

    // ---- Pull confirmed appointments for that date ----
    // ✅ CHANGE THIS TABLE/COLUMNS to match your schema.
    // Expected columns here:
    // job_ref, customer_name, phone, service_date, arrival_start, arrival_end
    const appts = await sbFetch(
      `confirmed_appointments?select=job_ref,customer_name,phone,service_date,arrival_start,arrival_end&service_date=eq.${serviceDate}`
    );

    if (!Array.isArray(appts) || appts.length === 0) {
      return res.status(200).json({ ok: true, ran: true, reminderType, serviceDate, sent: 0, note: "no_appointments" });
    }

    let sent = 0;
    const errors = [];

    for (const a of appts) {
      const jobRef = String(a.job_ref || "").trim();
      const phone = String(a.phone || "").trim();
      const start = String(a.arrival_start || "").slice(0, 5);
      const end = String(a.arrival_end || "").slice(0, 5);

      if (!jobRef || !phone || !start || !end) continue;

      // Check sent log (unique(job_ref, reminder_type))
      try {
        // Attempt insert first (fast). If it violates unique, we skip sending.
        await sbFetch("sms_reminder_log", {
          method: "POST",
          body: [{ job_ref: jobRef, reminder_type: reminderType, service_date: serviceDate }],
        });
      } catch (e) {
        // If duplicate, this throws — skip sending to avoid duplicates
        continue;
      }

      const body =
        reminderType === "night_before"
          ? buildNightBeforeBody({
              customerName: a.customer_name,
              serviceDate,
              start,
              end,
              jobRef,
            })
          : buildMorningOfBody({
              customerName: a.customer_name,
              serviceDate,
              start,
              end,
              jobRef,
            });

      try {
        await sendSmsTwilio({ to: phone, body });
        sent += 1;
      } catch (err) {
        errors.push({ jobRef, message: err?.message || String(err) });
      }
    }

    return res.status(200).json({ ok: true, ran: true, reminderType, serviceDate, sent, errors });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || String(err) });
  }
};
