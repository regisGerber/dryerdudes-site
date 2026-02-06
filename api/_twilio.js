// /api/_twilio.js
// Shared Twilio helper (CommonJS) — safe for Vercel

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizeE164US(phoneRaw) {
  const p = String(phoneRaw || "").trim();
  if (!p) return "";
  // If user already entered +1...
  if (p.startsWith("+")) return p;

  // Strip non-digits
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return p; // fallback; Twilio may reject if invalid
}

async function sendSmsTwilio({ to, body, statusCallbackUrl }) {
  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const token = requireEnv("TWILIO_AUTH_TOKEN");
  const from = requireEnv("TWILIO_FROM_NUMBER");

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  const params = new URLSearchParams({
    From: from,
    To: normalizeE164US(to),
    Body: String(body || ""),
  });

  // Optional: delivery status callback (you can leave it blank)
  if (statusCallbackUrl) params.set("StatusCallback", statusCallbackUrl);

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const data = await resp.json();
  if (!resp.ok) {
    const msg = `Twilio send failed: ${resp.status} ${JSON.stringify(data)}`;
    throw new Error(msg.slice(0, 800));
  }

  return data; // includes sid, status, etc.
}

module.exports = { sendSmsTwilio, normalizeE164US };
