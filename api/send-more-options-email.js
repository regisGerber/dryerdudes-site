// /api/send-more-options-email.js

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
    data = null;
  }

  return { ok: resp.ok, status: resp.status, data, text };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: "Missing Supabase env vars" });
    }
    if (!RESEND_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing RESEND_API_KEY" });
    }

    const body = req.body || {};
    const request_id = String(body.request_id || "").trim();
    const email = String(body.email || "").trim();
    const customer_name = String(body.customer_name || "").trim();

    if (!request_id) {
      return res.status(400).json({ ok: false, error: "request_id is required" });
    }
    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const origin = getOrigin(req);

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

    const hello = customer_name ? `Hi ${esc(customer_name)},` : `Hi,`;

    const authorizedLink =
      `${origin}/index.html?request=${encodeURIComponent(request_id)}` +
      `&mode=authorized#visitFlexSection`;

    const selectBase = `${origin}/checkout.html?token=`;

    // 1) Fetch lean offers
    const offersUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?request_id=eq.${encodeURIComponent(request_id)}` +
      `&is_active=eq.true` +
      `&select=offer_group,slot_id,offer_token` +
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
      return res.status(200).json({ ok: true, skipped: true, reason: "No offers to send" });
    }

    // 2) Fetch slot details from schedule_slots
    const slotIds = [...new Set(
      offers.map((o) => String(o.slot_id || "").trim()).filter(Boolean)
    )];

    if (slotIds.length === 0) {
      return res.status(200).json({ ok: true, skipped: true, reason: "Offers had no slot_ids" });
    }

    const slotIdsCsv = slotIds.map((id) => `"${id}"`).join(",");
    const slotsUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?id=in.(${encodeURIComponent(slotIdsCsv)})` +
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
    const slotMap = new Map(
      slots.map((s) => [String(s.id), s])
    );

    // 3) Merge offers + slot details
    const mergedOffers = offers
      .map((o) => {
        const slot = slotMap.get(String(o.slot_id || ""));
        if (!slot) return null;
        return {
          offer_group: o.offer_group,
          offer_token: o.offer_token,
          slot_id: o.slot_id,
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

    const primary = mergedOffers.filter((o) => o.offer_group === "primary").slice(0, 3);
    const more = mergedOffers.filter((o) => o.offer_group === "more").slice(0, 2);

    if (primary.length === 0 && more.length === 0) {
      return res.status(200).json({ ok: true, skipped: true, reason: "No merged offers to send" });
    }

    function block(title, arr) {
      if (!Array.isArray(arr) || arr.length === 0) return "";

      const items = arr.map((s) => {
        const token = s.offer_token ? String(s.offer_token) : "";
        const line = esc(formatSlotLine(s));

        if (!token) {
          return (
            `<li style="margin:10px 0;">` +
            `<strong>${line}</strong><br/>` +
            `<span style="opacity:.75;">(Link unavailable — please reply to this email)</span>` +
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

    const emailHtml =
      `<p>${hello}</p>` +
      `<p>Here are additional appointment options. Each option is an <strong>arrival window</strong>:</p>` +
      block("2 new options", more) +
      block("Your original options", primary) +
      `<p style="margin-top:14px;"><strong>None of these work?</strong> Authorized entry can make scheduling easier.</p>` +
      `<p><a href="${authorizedLink}">Choose Authorized Entry</a></p>` +
      `<p style="opacity:.85; margin-top:14px;">Reminder: the technician can arrive any time within the window, and the repair itself may extend beyond the window.</p>` +
      `<p>— Dryer Dudes</p>`;

    const subject = "More Dryer Dudes appointment options";

    const sendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Dryer Dudes <no-reply@dryerdudes.com>",
        to: [email],
        subject,
        html: emailHtml,
      }),
    });

    const sendText = await sendResp.text();
    let sendData;
    try {
      sendData = sendText ? JSON.parse(sendText) : {};
    } catch {
      sendData = { raw: sendText };
    }

    if (!sendResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Resend failed",
        status: sendResp.status,
        details: sendData,
      });
    }

    return res.status(200).json({ ok: true, resend: sendData });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
