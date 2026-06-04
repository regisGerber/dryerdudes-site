// /api/twilio-voice.js
// Dryer Dudes incoming call handler.
// No voicemail. No recording.
// This test version does not require env vars or a webhook token.

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

module.exports = async function handler(req, res) {
  // Allow GET too, so you can test this in a browser.
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method Not Allowed");
  }

  const message = `
    Thanks for calling Dryer Dudes.

    To keep repair prices low, scheduling and appointment help are handled through our website.

    For a new appointment, go to Dryer Dudes dot com and choose Book Now.

    If you already have an appointment, use Appointment Help with your job number.
    You can ask questions, cancel, review rescheduling information, or authorize entry through the website.

    When this call ends, we will text you the website links.

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
