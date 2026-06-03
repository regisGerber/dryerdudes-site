// /api/twilio-call-status.js
// Sends caller a text after the call ends.

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function checkWebhookToken(req) {
  const required = process.env.TWILIO_WEBHOOK_TOKEN || "";
  if (!required) return true;

  const url = new URL(req.url || "", "https://example.com");
  return url.searchParams.get("k") === required;
}

function normalizeUSPhone(value) {
  const raw = String(value || "").trim();

  if (raw.startsWith("+")) return raw;

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return raw;
}

async function sendSms({ to, body }) {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");

  const fromNumber = process.env.TWILIO_PHONE_NUMBER || "";
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || "";

  if (!to) {
    throw new Error("Missing recipient phone number.");
  }

  if (!messagingServiceSid && !fromNumber) {
    throw new Error("Missing TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID.");
  }

  const params = new URLSearchParams();

  if (messagingServiceSid) {
    params.set("MessagingServiceSid", messagingServiceSid);
  } else {
    params.set("From", fromNumber);
  }

  params.set("To", normalizeUSPhone(to));
  params.set("Body", body);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    }
  );

  const text = await resp.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(`Twilio SMS failed: ${resp.status} ${text}`);
  }

  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  if (!checkWebhookToken(req)) {
    return res.status(403).send("Forbidden");
  }

  try {
    const raw = await getRawBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));

    const callStatus = String(params.CallStatus || "").toLowerCase();
    const from = params.From || "";

    // Only text once the call is complete.
    if (callStatus !== "completed") {
      return res.status(200).json({
        ok: true,
        ignored: true,
        callStatus,
      });
    }

    // Do not try to text anonymous/blocked callers.
    if (!from || String(from).toLowerCase() === "anonymous") {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "No caller number available.",
      });
    }

    const body =
      "Thanks for calling Dryer Dudes. " +
      "Book online: https://www.dryerdudes.com/#book " +
      "Existing appointment help, cancellation, rescheduling info, or authorized entry: https://www.dryerdudes.com/job-help.html " +
      "Reply STOP to opt out.";

    const sms = await sendSms({
      to: from,
      body,
    });

    return res.status(200).json({
      ok: true,
      sent: true,
      sid: sms?.sid || null,
      to: from,
    });
  } catch (err) {
    console.error("twilio-call-status failed", err);

    // Return 200 so Twilio does not keep retrying forever for a customer-facing call.
    return res.status(200).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
};
