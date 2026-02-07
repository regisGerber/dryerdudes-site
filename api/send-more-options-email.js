// /api/send-more-options-email.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Missing Supabase env vars");
    if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");

    const { request_id, email, customer_name } = req.body || {};
    if (!request_id) return res.status(400).json({ error: "request_id is required" });
    if (!email) return res.status(400).json({ error: "email is required" });

    const origin = `https://${req.headers.host}`;

    // Fetch offers (primary + more)
    const offersResp = await fetch(
      `${SUPABASE_URL}/rest/v1/booking_request_offers?request_id=eq.${encodeURIComponent(
        request_id
      )}&select=offer_group,service_date,slot_index,window_label,start_time,end_time,offer_token&order=offer_group.asc,service_date.asc,slot_index.asc`,
      {
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: `Bearer ${SERVICE_ROLE}`,
        },
      }
    );

    const offers = await offersResp.json();
    if (!offersResp.ok) {
      return res.status(500).json({ error: "Failed to load offers", details: offers });
    }

    const primary = offers.filter((o) => o.offer_group === "primary").slice(0, 3);
    const more = offers.filter((o) => o.offer_group === "more").slice(0, 2);

    if (primary.length === 0 && more.length === 0) {
      return res.status(200).json({ ok: true, skipped: true, reason: "No offers to send" });
    }

    function esc(s) {
      return String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    }

    function formatDateMDY(isoDate) {
      const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return isoDate;
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
      const time = start && end ? `${start}–${end}` : `Slot ${s.slot_index}`;
      return `${date} • ${time}`;
    }

    const selectBase = `${origin}/checkout.html?token=`;
    const hello = customer_name ? `Hi ${esc(customer_name)},` : `Hi,`;

    const authorizedLink = `${origin}/index.html?request=${encodeURIComponent(
      request_id
    )}&mode=authorized#visitFlexSection`;

    const block = (title, arr) => {
      if (!arr.length) return "";
      return (
        `<p style="margin:16px 0 6px;"><strong>${esc(title)}</strong></p>` +
        `<ol style="margin-top:8px;">` +
        arr
          .map(
            (s) =>
              `<li style="margin:10px 0;">` +
              `<strong>${esc(formatSlotLine(s))}</strong><br/>` +
              `<a href="${selectBase}${encodeURIComponent(s.offer_token)}">Select this option</a>` +
              `</li>`
          )
          .join("") +
        `</ol>`
      );
    };

    const emailHtml =
      `<p>${hello}</p>` +
      `<p>Here are a couple additional appointment options (each is an <strong>arrival window</strong>):</p>` +
      block("Additional options", more) +
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

    const sendData = await sendResp.json();
    if (!sendResp.ok) {
      return res.status(500).json({ error: "Resend failed", details: sendData });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Server error", message: err?.message || String(err) });
  }
}
