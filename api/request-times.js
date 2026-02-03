// /api/request-times.js
import crypto from "crypto";

// -------------------- helpers --------------------
function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signToken(payloadObj, secret) {
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${payload}.${sig}`;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function supabaseInsert({ table, row, serviceRole, supabaseUrl }) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Supabase insert failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }
  return data?.[0] ?? null;
}

async function supabaseInsertMany({ table, rows, serviceRole, supabaseUrl }) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Supabase insertMany failed (${table}): ${resp.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// Optional: Twilio SMS (only runs if env vars exist)
async function sendSmsTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return { skipped: true, reason: "Twilio env vars not set" };

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Body: body,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) return { skipped: false, ok: false, data };
  return { skipped: false, ok: true, data };
}

// Optional: Resend email (only runs if env var exists)
async function sendEmailResend({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true, reason: "RESEND_API_KEY not set" };

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Dryer Dudes <no-reply@dryerdudes.com>",
      to: [to],
      subject,
      html,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) return { skipped: false, ok: false, data };
  return { skipped: false, ok: true, data };
}

function formatSlotLine(s) {
  // Expecting slot data like: { service_date, slot_index, window_label, start_time, end_time }
  const date = s.service_date;
  const label = s.window_label ? ` (${s.window_label})` : "";
  const start = s.start_time ? String(s.start_time).slice(0, 5) : "";
  const end = s.end_time ? String(s.end_time).slice(0, 5) : "";
  const time = start && end ? `${start}-${end}` : `slot ${s.slot_index}`;
  return `${date} • ${time}${label}`;
}

// -------------------- handler --------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const {
      name = "",
      phone = "",
      email = "",
      contact_method = "text", // text | email | both
      address = "",
      appointment_type = "standard", // standard | full_service | no_one_home | parts_in
    } = req.body || {};

    const cleanAddress = String(address || "").trim();
    if (!cleanAddress) {
      return res.status(400).json({ error: "address is required" });
    }

    const cm = String(contact_method || "text").toLowerCase();
    const useText = cm === "text" || cm === "both";
    const useEmail = cm === "email" || cm === "both";

    if (useText && !String(phone).trim()) {
      return res.status(400).json({ error: "phone is required for text/both" });
    }
    if (useEmail && !String(email).trim()) {
      return res.status(400).json({ error: "email is required for email/both" });
    }

    // 1) Resolve zone from address using your existing endpoint
    // NOTE: This assumes /api/resolve-zone?address=... returns {lat,lng,zone_code,zone_name}
    const origin = `https://${req.headers.host}`;
    const rzResp = await fetch(`${origin}/api/resolve-zone?address=${encodeURIComponent(cleanAddress)}`);
    const rz = await rzResp.json();
    if (!rzResp.ok) {
      return res.status(502).json({ error: "resolve-zone failed", details: rz });
    }

    const zone = rz.zone_code;
    if (!zone) {
      return res.status(400).json({ error: "Could not resolve zone for address", details: rz });
    }

    // 2) Get slots from your existing endpoint
    // /api/get-available-slots?zone=B&type=standard
    const slotsResp = await fetch(
      `${origin}/api/get-available-slots?zone=${encodeURIComponent(zone)}&type=${encodeURIComponent(appointment_type)}`
    );
    const slotsJson = await slotsResp.json();
    if (!slotsResp.ok) {
      return res.status(502).json({ error: "get-available-slots failed", details: slotsJson });
    }

    const primary = Array.isArray(slotsJson.primary) ? slotsJson.primary : [];
    const moreOptions = Array.isArray(slotsJson.more?.options) ? slotsJson.more.options : [];

    if (primary.length < 1) {
      return res.status(200).json({
        zone,
        message: "No slots available right now.",
        details: slotsJson,
      });
    }

    // 3) Store request
    const requestRow = await supabaseInsert({
      table: "booking_requests",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      row: {
        name: String(name || "").trim() || null,
        phone: String(phone || "").trim() || null,
        email: String(email || "").trim() || null,
        contact_method: cm,
        address: cleanAddress,
        appointment_type: String(appointment_type || "standard"),
        lat: typeof rz.lat === "number" ? rz.lat : null,
        lng: typeof rz.lng === "number" ? rz.lng : null,
        zone_code: rz.zone_code || null,
        zone_name: rz.zone_name || null,
        status: "sent",
      },
    });

    const requestId = requestRow.id;

    // 4) Create offer tokens + store offers
    const now = Date.now();
    const expiresAt = now + 1000 * 60 * 60 * 24 * 3; // 3 days

    const offersToStore = [];

    function makeOffer(slot, group) {
      const payload = {
        v: 1,
        request_id: requestId,
        appointment_type,
        zone: slot.zone_code || zone,
        service_date: slot.service_date,
        slot_index: slot.slot_index,
        exp: expiresAt,
      };
      const token = signToken(payload, TOKEN_SECRET);

      offersToStore.push({
        request_id: requestId,
        offer_group: group,
        service_date: slot.service_date,
        slot_index: slot.slot_index,
        zone_code: slot.zone_code || zone,
        offer_token: token,
      });

      return { ...slot, offer_token: token };
    }

    const primaryWithTokens = primary.slice(0, 3).map((s) => makeOffer(s, "primary"));

    // For now, store the “more” options you actually return (even if only 1)
    const moreWithTokens = moreOptions.map((s) => makeOffer(s, "more"));

    await supabaseInsertMany({
      table: "booking_request_offers",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
      rows: offersToStore,
    });

    // 5) Build message content (text + email)
    // Checkout link will be added later; for now we send a "select" link placeholder that includes token.
    // You’ll later create /checkout.html that reads token and starts payment.
    const selectBase = `${origin}/checkout.html?token=`;

    const lines = primaryWithTokens.map((s, i) => {
      const pick = `Option ${i + 1}: ${formatSlotLine(s)}\n${selectBase}${encodeURIComponent(s.offer_token)}`;
      return pick;
    });

    const moreLine = slotsJson.more?.show_no_one_home_cta
      ? `\nMore options: ${origin}/more-options.html?request=${encodeURIComponent(requestId)}`
      : "";

    const smsBody =
      `Dryer Dudes — your best appointment windows:\n\n` +
      lines.join("\n\n") +
      moreLine +
      `\n\nReply STOP to opt out.`;

    const emailSubject = "Your Dryer Dudes appointment options";
    const emailHtml =
      `<p>Here are your best appointment windows:</p>` +
      `<ol>` +
      primaryWithTokens
        .map(
          (s) =>
            `<li><strong>${formatSlotLine(s)}</strong><br/>` +
            `<a href="${selectBase}${encodeURIComponent(s.offer_token)}">Select this time</a></li>`
        )
        .join("") +
      `</ol>` +
      (moreLine ? `<p><a href="${origin}/more-options.html?request=${encodeURIComponent(requestId)}">More options</a></p>` : "") +
      `<p>— Dryer Dudes</p>`;

    // 6) Send (or skip if providers not configured yet)
    const smsResult = useText ? await sendSmsTwilio({ to: String(phone).trim(), body: smsBody }) : { skipped: true };
    const emailResult = useEmail
      ? await sendEmailResend({ to: String(email).trim(), subject: emailSubject, html: emailHtml })
      : { skipped: true };

    return res.status(200).json({
      ok: true,
      request_id: requestId,
      zone: rz.zone_code,
      appointment_type,
      primary: primaryWithTokens,
      more: { ...slotsJson.more, options: moreWithTokens },

      // helpful for testing even if Twilio/Resend aren't configured yet:
      preview: {
        smsBody,
        emailSubject,
        emailHtml,
      },
      delivery: { smsResult, emailResult },
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", message: err?.message || String(err) });
  }
}
