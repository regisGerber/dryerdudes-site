function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin) return envOrigin;

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host =
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req.headers.host || "").trim();

  return `${proto}://${host}`;
}

function getBearerToken(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
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

async function getUserFromToken({ supabaseUrl, serviceRole, accessToken }) {
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok || !data?.id) {
    return null;
  }

  return data;
}

async function getSingle({ supabaseUrl, serviceRole, table, filters, select = "*" }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", select);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Supabase lookup failed (${table}): ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

async function patchRows({ supabaseUrl, serviceRole, table, filters, patch }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  const r = await sbFetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  if (!r.ok) {
    throw new Error(`Supabase patch failed (${table}): ${r.status} ${r.text}`);
  }

  return r.data;
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

function fmtDateMDY(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso || "");
  return `${Number(m[2])}/${Number(m[3])}/${Number(m[1])}`;
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
  const start = fmtTime12h(s.start_time);
  const end = fmtTime12h(s.end_time);

  const window =
    start && end
      ? `${start}–${end}`
      : s.window_label
      ? String(s.window_label)
      : "Arrival window";

  return `${date} • ${window}`;
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

function centsFromApprovalValue(raw) {
  const n = Number(raw || 15000);

  if ([15000, 17500, 20000, 22500, 25000].includes(n)) return n;
  if ([150, 175, 200, 225, 250].includes(n)) return n * 100;

  return 15000;
}

function isTruthy(v) {
  return v === true || v === "true" || v === "allow" || v === 1 || v === "1";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const accessToken = getBearerToken(req);

    if (!accessToken) {
      return res.status(401).json({
        ok: false,
        error: "Missing auth token",
      });
    }

    const user = await getUserFromToken({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      accessToken,
    });

    if (!user?.id) {
      return res.status(401).json({
        ok: false,
        error: "Invalid auth token",
      });
    }

    const profile = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "profiles",
      filters: { user_id: user.id },
      select: "user_id, role",
    });

    if (profile?.role !== "property_manager") {
      return res.status(403).json({
        ok: false,
        error: "Not authorized for property manager requests",
      });
    }

    const pm = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "property_managers",
      filters: { user_id: user.id },
      select: "*",
    });

    if (!pm?.id) {
      return res.status(403).json({
        ok: false,
        error: "No property manager account found",
      });
    }

    const b = req.body || {};

    const tenantName = String(b.tenant_name || "").trim();
    const tenantPhone = String(b.tenant_phone || "").trim();
    const tenantEmail = String(b.tenant_email || "").trim();
    const serviceAddress = String(b.service_address || "").trim();
    const accessNotes = String(b.access_notes || "").trim();

    const totalJobApprovalLimitCents = centsFromApprovalValue(
      b.total_job_approval_limit_cents || b.parts_approval_limit
    );

    const addonPreapproved = isTruthy(b.addon_preapproved);

    if (!tenantName) {
      return res.status(400).json({ ok: false, error: "Tenant name is required" });
    }

    if (!tenantEmail) {
      return res.status(400).json({ ok: false, error: "Tenant email is required" });
    }

    if (!serviceAddress) {
      return res.status(400).json({ ok: false, error: "Service address is required" });
    }

    const origin = getOrigin(req);

    // Use the existing scheduling engine, but suppress public checkout email.
    const rtResp = await fetch(`${origin}/api/request-times`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: tenantName,
        phone: tenantPhone,
        email: tenantEmail,
        contact_method: "email",
        address: serviceAddress,
        appointment_type: "standard",
        suppress_delivery: true,
      }),
    });

    const rtJson = await rtResp.json().catch(() => ({}));

    if (!rtResp.ok || !rtJson?.ok) {
      return res.status(502).json({
        ok: false,
        error: "Could not generate tenant scheduling options",
        upstream: rtJson,
      });
    }

    if (!rtJson.request_id) {
      return res.status(409).json({
        ok: false,
        error: "No appointment options available",
        upstream: rtJson,
      });
    }

    const requestId = rtJson.request_id;

    // Attach the request to this property manager before sending the tenant link.
    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: requestId },
      patch: {
        property_manager_id: pm.id,
        request_source: "property_manager",
        total_job_approval_limit_cents: totalJobApprovalLimitCents,
        addon_preapproved: addonPreapproved,
        authorized_entry: false,
        notes: accessNotes || null,
        status: "pending_scheduling",
        contact_method: "email",
      },
    });

    const primary = Array.isArray(rtJson.primary) ? rtJson.primary : [];
    const more = Array.isArray(rtJson.more?.options) ? rtJson.more.options : [];
    const options = [...primary, ...more].filter((o) => o?.offer_token);

    if (!options.length) {
      return res.status(409).json({
        ok: false,
        error: "Scheduling options were created, but no valid offer tokens were returned",
        request_id: requestId,
      });
    }

    const items = options
      .map((s, i) => {
        const label = escHtml(formatSlotLine(s));
        const link = `${origin}/pm-schedule.html?token=${encodeURIComponent(s.offer_token)}`;

        return (
          `<li style="margin:12px 0;">` +
          `<strong>Option ${i + 1}: ${label}</strong><br/>` +
          `<a href="${link}">Select this appointment time</a>` +
          `</li>`
        );
      })
      .join("");

    const subject = "Choose your Dryer Dudes appointment time";

    const html =
      `<p>Hi ${escHtml(tenantName)},</p>` +
      `<p>Your property manager requested Dryer Dudes service for your dryer.</p>` +
      `<p>Please choose one of the appointment windows below. You will <strong>not</strong> be asked to pay at checkout.</p>` +
      `<ol>${items}</ol>` +
      `<p style="opacity:.85;">Reminder: the technician can arrive any time within the selected arrival window.</p>` +
      `<p>— Dryer Dudes</p>`;

    const emailResult = await sendEmailResend({
      to: tenantEmail,
      subject,
      html,
    });

    const emailSent = emailResult?.ok === true;

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: requestId },
      patch: {
        status: emailSent ? "sent" : "pending_scheduling",
        scheduling_link_sent_at: emailSent ? new Date().toISOString() : null,
      },
    });

    return res.status(200).json({
      ok: true,
      request_id: requestId,
      property_manager_id: pm.id,
      email_sent: emailSent,
      delivery: {
        emailResult,
      },
      primary,
      more,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
