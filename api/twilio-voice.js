// /api/twilio-voice.js
// Dryer Dudes incoming call greeting.
// No voicemail. No recording.
// Waits before answering, plays a natural MP3 greeting, then hangs up.

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
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method Not Allowed");
  }

  if (!checkWebhookToken(req)) {
    return res.status(403).send("Forbidden");
  }

  // About 2 rings. Ring timing varies by carrier, so adjust 6–10 seconds if needed.
  const ringDelaySeconds = 8;

  // Make sure this file exists and opens in a browser before using it.
  const greetingUrl = "https://www.dryerdudes.com/assets/phone-greeting.mp3";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="${ringDelaySeconds}"/>
  <Play>${xmlEscape(greetingUrl)}</Play>
  <Hangup/>
</Response>`;

  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(twiml);
};
