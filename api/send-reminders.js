// /api/send-reminders.js
const { sendSmsTwilio } = require("./_twilio");

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

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hh: map.hour,
    mm: map.minute,
  };
}

function addDays(dateISO, days) {
  const [y, m, d] = String(dateISO).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
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
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch {
    json = { raw: txt };
  }

  if (!resp.ok) {
    throw new Error(`Supabase error ${resp.status}: ${txt.slice(0, 800)}`);
  }

  return json;
}

function dateInTZ(value, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function timeInTZ(value, tz) {
  return new Date(value).toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  });
}

function shouldSendText(request) {
  const cm = String(request?.contact_method || "").toLowerCase();
  return cm === "text" || cm === "both";
}

function buildNightBeforeBody({ customerName, serviceDate, start, end, jobRef }) {
  const name = (customerName || "there").trim();

  return (
    `Dryer Dudes reminder:\n` +
    `\nHi ${name}, your service is tomorrow.` +
    `\nArrival window: ${start}–${end} on ${serviceDate}` +
    `\n\nQuick prep helps the visit go fast:` +
    `\n• Keep the dryer accessible` +
    `\n• Remove clothes from inside` +
    `\n• Clear space around the dryer if possible` +
    `\n\nJob ref: ${jobRef}` +
    `\nAppointment help: https://www.dryerdudes.com/job-help.html?job_ref=${encodeURIComponent(jobRef)}` +
    `\nReply STOP to opt out.`
  );
}

function buildMorningOfBody({ customerName, start, end, jobRef }) {
  const name = (customerName || "there").trim();

  return (
    `Dryer Dudes today:\n` +
    `\nHi ${name}, your technician may arrive any time between ${start}–${end}.` +
    `\n\nPlease keep the dryer accessible, empty, and with space around it if possible.` +
    `\n\nJob ref: ${jobRef}` +
    `\nAppointment help: https://www.dryerdudes.com/job-help.html?job_ref=${encodeURIComponent(jobRef)}` +
    `\nReply STOP to opt out.`
  );
}

function buildWideWindowForDate(serviceDate) {
  const before = addDays(serviceDate, -1);
  const after = addDays(serviceDate, 2);

  return {
    startISO: `${before}T00:00:00.000Z`,
    endISO: `${after}T23:59:59.999Z`,
  };
}

async function loadBookingsForServiceDate(serviceDate) {
  const { startISO, endISO } = buildWideWindowForDate(serviceDate);

  const path =
    `bookings` +
    `?select=id,job_ref,status,window_start,window_end,booking_requests:request_id(id,name,phone,email,address,contact_method)` +
    `&window_start=gte.${encodeURIComponent(startISO)}` +
    `&window_start=lte.${encodeURIComponent(endISO)}` +
    `&order=window_start.asc`;

  const rows = await sbFetch(path);

  const activeRows = Array.isArray(rows) ? rows : [];

  return activeRows.filter((b) => {
    const status = String(b.status || "").toLowerCase();

    if (["cancelled", "no_show", "completed"].includes(status)) {
      return false;
    }

    return dateInTZ(b.window_start, SCHED_TZ) === serviceDate;
  });
}

async function insertReminderLog({ jobRef, reminderType, serviceDate }) {
  return sbFetch("sms_reminder_log", {
    method: "POST",
    body: [{
      job_ref: jobRef,
      reminder_type: reminderType,
      service_date: serviceDate
    }],
  });
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const now = getNowInTZ(SCHED_TZ);

    const force = String(req.query?.force || "").toLowerCase();
    const dryRun = String(req.query?.dry_run || "") === "1";
    const dateOverride = String(req.query?.date || "").trim();

    const isNightBefore = force === "night_before" || (now.hh === "18" && now.mm === "00");
    const isMorningOf = force === "morning_of" || (now.hh === "07" && now.mm === "45");

    if (!isNightBefore && !isMorningOf) {
      return res.status(200).json({
        ok: true,
        ran: false,
        reason: "not_a_send_minute",
        now
      });
    }

    const reminderType = isNightBefore ? "night_before" : "morning_of";
    const serviceDate =
      dateOverride ||
      addDays(now.date, isNightBefore ? 1 : 0);

    const bookings = await loadBookingsForServiceDate(serviceDate);

    if (!bookings.length) {
      return res.status(200).json({
        ok: true,
        ran: true,
        reminderType,
        serviceDate,
        sent: 0,
        note: "no_bookings"
      });
    }

    let sent = 0;
    let skipped = 0;
    const errors = [];
    const preview = [];

    for (const b of bookings) {
      const req = b.booking_requests || {};
      const jobRef = String(b.job_ref || "").trim();
      const phone = String(req.phone || "").trim();

      const start = timeInTZ(b.window_start, SCHED_TZ);
      const end = timeInTZ(b.window_end, SCHED_TZ);

      if (!jobRef || !phone || !start || !end) {
        skipped += 1;
        continue;
      }

      if (!shouldSendText(req)) {
        skipped += 1;
        continue;
      }

      const body =
        reminderType === "night_before"
          ? buildNightBeforeBody({
              customerName: req.name,
              serviceDate,
              start,
              end,
              jobRef,
            })
          : buildMorningOfBody({
              customerName: req.name,
              start,
              end,
              jobRef,
            });

      preview.push({
        jobRef,
        phone,
        reminderType,
        serviceDate,
        start,
        end,
        body
      });

      if (dryRun) {
        continue;
      }

      try {
        await insertReminderLog({ jobRef, reminderType, serviceDate });
      } catch {
        skipped += 1;
        continue;
      }

      try {
        await sendSmsTwilio({ to: phone, body });
        sent += 1;
      } catch (err) {
        errors.push({
          jobRef,
          message: err?.message || String(err)
        });
      }
    }

    return res.status(200).json({
      ok: true,
      ran: true,
      reminderType,
      serviceDate,
      dryRun,
      found: bookings.length,
      sent,
      skipped,
      errors,
      preview: dryRun ? preview : undefined
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || String(err)
    });
  }
};
