// /api/send-unbooked-followups.js
// Sends one clean 24-hour follow-up text when a customer requested appointment options but did not book.
// No appointment-token links are sent by SMS.

const { sendSmsTwilio } = require("./_twilio");

const FOLLOWUP_TYPE = "unbooked_24h";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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

  return { ok: resp.ok, status: resp.status, data, text };
}

function firstName(name) {
  const n = String(name || "").trim();
  if (!n) return "there";
  return n.split(/\s+/)[0] || "there";
}

function shouldTextRequest(row) {
  const cm = String(row.contact_method || "").toLowerCase();
  return cm === "text" || cm === "both";
}

function isPublicRequest(row) {
  const source = String(row.request_source || "").toLowerCase();

  if (row.property_manager_id) return false;
  if (!source) return true;
  return source === "public";
}

function isAlreadyFinalState(row) {
  const status = String(row.status || "").toLowerCase();

  return [
    "scheduled",
    "cancelled",
    "canceled",
    "rejected",
    "completed"
  ].includes(status);
}

function buildSmsBody({ row, origin }) {
  const name = firstName(row.name);

  return (
    `Hi ${name}, still need dryer repair?\n\n` +
    `Your Dryer Dudes appointment options were sent yesterday. If you still need service, you can request fresh times here:\n` +
    `${origin}/#book\n\n` +
    `Dryer Dudes: $80 plus the cost of any needed parts gets your dryer fixed!\n\n` +
    `Reply STOP to opt out.`
  );
}

async function loadRequests({ supabaseUrl, serviceRole, requestId, hoursOld, lookbackHours, limit }) {
  const url = new URL(`${supabaseUrl}/rest/v1/booking_requests`);

  url.searchParams.set(
    "select",
    "id,created_at,name,phone,email,status,contact_method,request_source,property_manager_id"
  );

  if (requestId) {
    url.searchParams.set("id", `eq.${requestId}`);
    url.searchParams.set("limit", "1");
  } else {
    const now = Date.now();
    const end = new Date(now - hoursOld * 60 * 60 * 1000);
    const start = new Date(now - (hoursOld + lookbackHours) * 60 * 60 * 1000);

    url.searchParams.set("created_at", `gte.${start.toISOString()}`);
    url.searchParams.append("created_at", `lt.${end.toISOString()}`);
    url.searchParams.set("order", "created_at.asc");
    url.searchParams.set("limit", String(limit || 100));
  }

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Could not load booking requests: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data : [];
}

async function bookingExistsForRequest({ supabaseUrl, serviceRole, requestId }) {
  const url = new URL(`${supabaseUrl}/rest/v1/bookings`);
  url.searchParams.set("select", "id,status,job_ref,created_at");
  url.searchParams.set("request_id", `eq.${requestId}`);
  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Could not check booking for request ${requestId}: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) && r.data.length > 0;
}

async function createStartedLog({ supabaseUrl, serviceRole, requestId, phone }) {
  const r = await sbFetchJson(`${supabaseUrl}/rest/v1/booking_request_followup_log`, {
    method: "POST",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify([{
      request_id: requestId,
      followup_type: FOLLOWUP_TYPE,
      phone,
      status: "started",
    }]),
  });

  if (r.ok) {
    return {
      inserted: true,
      row: Array.isArray(r.data) ? r.data[0] || null : null,
    };
  }

  // Unique conflict means this follow-up already ran.
  if (r.status === 409) {
    return {
      inserted: false,
      duplicate: true,
      row: null,
    };
  }

  throw new Error(`Could not create follow-up log: ${r.status} ${r.text}`);
}

