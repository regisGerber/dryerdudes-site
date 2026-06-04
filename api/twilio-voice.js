// /api/twilio-voice.js
// Dryer Dudes incoming call greeting.
// No voicemail. No recording. Plays message, then hangs up.

function checkWebhookToken(req) {
  const required = process.env.TWILIO_WEBHOOK_TOKEN || "";
  if (!required) return true;

  const url = new URL(req.url || "", "https://example.com");
  return url.searchParams.get("k") === required;
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method Not Allowed");
  }

  if (!checkWebhookToken(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">
    This is Dryer Dudes, home of the eighty dollar flat rate dryer repair.
  </Say>

  <Pause length="1"/>

  <Say voice="Polly.Joanna" language="en-US">
    We're out fixing dryers, so we don't take calls.
  </Say>

  <Pause length="1"/>

  <Say voice="Polly.Joanna" language="en-US">
    Everything, pricing, availability, and scheduling, starts at Dryer Dudes dot com.
  </Say>

  <Pause length="1"/>

  <Say voice="Polly.Joanna" language="en-US">
    If you need help with an existing job, you can get your questions answered on the site using your job reference number.
  </Say>

  <Pause length="1"/>

  <Say voice="Polly.Joanna" language="en-US">
    When this call ends, we'll text you the website link.
  </Say>

  <Pause length="1"/>

  <Say voice="Polly.Joanna" language="en-US">
    Dryer Dudes. Eighty dollars plus the cost of the part gets your dryer fixed.
  </Say>

  <Hangup/>
</Response>`;

  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(twiml);
};
