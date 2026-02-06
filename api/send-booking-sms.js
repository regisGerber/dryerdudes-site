// /api/send-booking-sms.js
const twilio = require("twilio");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function toE164(phone) {
  // Very light cleanup; expects you pass +1... ideally
  if (!phone) return "";
  const p = String(phone).trim();
  if (p.startsWith("+")) return p;
  // If they pass 10 digits, assume US +1
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return p; // last resort
}

module.exports = async (req, res) => {
  try {
    // Allow GET for quick test (remove later if you want)
    let body = req.body || {};
    if (req.method === "GET") {
      body = {
        phone: process.env.TEST_TO_PHONE || "+1YOURCELLNUMBER",
        customerName: "Regis",
        service: "Dryer Repair",
        date: "Test Booking",
        timeWindow: "12–2pm",
        jobRef: "DD-TEST",
      };
    } else if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
    const authToken = requireEnv("TWILIO_AUTH_TOKEN");
    const from = requireEnv("TWILIO_FROM_NUMBER");

    const client = twilio(accountSid, authToken);

    const phone = toE164(body.phone || body.customerPhone);
    if (!phone) return res.status(400).json({ ok: false, error: "Missing phone" });

    const customerName = body.customerName || "there";
    const service = body.service || "-";
    const date = body.date || "-";
    const timeWindow = body.timeWindow || "-";
    const jobRef = body.jobRef || "DD-XXXXXX";

    const msg = `Dryer Dudes: You're booked ✅
Job ref: ${jobRef}
${service}
${date} (${timeWindow})
Reply to this text if needed.`;

    const statusCallback =
      process.env.SITE_ORIGIN
        ? `${process.env.SITE_ORIGIN}/api/twilio-status`
        : undefined;

    const result = await client.messages.create({
      from,
      to: phone,
      body: msg,
      ...(statusCallback ? { statusCallback } : {}),
    });

    return res.status(200).json({ ok: true, sid: result.sid, status: result.status });
  } catch (err) {
    console.error("send-booking-sms error:", err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
};