async function patchLog({ supabaseUrl, serviceRole, id, patch }) {
  if (!id) return null;

  const url = new URL(`${supabaseUrl}/rest/v1/booking_request_followup_log`);
  url.searchParams.set("id", `eq.${id}`);

  const r = await sbFetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      ...patch,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!r.ok) {
    console.error("Could not patch follow-up log", r.status, r.text);
    return null;
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const optionalSecret = process.env.FOLLOWUP_SECRET || process.env.CRON_SECRET || "";
    const suppliedSecret =
      req.query?.secret ||
      req.headers["x-cron-secret"] ||
      req.body?.secret ||
      "";

    if (optionalSecret && suppliedSecret !== optionalSecret) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    const origin = getOrigin(req);

    const dryRun =
      String(req.query?.dry_run || req.body?.dry_run || "") === "1" ||
      String(req.query?.dryRun || req.body?.dryRun || "").toLowerCase() === "true";

    const requestId = String(req.query?.request_id || req.body?.request_id || "").trim();

    const hoursOld = Number(req.query?.hours_old || req.body?.hours_old || 24);
    const lookbackHours = Number(req.query?.lookback_hours || req.body?.lookback_hours || 2);
    const limit = Math.min(Number(req.query?.limit || req.body?.limit || 100), 250);

    const rows = await loadRequests({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      requestId,
      hoursOld: Number.isFinite(hoursOld) ? hoursOld : 24,
      lookbackHours: Number.isFinite(lookbackHours) ? lookbackHours : 2,
      limit,
    });

    const results = [];
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      const result = {
        request_id: row.id,
        created_at: row.created_at,
        name: row.name || null,
        phone: row.phone || null,
        status: row.status || null,
        action: "",
        reason: "",
      };

      try {
        if (!isPublicRequest(row)) {
          skipped += 1;
          result.action = "skipped";
          result.reason = "not_public_request";
          results.push(result);
          continue;
        }

        if (isAlreadyFinalState(row)) {
          skipped += 1;
          result.action = "skipped";
          result.reason = "request_already_final";
          results.push(result);
          continue;
        }

        if (!shouldTextRequest(row)) {
          skipped += 1;
          result.action = "skipped";
          result.reason = "contact_method_not_text";
          results.push(result);
          continue;
        }

        if (!row.phone) {
          skipped += 1;
          result.action = "skipped";
          result.reason = "missing_phone";
          results.push(result);
          continue;
        }

        const hasBooking = await bookingExistsForRequest({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          requestId: row.id,
        });

        if (hasBooking) {
          skipped += 1;
          result.action = "skipped";
          result.reason = "booking_exists";
          results.push(result);
          continue;
        }

        const body = buildSmsBody({ row, origin });
        result.preview = body;

        if (dryRun) {
          skipped += 1;
          result.action = "dry_run";
          result.reason = "would_send";
          results.push(result);
          continue;
        }

        const log = await createStartedLog({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          requestId: row.id,
          phone: row.phone,
        });

        if (log.duplicate) {
          skipped += 1;
          result.action = "skipped";
          result.reason = "already_sent";
          results.push(result);
          continue;
        }

        try {
          const twilio = await sendSmsTwilio({
            to: row.phone,
            body,
          });

          sent += 1;
          result.action = "sent";
          result.twilio_sid = twilio?.sid || null;
          result.twilio_status = twilio?.status || null;

          await patchLog({
            supabaseUrl: SUPABASE_URL,
            serviceRole: SERVICE_ROLE,
            id: log.row?.id,
            patch: {
              status: "sent",
              twilio_sid: twilio?.sid || null,
              twilio_status: twilio?.status || null,
            },
          });
        } catch (smsErr) {
          failed += 1;
          result.action = "failed";
          result.reason = smsErr?.message || String(smsErr);

          await patchLog({
            supabaseUrl: SUPABASE_URL,
            serviceRole: SERVICE_ROLE,
            id: log.row?.id,
            patch: {
              status: "failed",
              error: smsErr?.message || String(smsErr),
            },
          });
        }

        results.push(result);
      } catch (err) {
        failed += 1;
        result.action = "failed";
        result.reason = err?.message || String(err);
        results.push(result);
      }
    }

    return res.status(200).json({
      ok: true,
      dryRun,
      request_id: requestId || null,
      hours_old: hoursOld,
      lookback_hours: lookbackHours,
      found: rows.length,
      sent,
      skipped,
      failed,
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
