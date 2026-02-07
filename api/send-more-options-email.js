// /api/send-more-options-email.js
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

    if (!request_id) return res.status(400).json({ ok: false, error: "request_id is required" });
    if (!email) return res.status(400).json({ ok: false, error: "email is required" });

    // Prefer explicit SITE_ORIGIN (set in Vercel env), otherwise fall back to host
    const origin = process.env.SITE_ORIGIN
      ? String(process.env.SITE_ORIGIN).replace(/\/+$/, "")
      : `https://${req.headers.host}`;

    console.log("send-more-options-email: start", { request_id, email, origin });

    // --- helpers ---
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
      const time = start && end ? `${start}–${end}` : (s.window_label ? String(s.window_label) : `Slot ${s.slot_index}`);
      return `${date} • ${time}`;
    }

    const hello = customer_name ? `Hi ${esc(customer_name)},` : `Hi,`;

    // IMPORTANT: match your anchor id in index.html
    // You previously referenced #visitFlexSection – keep that consistent.
    const authorizedLink =
      `${origin}/index.html?request=${encodeURIComponent(request_id)}` +
      `&mode=authorized#visitFlexSection`;

    const selectBase = `${origin}/checkout.html?token=`;

    function block(title, arr) {
      if (!Array.isArray(arr) || arr.length === 0) return "";

      const items = arr.map((s) => {
        const token = s.offer_token ? String(s.offer_token) : "";
        const line = esc(formatSlotLine(s));

        // If token missing, show the slot but don’t create a broken link
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

    // --- Fetch offers (primary + more) from Supabase ---
    const offersUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?request_id=eq.${encodeURIComponent(request_id)}` +
      `&select=offer_group,service_date,slot_index,window_label,start_time,end_time,offer_token` +
      `&order=offer_group.asc,service_date.asc,slot_index.asc`;

    const offersResp = await fetch(offersUrl, {
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
      },
    });

    const offersText = await offersResp.text();
    let offers;
    try {
      offers = offersText ? JSON.parse(offersText) : [];
    } catch {
      offers = null;
    }

    if (!offersResp.ok) {
      console.log("send-more-options-email: supabase error", {
        status: offersResp.status,
        body: offersText?.slice(0, 800),
      });
      return res.status(500).json({
        ok: false,
        error: "Failed to load offers from Supabase",
        status: offersResp.status,
      });
    }

    if (!Array.isArray(offers)) {
      console.log("send-more-options-email: offers not array", { offersText: offersText?.slice(0, 800) });
      return res.status(500).json({ ok: false, error: "Supabase returned unexpected offers payload" });
    }

    const primary = offers.filter((o) => o.offer_group === "primary").slice(0, 3);
    const more = offers.filter((o) => o.offer_group === "more").slice(0, 2);

    console.log("send-more-options-email: offers loaded", {
      primaryCount: primary.length,
      moreCount: more.length,
    });

    if (primary.length === 0 && more.length === 0) {
      return res.status(200).json({ ok: true, skipped: true, reason: "No offers to send" });
    }

    // --- Build email HTML ---
    const emailHtml =
      `<p>${hello}</p>` +
      `<p>Here are additional appointment options (each is an <strong>arrival window</strong>):</p>` +
      block("2 new options", more) +
      block("Your original options", primary) +
      `<p style="margin-top:14px;"><strong>None of these work?</strong> Authorized entry can make scheduling easier.</p>` +
      `<p><a href="${authorizedLink}">Choose Authorized Entry</a></p>` +
      `<p style="opacity:.85; margin-top:14px;">Reminder: the technician can arrive any time within the window, and the repair itself may extend beyond the window.</p>` +
      `<p>— Dryer Dudes</p>`;

    const subject = "More Dryer Dudes appointment options";

    // --- Send via Resend ---
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
      console.log("send-more-options-email: resend error", {
        status: sendResp.status,
        body: String(sendText || "").slice(0, 800),
      });
      return res.status(500).json({
        ok: false,
        error: "Resend failed",
        status: sendResp.status,
      });
    }

    console.log("send-more-options-email: success", { request_id, email });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("send-more-options-email: server error", { message: err?.message, stack: err?.stack });
    return res.status(500).json({ ok: false, error: "Server error", message: err?.message || String(err) });
  }
}
