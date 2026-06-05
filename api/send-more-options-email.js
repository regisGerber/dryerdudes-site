// /api/send-more-options-email.js
// Sends more appointment options by email.
// Sends a clean SMS notification without long checkout token links.

const { sendSmsTwilio } = require("./_twilio");

function getOrigin(req) {
  const host = req?.headers?.host;
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;
  return `https://${host}`;
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    Accept: "application/json",
    "Content-Type": "application/json",
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

function esc(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

function formatDateMDY(isoDate) {
  const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(isoDate || "");
  return `${Number(m[2])}/${Number(m[3])}/${Number(m[1])}`;
}

function formatTime12h(t) {
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
  const date = formatDateMDY(s.service_date);
  const start = formatTime12h(s.start_time);
  const end = formatTime12h(s.end_time);

  const time = start && end
    ? `${start}–${end}`
    : (s.window_label ? String(s.window_label) : `Slot ${s.slot_index}`);

  return `${date} • ${time}`;
}

async function sendEmailResend({ to, subject, html }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    return { skipped: true, reason: "Missing RESEND_API_KEY" };
  }

  if (!to) {
    return { skipped: true, reason: "Missing recipient email" };
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
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
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    return {
      skipped: false,
      ok: false,
      status: resp.status,
      data
    };
  }

  return {
    skipped: false,
    ok: true,
    status: resp.status,
    data
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({
        ok: false,
        error: "Missing Supabase env vars"
      });
    }

    const body = req.body || {};
    const request_id = String(body.request_id || "").trim();

    if (!request_id) {
      return res.status(400).json({
        ok: false,
        error: "request_id is required"
      });
    }

    const origin = getOrigin(req);

    const requestUrl =
      `${SUPABASE_URL}/rest/v1/booking_requests` +
      `?id=eq.${encodeURIComponent(request_id)}` +
      `&select=id,name,email,phone,contact_method,address` +
      `&limit=1`;

    const requestResp = await sbFetchJson(requestUrl, {
      headers: sbHeaders(SERVICE_ROLE),
    });

    if (!requestResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Failed to load booking request",
        status: requestResp.status,
        details: requestResp.text?.slice(0, 1500),
      });
    }

    const requestRow = Array.isArray(requestResp.data)
      ? requestResp.data[0] || null
      : null;

    if (!requestRow) {
      return res.status(404).json({
        ok: false,
        error: "Booking request not found"
      });
    }

    const customerName = String(requestRow.name || body.customer_name || "").trim();
    const niceName = customerName || "there";
    const firstName = niceName === "there" ? "there" : niceName.split(/\s+/)[0];

    const email = String(requestRow.email || body.email || "").trim();
    const phone = String(requestRow.phone || "").trim();
    const contactMethod = String(requestRow.contact_method || "both").toLowerCase();

    const useText = contactMethod === "text" || contactMethod === "both";
    const useEmail = contactMethod === "email" || contactMethod === "both";

    const authorizedLink =
      `${origin}/index.html?request=${encodeURIComponent(request_id)}` +
      `&mode=authorized#visitFlexSection`;

    const selectBase = `${origin}/checkout.html?token=`;

    const offersUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?request_id=eq.${encodeURIComponent(request_id)}` +
      `&is_active=eq.true` +
      `&select=offer_group,slot_id,offer_token,created_at` +
      `&order=offer_group.asc,created_at.asc`;

    const offersResp = await sbFetchJson(offersUrl, {
      headers: sbHeaders(SERVICE_ROLE),
    });

    if (!offersResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Failed to load offers from Supabase",
        status: offersResp.status,
        details: offersResp.text?.slice(0, 1500),
      });
    }

    const offers = Array.isArray(offersResp.data) ? offersResp.data : [];

    if (offers.length === 0) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No offers to send"
      });
    }

    const slotIds = [...new Set(
      offers.map((o) => String(o.slot_id || "").trim()).filter(Boolean)
    )];

    if (slotIds.length === 0) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "Offers had no slot_ids"
      });
    }

    const slotsUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?id=in.(${slotIds.map((id) => encodeURIComponent(id)).join(",")})` +
      `&select=id,service_date,slot_index,window_label,start_time,end_time,zone_code`;

    const slotsResp = await sbFetchJson(slotsUrl, {
      headers: sbHeaders(SERVICE_ROLE),
    });

    if (!slotsResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Failed to load schedule slots from Supabase",
        status: slotsResp.status,
        details: slotsResp.text?.slice(0, 1500),
      });
    }

    const slots = Array.isArray(slotsResp.data) ? slotsResp.data : [];
    const slotMap = new Map(slots.map((s) => [String(s.id), s]));

    const mergedOffers = offers
      .map((o) => {
        const slot = slotMap.get(String(o.slot_id || ""));
        if (!slot) return null;

        return {
          offer_group: o.offer_group,
          offer_token: o.offer_token,
          slot_id: o.slot_id,
          created_at: o.created_at,
          service_date: slot.service_date,
          slot_index: slot.slot_index,
          window_label: slot.window_label,
          start_time: slot.start_time,
          end_time: slot.end_time,
          zone_code: slot.zone_code,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        return (
          String(a.offer_group).localeCompare(String(b.offer_group)) ||
          String(a.service_date).localeCompare(String(b.service_date)) ||
          Number(a.slot_index) - Number(b.slot_index)
        );
      });

    const primary = mergedOffers
      .filter((o) => o.offer_group === "primary")
      .slice(0, 3);

    const more = mergedOffers
      .filter((o) => o.offer_group === "more")
      .slice(0, 2);

    if (primary.length === 0 && more.length === 0) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No merged offers to send"
      });
    }

    function emailBlock(title, arr) {
      if (!Array.isArray(arr) || arr.length === 0) return "";

      const items = arr.map((s) => {
        const token = s.offer_token ? String(s.offer_token) : "";
        const line = esc(formatSlotLine(s));

        if (!token) {
          return (
            `<li style="margin:10px 0;">` +
            `<strong>${line}</strong><br/>` +
            `<span style="opacity:.75;">(Link unavailable — please request new options)</span>` +
            `</li>`
          );
        }

        return (
          `<li style="margin:10px 0;">` +
          `<strong>${line}</strong><br/>` +
          `<a href="${selectBase}${encodeURIComponent(token)}">Select this option</a>` +
          `</li>`
        );
      }).join("");

      return (
        `<p style="margin:16px 0 6px;"><strong>${esc(title)}</strong></p>` +
        `<ol style="margin-top:8px;">${items}</ol>`
      );
    }

    const hello = customerName ? `Hi ${esc(customerName)},` : `Hi,`;

    const emailHtml =
      `<p>${hello}</p>` +
      `<p>Here are additional Dryer Dudes appointment options. Each option is an <strong>arrival window</strong>:</p>` +
      emailBlock("2 new options", more) +
      emailBlock("Your original options", primary) +
      `<p style="margin-top:14px;"><strong>None of these work?</strong> Authorized Entry can make scheduling easier.</p>` +
      `<p>With Authorized Entry, your tech can take care of the dryer while you are out and about, as long as we have clear access instructions.</p>` +
      `<p><a href="${authorizedLink}">Choose Authorized Entry</a></p>` +
      `<p style="opacity:.85; margin-top:14px;">Reminder: the technician can arrive any time within the window, and the repair itself may extend beyond the window.</p>` +
      `<p>— Dryer Dudes</p>`;

    const emailSubject = "More Dryer Dudes appointment options";

    const smsBody =
      `Hi ${firstName}, we sent more Dryer Dudes appointment options to your email, and they are now showing on your booking page.\n\n` +
      `If none of the 5 options work, Authorized Entry may help. Our tech can take care of the dryer while you are out and about.\n\n` +
      `Authorized Entry:\n${authorizedLink}\n\n` +
      `Reply STOP to opt out.`;

    let emailResult = { skipped: true };
    let smsResult = { skipped: true };

    if (useEmail) {
      emailResult = await sendEmailResend({
        to: email,
        subject: emailSubject,
        html: emailHtml,
      });
    }

    if (useText) {
      try {
        smsResult = await sendSmsTwilio({
          to: phone,
          body: smsBody,
        });
      } catch (smsErr) {
        smsResult = {
          skipped: false,
          ok: false,
          error: smsErr?.message || String(smsErr),
        };
      }
    }

    return res.status(200).json({
      ok: true,
      request_id,
      contact_method: contactMethod,
      delivery: {
        emailResult,
        smsResult
      },
      counts: {
        primary: primary.length,
        more: more.length
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
