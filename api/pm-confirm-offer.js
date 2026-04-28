import crypto from "crypto";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function base64urlToJson(b64url) {
  const b64 =
    String(b64url || "").replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((String(b64url || "").length + 3) % 4);

  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function verifyToken(token, secret) {
  const [payloadB64, sigB64] = String(token || "").split(".");

  if (!payloadB64 || !sigB64) {
    return { ok: false, message: "Bad token format" };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  if (expected !== sigB64) {
    return { ok: false, message: "Invalid signature" };
  }

  const payload = base64urlToJson(payloadB64);

  if (payload?.exp && Date.now() > Number(payload.exp)) {
    return { ok: false, message: "Token expired" };
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
    data = { raw: text };
  }

  return { ok: resp.ok, status: resp.status, data, text };
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

async function insertRow({ supabaseUrl, serviceRole, table, row }) {
  const r = await sbFetchJson(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  if (!r.ok) {
    throw new Error(`Supabase insert failed (${table}): ${r.status} ${r.text}`);
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

function makeLocalTs(serviceDate, hhmmss, offset) {
  if (!serviceDate || !hhmmss) return null;

  const raw = String(hhmmss).slice(0, 8);
  const m = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!m) return null;

  const hh = m[1];
  const mm = m[2];
  const ss = m[3] || "00";

  return `${serviceDate}T${hh}:${mm}:${ss}${offset}`;
}

function makeJobRef() {
  return `DD-${Math.floor(100000 + Math.random() * 900000)}`;
}

function makeSlotCode({ zoneCode, serviceDate, startTime, endTime }) {
  const s = String(startTime || "").slice(0, 5).replace(":", "");
  const e = String(endTime || "").slice(0, 5).replace(":", "");
  return `${zoneCode || "Z"}-${serviceDate}-${s}-${e}`;
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

async function sendConfirmationEmail({ to, name, jobRef, serviceDate, startTime, endTime, address }) {
  const key = process.env.RESEND_API_KEY;

  if (!key || !to) {
    return { skipped: true };
  }

  const html =
    `<p>Hi ${escHtml(name || "there")},</p>` +
    `<p>Your Dryer Dudes appointment has been scheduled.</p>` +
    `<ul>` +
    `<li><strong>Date:</strong> ${escHtml(fmtDateMDY(serviceDate))}</li>` +
    `<li><strong>Arrival window:</strong> ${escHtml(fmtTime12h(startTime))}–${escHtml(fmtTime12h(endTime))}</li>` +
    `<li><strong>Address:</strong> ${escHtml(address)}</li>` +
    `<li><strong>Job reference:</strong> ${escHtml(jobRef)}</li>` +
    `</ul>` +
    `<p>You will not be asked to pay online. Billing is handled through your property manager.</p>` +
    `<p>— Dryer Dudes</p>`;

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
      subject: `Dryer Dudes appointment scheduled — ${jobRef}`,
      html,
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return { skipped: false, ok: false, status: resp.status, data };
  }

  return { skipped: false, ok: true, status: resp.status, data };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const TZ_OFFSET = String(process.env.LOCAL_TZ_OFFSET || "-08:00");

    const token = String(req.body?.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Missing token",
      });
    }

    const verified = verifyToken(token, TOKEN_SECRET);

    if (!verified.ok) {
      return res.status(400).json({
        ok: false,
        error: verified.message,
      });
    }

    const offer = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_request_offers",
      filters: { offer_token: token },
      select: "id, request_id, offer_token, is_active, appointment_type, route_zone_code, slot_id",
    });

    if (!offer) {
      return res.status(404).json({
        ok: false,
        error: "Offer not found",
      });
    }

    if (!offer.is_active) {
      return res.status(409).json({
        ok: false,
        error: "This appointment option is no longer available.",
      });
    }

    const request = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: offer.request_id },
      select: "id, name, phone, email, address, appointment_type, status, property_manager_id, request_source, home_location_code",
    });

    if (!request) {
      return res.status(404).json({
        ok: false,
        error: "Request not found",
      });
    }

    if (request.request_source !== "property_manager" || !request.property_manager_id) {
      return res.status(403).json({
        ok: false,
        error: "This is not a property manager scheduling request.",
      });
    }

    const slot = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "schedule_slots",
      filters: { id: offer.slot_id },
      select: "id, service_date, slot_index, zone_code, window_label, start_time, end_time, is_booked, tech_id",
    });

    if (!slot) {
      return res.status(404).json({
        ok: false,
        error: "Schedule slot not found",
      });
    }

    if (slot.is_booked) {
      return res.status(409).json({
        ok: false,
        error: "That appointment time was just taken. Please choose another option.",
      });
    }

    let techId = slot.tech_id || null;

    if (!techId) {
      const zta = await getSingle({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "zone_tech_assignments",
        filters: { zone_code: slot.zone_code },
        select: "zone_code, tech_id",
      });

      techId = zta?.tech_id || null;
    }

    if (!techId) {
      return res.status(500).json({
        ok: false,
        error: "No technician is assigned for this appointment slot.",
      });
    }

    const tech = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "techs",
      filters: { id: techId },
      select: "id, user_id, active",
    });

    const appointmentType = offer.appointment_type || request.appointment_type || "standard";
    const fullServiceCents = appointmentType === "full_service" ? 2000 : 0;

    const windowStart = makeLocalTs(slot.service_date, slot.start_time, TZ_OFFSET);
    const windowEnd = makeLocalTs(slot.service_date, slot.end_time, TZ_OFFSET);

    if (!windowStart || !windowEnd) {
      return res.status(500).json({
        ok: false,
        error: "Could not build appointment window timestamp.",
      });
    }

    const jobRef = makeJobRef();

    const booking = await insertRow({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      row: {
        request_id: request.id,
        selected_option_id: offer.id,
        window_start: windowStart,
        window_end: windowEnd,
        slot_code: makeSlotCode({
          zoneCode: slot.zone_code,
          serviceDate: slot.service_date,
          startTime: slot.start_time,
          endTime: slot.end_time,
        }),
        zone_code: slot.zone_code,
        payment_status: "pm_billing",
        base_fee_cents: 8000,
        full_service_cents: fullServiceCents,
        collected_cents: 0,
        status: "scheduled",
        appointment_type: appointmentType,
        job_ref: jobRef,
        home_location_code: request.home_location_code || null,
        route_zone_code: offer.route_zone_code || slot.zone_code,
        assigned_tech_id: tech?.user_id || null,
        tech_id: techId,
        slot_id: slot.id,
        property_manager_id: request.property_manager_id,
        request_source: "property_manager",
        invoice_status: "unbilled",
        paid_by_property_manager: true,
      },
    });

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "schedule_slots",
      filters: { id: slot.id },
      patch: {
        is_booked: true,
        booking_id: booking.id,
        booked_at: new Date().toISOString(),
      },
    });

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_request_offers",
      filters: { request_id: request.id },
      patch: {
        is_active: false,
      },
    });

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: request.id },
      patch: {
        status: "scheduled",
        selected_slot_at: new Date().toISOString(),
      },
    });

    const confirmationEmail = await sendConfirmationEmail({
      to: request.email,
      name: request.name,
      jobRef,
      serviceDate: slot.service_date,
      startTime: slot.start_time,
      endTime: slot.end_time,
      address: request.address,
    });

    return res.status(200).json({
      ok: true,
      booking_id: booking.id,
      job_ref: jobRef,
      confirmationEmail,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
