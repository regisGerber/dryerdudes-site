// /api/twilio-voice.js
// Answers incoming calls with an informational message only.
// No voicemail. No recording.

module.exports.config = {
  api: { 
    bodyParser: false,
  },
};

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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  if (!checkWebhookToken(req)) {
    return res.status(403).send("Forbidden");
  }

  const message = `
    Thanks for calling Dryer Dudes.

    To keep repair prices low, scheduling and appointment help are handled through our website.

    For a new appointment, go to Dryer Dudes dot com and choose Book Now.

    If you already have an appointment, use Appointment Help with your job number.
    You can ask questions, cancel, review rescheduling information, or authorize entry through the website.

    When this call ends, we will text you the links.

    Goodbye.
  `;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${xmlEscape(message)}</Say>
  <Hangup/>
</Response>`;

  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(twiml);
};
