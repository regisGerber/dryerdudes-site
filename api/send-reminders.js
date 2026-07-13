// /api/send-reminders.js
// Dryer Dudes reminder sender.
// Source of truth: bookings table + booking_requests.
// Sends:
// - night_before reminder during a forgiving evening window
// - morning_of reminder during a forgiving morning window
// Uses sms_reminder_log to prevent duplicate sends.

const { sendSmsTwilio } = require("./_twilio");

const SCHED_TZ = "America/Los_Angeles";

// Forgiving send windows in Pacific time.
// Vercel cron usually runs every 5 minutes, but this prevents missing reminders
// if the cron fires a few minutes late or Vercel delays one invocation.
const NIGHT_BEFORE_START_MIN = 18 * 60;       // 6:00 PM
const NIGHT_BEFORE_END_MIN = 21 * 60 + 59;   // 9:59 PM

const MORNING_OF_START_MIN = 7 * 60 + 45;    // 7:45 AM
const MORNING_OF_END_MIN = 8 * 60 + 30;      // 8:30 AM

const EXCLUDED_BOOKING_STATUSES = new Set([
  "cancelled",
  "canceled",
  "completed",
  "no_show",
]);

const EXCLUDED_PAYMENT_STATUSES = new Set([
  "failed",
  "refunded",
]);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getQueryParam(req, name) {
  try {
    const url = new URL(req.url || "", "https://example.com");
    return url.searchParams.get(name) || "";
  } catch {
    return "";
  }
}

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

  let hh = String(map.hour || "00").padStart(2, "0");

  // Some Intl implementations can return 24:xx around midnight.
  if (hh === "24") hh = "00";

  const mm = String(map.minute || "00").padStart(2, "0");

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hh,
    mm,
    minutes: Number(hh) * 60 + Number(mm),
  };
}

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

