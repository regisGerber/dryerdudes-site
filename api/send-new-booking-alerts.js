// /api/send-new-booking-alerts.js
// Temporary owner alert for new bookings.
// Safe to remove later by deleting this file and removing the cron entry.

const { sendSmsTwilio } = require("./_twilio");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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
    data = { raw: text };
  }

  return {
    ok: resp.ok,
    status: resp.status,
    data,
    text,
  };
}

function fmtDateTimeLocal(value) {
  if (!value) return "";

  return new Date(value).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

function fmtTimeLocal(value) {
  if (!value) return "";

  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

function buildOwnerAlertText(booking) {
  const req = booking.booking_requests || {};

  const start = fmtDateTimeLocal(booking.window_start);
  const end = fmtTimeLocal(booking.window_end);

  const lines = [
    `New DryerDudes booking ✅`,
    booking.job_ref ? `Job: ${booking.job_ref}` : "",
    req.name ? `Customer: ${req.name}` : "",
    start && end ? `Window: ${start}–${end}` : "",
    req.address ? `Address: ${req.address}` : "",
    req.phone ? `Phone: ${req.phone}` : "",
    booking.appointment_type ? `Type: ${booking.appointment_type}` : "",
  ].filter(Boolean);

  return lines.join("\n").slice(0, 1400);
}

async function loadRecentBookings({ supabaseUrl, serviceRole }) {
  const lookbackIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const url = new URL(`${supabaseUrl}/rest/v1/bookings`);

  url.searchParams.set(
    "select",
    [
      "id",
      "job_ref",
      "created_at",
      "window_start",
      "window_end",
      "appointment_type",
      "status",
      "payment_status",
      "booking_requests:request_id(name,phone,email,address)"
    ].join(",")
  );

  url.searchParams.set("created_at", `gte.${lookbackIso}`);
  url.searchParams.set("status", "neq.cancelled");
  url.searchParams.set("order", "created_at.asc");
  url.searchParams.set("limit", "50");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Could not load recent bookings: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data : [];
}

async function loadExistingAlertedBookingIds({ supabaseUrl, serviceRole, bookingIds }) {
  const ids = [...new Set(
    (bookingIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )];

  if (!ids.length) return new Set();

  const url = new URL(`${supabaseUrl}/rest/v1/admin_new_booking_alerts`);
  url.searchParams.set("select", "booking_id");
  url.searchParams.set("booking_id", `in.(${ids.join(",")})`);

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Could not load existing alerts: ${r.status} ${r.text}`);
  }

  return new Set(
    (Array.isArray(r.data) ? r.data : [])
      .map((row) => String(row.booking_id || ""))
      .filter(Boolean)
  );
}

async function claimAlert({ supabaseUrl, serviceRole, bookingId }) {
  const url = new URL(`${supabaseUrl}/rest/v1/admin_new_booking_alerts`);
  url.searchParams.set("on_conflict", "booking_id");

  const r = await sbFetchJson(url.toString(), {
    method: "POST",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify([
      {
        booking_id: bookingId,
        status: "sending",
      },
    ]),
  });

  if (!r.ok) {
    throw new Error(`Could not claim alert: ${r.status} ${r.text}`);
  }

  const row = Array.isArray(r.data) ? r.data[0] || null : null;

  return !!row;
}

async function patchAlert({ supabaseUrl, serviceRole, bookingId, patch }) {
  const url = new URL(`${supabaseUrl}/rest/v1/admin_new_booking_alerts`);
  url.searchParams.set("booking_id", `eq.${bookingId}`);

  const r = await sbFetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  if (!r.ok) {
    throw new Error(`Could not patch alert: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data[0] || null : r.data;
}

module.exports = async function handler(req, res) {
  // Vercel cron calls GET.
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const ALERT_PHONE = requireEnv("NEW_BOOKING_ALERT_PHONE");

    const bookings = await loadRecentBookings({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
    });

    const existingIds = await loadExistingAlertedBookingIds({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      bookingIds: bookings.map((b) => b.id),
    });

    const pending = bookings.filter((booking) => {
      if (!booking?.id) return false;
      if (existingIds.has(String(booking.id))) return false;

      const status = String(booking.status || "").toLowerCase();

      // Alert on real active bookings only.
      return !["cancelled", "canceled", "no_show"].includes(status);
    });

    const results = [];

    for (const booking of pending.slice(0, 10)) {
      const bookingId = booking.id;

      try {
        const claimed = await claimAlert({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          bookingId,
        });

        if (!claimed) {
          results.push({
            booking_id: bookingId,
            skipped: true,
            reason: "Already alerted or claimed.",
          });
          continue;
        }

        const body = buildOwnerAlertText(booking);

        const sms = await sendSmsTwilio({
          to: ALERT_PHONE,
          body,
        });

        await patchAlert({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          bookingId,
          patch: {
            status: "sent",
            sent_at: new Date().toISOString(),
            error: null,
          },
        });

        results.push({
          booking_id: bookingId,
          job_ref: booking.job_ref || null,
          sent: true,
          sid: sms?.sid || null,
        });
      } catch (err) {
        const message = err?.message || String(err);

        try {
          await patchAlert({
            supabaseUrl: SUPABASE_URL,
            serviceRole: SERVICE_ROLE,
            bookingId,
            patch: {
              status: "error",
              error: message.slice(0, 1000),
            },
          });
        } catch {
          // Ignore patch failure so the endpoint can report the main error.
        }

        results.push({
          booking_id: bookingId,
          job_ref: booking.job_ref || null,
          sent: false,
          error: message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      checked: bookings.length,
      pending: pending.length,
      sent: results.filter((r) => r.sent).length,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
