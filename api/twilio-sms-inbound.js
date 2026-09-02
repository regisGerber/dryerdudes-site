// /api/twilio-sms-inbound.js
// Auto-replies to incoming texts with website and job-help links.

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function checkWebhookToken(req) {
  const required = process.env.TWILIO_WEBHOOK_TOKEN || "";
  if (!required) return true;

  const url = new URL(req.url || "", "https://example.com");
  return url.searchParams.get("k") === required;
}

function isOptOutMessage(body) {
  const incoming = String(body || "").trim().toUpperCase();
  return new Set([
    "STOP",
    "STOPALL",
    "UNSUBSCRIBE",
    "CANCEL",
    "END",
    "QUIT",
  ]).has(incoming);
}

function buildReply() {
  return (
    "Thanks for texting Dryer Dudes. All relevant service information and online booking are available at " +
    "https://www.dryerdudes.com/. If you already have a job, use your job reference number at " +
    "https://www.dryerdudes.com/job-help.html to ask a question or get appointment help. " +
    "Reply STOP to opt out."
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  if (!checkWebhookToken(req)) {
    return res.status(403).send("Forbidden");
  }

  let params = {};
  try {
    const raw = await getRawBody(req);
    params = Object.fromEntries(new URLSearchParams(raw));
  } catch {
    params = {};
  }

  res.setHeader("Content-Type", "text/xml; charset=utf-8");

  // Twilio manages standard opt-out behavior. Do not send an extra business reply.
  if (isOptOutMessage(params.Body || "")) {
    return res
      .status(200)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  const reply = buildReply();

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${xmlEscape(reply)}</Message>
</Response>`;

  return res.status(200).send(twiml);
};