function fmtDatePacific(value) {
  if (!value) return "";

  return new Date(value).toLocaleDateString("en-US", {
    timeZone: SCHED_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtTimePacific(value) {
  if (!value) return "";

  return new Date(value).toLocaleTimeString("en-US", {
    timeZone: SCHED_TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

function pacificDateFromTimestamp(value) {
  if (!value) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHED_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function normalizePhone(value) {
  const raw = String(value || "").trim();

  if (raw.startsWith("+")) return raw;

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return raw;
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation",
  };
}

async function sbFetchUrl(url, { method = "GET", body } = {}) {
  const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const resp = await fetch(url.toString(), {
    method,
    headers: sbHeaders(SERVICE_ROLE),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return {
    ok: resp.ok,
    status: resp.status,
    data,
    text,
  };
}

async function sbFetchPath(path, { method = "GET", body } = {}) {
  const SUPABASE_URL = requireEnv("SUPABASE_URL");
  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const resp = await fetch(url, {
    method,
    headers: sbHeaders(SERVICE_ROLE),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return {
    ok: resp.ok,
    status: resp.status,
    data,
    text,
  };
}

function buildNightBeforeBody({ customerName, serviceDateLabel, start, end, jobRef }) {
  const name = String(customerName || "there").trim();

  return (
    `Dryer Dudes reminder:\n` +
    `\nHi ${name}, your service is tomorrow.` +
    `\nArrival window: ${start}–${end} on ${serviceDateLabel}` +
    `\n\nQuick prep helps the visit go fast:` +
    `\n• Please keep the dryer accessible` +
    `\n• No clothes inside` +
    `\n• Clear space to pull it out if needed` +
    `\n\nIf you want to show your dryer some love with Full Service, just ask the tech when they arrive.` +
    `\n\nJob ref: ${jobRef}` +
    `\nReply STOP to opt out.`
  );
}

function buildMorningOfBody({ customerName, serviceDateLabel, start, end, jobRef }) {
  const name = String(customerName || "there").trim();

  return (
    `Dryer Dudes today:\n` +
    `\nHi ${name} — your technician will arrive any time between ${start}–${end} on ${serviceDateLabel}.` +
    `\n\nPlease have the dryer accessible, no clothes inside, and space to pull it out if needed.` +
    `\n\nNot too late to show your dryer some love with Full Service — just ask the tech when they arrive.` +
    `\n\nJob ref: ${jobRef}` +
    `\nReply STOP to opt out.`
  );
}

async function loadBookingsForPacificDate(serviceDate) {
  const SUPABASE_URL = requireEnv("SUPABASE_URL");

  /*
    Broad UTC window, then we filter by Pacific date in JS.
    This avoids DST/timezone edge cases.
  */
  const queryStartIso = `${serviceDate}T00:00:00.000Z`;
  const queryEndIso = `${addDaysISO(serviceDate, 2)}T00:00:00.000Z`;

  const url = new URL(`${SUPABASE_URL}/rest/v1/bookings`);

  url.searchParams.set(
    "select",
    [
      "id",
      "request_id",
      "job_ref",
      "status",
      "payment_status",
      "window_start",
      "window_end",
      "appointment_type",
      "request_source",
      "paid_by_property_manager",
      "property_manager_id"
    ].join(",")
  );

  url.searchParams.set("window_start", `gte.${queryStartIso}`);
  url.searchParams.append("window_start", `lt.${queryEndIso}`);
  url.searchParams.set("order", "window_start.asc");
  url.searchParams.set("limit", "500");

  const resp = await sbFetchUrl(url);

  if (!resp.ok) {
    throw new Error(`Could not load bookings: ${resp.status} ${resp.text}`);
  }

  const rows = Array.isArray(resp.data) ? resp.data : [];

  return rows.filter((booking) => {
    const status = String(booking.status || "").toLowerCase();
    const paymentStatus = String(booking.payment_status || "").toLowerCase();

    if (EXCLUDED_BOOKING_STATUSES.has(status)) return false;
    if (EXCLUDED_PAYMENT_STATUSES.has(paymentStatus)) return false;

    return pacificDateFromTimestamp(booking.window_start) === serviceDate;
  });
}

async function loadRequestsByIds(requestIds) {
  const SUPABASE_URL = requireEnv("SUPABASE_URL");

  const ids = [...new Set(
    (requestIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )];

  if (!ids.length) return new Map();

  const url = new URL(`${SUPABASE_URL}/rest/v1/booking_requests`);

  url.searchParams.set(
    "select",
    [
      "id",
      "name",
      "phone",
      "email",
      "address",
      "contact_method",
      "request_source",
      "property_manager_id"
    ].join(",")
  );

  url.searchParams.set("id", `in.(${ids.join(",")})`);
  url.searchParams.set("limit", "500");

  const resp = await sbFetchUrl(url);

  if (!resp.ok) {
    throw new Error(`Could not load booking requests: ${resp.status} ${resp.text}`);
  }

  const map = new Map();

  for (const row of Array.isArray(resp.data) ? resp.data : []) {
    map.set(String(row.id), row);
  }

  return map;
}

async function tryClaimReminder({ jobRef, reminderType, serviceDate }) {
  /*
    sms_reminder_log should prevent duplicates.
    Existing old schema expected: job_ref, reminder_type, service_date.
  */
  const resp = await sbFetchPath("sms_reminder_log", {
    method: "POST",
    body: [{
      job_ref: jobRef,
      reminder_type: reminderType,
      service_date: serviceDate,
    }],
  });

  if (resp.ok) {
    return {
      claimed: true,
    };
  }

  const text = String(resp.text || "").toLowerCase();

  if (
    resp.status === 409 ||
    text.includes("duplicate key") ||
    text.includes("violates unique constraint")
  ) {
    return {
      claimed: false,
      duplicate: true,
    };
  }

  throw new Error(`Could not claim reminder log: ${resp.status} ${resp.text}`);
}

async function releaseReminderClaim({ jobRef, reminderType, serviceDate }) {
  /*
    If Twilio fails after the reminder is claimed, delete the claim so the next cron
    can retry during the same send window.
  */
  const path =
    `sms_reminder_log` +
    `?job_ref=eq.${encodeURIComponent(jobRef)}` +
    `&reminder_type=eq.${encodeURIComponent(reminderType)}` +
    `&service_date=eq.${encodeURIComponent(serviceDate)}`;

  const resp = await sbFetchPath(path, {
    method: "DELETE",
  });

  return resp;
}

function getReminderMode(req, now) {
  const force = String(getQueryParam(req, "force") || "").toLowerCase();
  const key = String(getQueryParam(req, "k") || "");

  /*
    Optional manual test:
    /api/send-reminders?force=night_before&k=YOUR_DEBUG_SECRET
    /api/send-reminders?force=morning_of&k=YOUR_DEBUG_SECRET
    /api/send-reminders?force=morning_of&date=2026-06-20&k=YOUR_DEBUG_SECRET
  */
  if (
    force &&
    process.env.DEBUG_SECRET &&
    key &&
    key === process.env.DEBUG_SECRET
  ) {
    if (force === "night_before" || force === "morning_of") {
      return {
        reminderType: force,
        forced: true,
      };
    }
  }

  const isNightBefore =
    now.minutes >= NIGHT_BEFORE_START_MIN &&
    now.minutes <= NIGHT_BEFORE_END_MIN;

  const isMorningOf =
    now.minutes >= MORNING_OF_START_MIN &&
    now.minutes <= MORNING_OF_END_MIN;

  if (isNightBefore) {
    return {
      reminderType: "night_before",
      forced: false,
    };
  }

  if (isMorningOf) {
    return {
      reminderType: "morning_of",
      forced: false,
    };
  }

  return {
    reminderType: "",
    forced: false,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const now = getNowInTZ(SCHED_TZ);
    const mode = getReminderMode(req, now);

    if (!mode.reminderType) {
      return res.status(200).json({
        ok: true,
        ran: false,
        reason: "outside_send_window",
        now,
        windows: {
          night_before: "6:00 PM–9:59 PM Pacific",
          morning_of: "7:45 AM–8:30 AM Pacific",
        },
      });
    }

    const forcedDate = String(getQueryParam(req, "date") || "").trim();

    const serviceDate =
      mode.forced && /^\d{4}-\d{2}-\d{2}$/.test(forcedDate)
        ? forcedDate
        : mode.reminderType === "night_before"
          ? addDaysISO(now.date, 1)
          : now.date;

    const bookings = await loadBookingsForPacificDate(serviceDate);
    const requestMap = await loadRequestsByIds(bookings.map((b) => b.request_id));

    let sent = 0;
    let skipped = 0;

    const errors = [];
    const results = [];

    for (const booking of bookings) {
      const request = requestMap.get(String(booking.request_id)) || {};

      const jobRef = String(booking.job_ref || "").trim();
      const phone = normalizePhone(request.phone || "");

      const start = fmtTimePacific(booking.window_start);
      const end = fmtTimePacific(booking.window_end);
      const serviceDateLabel = fmtDatePacific(booking.window_start);

      if (!jobRef || !phone || !start || !end) {
        skipped += 1;
        results.push({
          booking_id: booking.id,
          job_ref: jobRef || null,
          skipped: true,
          reason: "missing_job_ref_phone_or_window",
        });
        continue;
      }

      const claim = await tryClaimReminder({
        jobRef,
        reminderType: mode.reminderType,
        serviceDate,
      });

      if (!claim.claimed) {
        skipped += 1;
        results.push({
          booking_id: booking.id,
          job_ref: jobRef,
          skipped: true,
          reason: "already_sent",
        });
        continue;
      }

      const body =
        mode.reminderType === "night_before"
          ? buildNightBeforeBody({
              customerName: request.name,
              serviceDateLabel,
              start,
              end,
              jobRef,
            })
          : buildMorningOfBody({
              customerName: request.name,
              serviceDateLabel,
              start,
              end,
              jobRef,
            });

      try {
        const sms = await sendSmsTwilio({
          to: phone,
          body,
        });

        sent += 1;

        results.push({
          booking_id: booking.id,
          job_ref: jobRef,
          sent: true,
          sid: sms?.sid || null,
        });
      } catch (err) {
        await releaseReminderClaim({
          jobRef,
          reminderType: mode.reminderType,
          serviceDate,
        }).catch(() => {});

        errors.push({
          booking_id: booking.id,
          job_ref: jobRef,
          message: err?.message || String(err),
        });

        results.push({
          booking_id: booking.id,
          job_ref: jobRef,
          sent: false,
          error: err?.message || String(err),
        });
      }
    }

    return res.status(200).json({
      ok: true,
      ran: true,
      forced: mode.forced,
      reminderType: mode.reminderType,
      serviceDate,
      checked: bookings.length,
      sent,
      skipped,
      errors,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || String(err),
    });
  }
};
