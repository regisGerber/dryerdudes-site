// /api/twilio-sms-inbound.js
// Auto-replies to incoming texts with website links.

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

function buildReply(body) {
  const text = String(body || "").toLowerCase();

  if (text.includes("cancel")) {
    return "To cancel or get appointment help, use your Dryer Dudes job number here: https://www.dryerdudes.com/job-help.html";
  }

  if (text.includes("reschedule") || text.includes("resched")) {
    return "For rescheduling information, use Appointment Help with your job number: https://www.dryerdudes.com/job-help.html";
  }

  if (text.includes("book") || text.includes("schedule") || text.includes("appointment")) {
    return "Book Dryer Dudes online here: https://www.dryerdudes.com/#book Existing appointment help: https://www.dryerdudes.com/job-help.html";
  }

  if (text.includes("price") || text.includes("cost")) {
    return "Dryer Dudes is $80 for diagnosis and labor. Parts, if needed, are separate. Book online: https://www.dryerdudes.com/#book";
  }

  return "Thanks for texting Dryer Dudes. Book online: https://www.dryerdudes.com/#book Existing appointment help: https://www.dryerdudes.com/job-help.html Reply STOP to opt out.";
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

  const reply = buildReply(params.Body || "");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${xmlEscape(reply)}</Message>
</Response>`;

  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(twiml);
};
