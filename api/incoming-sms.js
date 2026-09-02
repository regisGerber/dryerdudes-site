function xmlEscape(value) {
  return String(value || "").replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[character]);
}

function readIncomingBody(req) {
  if (req.body && typeof req.body === "object") {
    return String(req.body.Body || req.body.body || "").trim();
  }

  if (typeof req.body === "string") {
    const params = new URLSearchParams(req.body);
    return String(params.get("Body") || params.get("body") || "").trim();
  }

  return "";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "GET") {
    return res.status(200).send(
      "Dryer Dudes inbound SMS webhook is ready. Configure the Twilio number's incoming-message webhook to POST to /api/incoming-sms."
    );
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method Not Allowed");
  }

  const incoming = readIncomingBody(req).toUpperCase();
  const optOutWords = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

  res.setHeader("Content-Type", "text/xml; charset=utf-8");

  if (optOutWords.has(incoming)) {
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  const message =
    "Thanks for texting Dryer Dudes. Service information, pricing, FAQs, and online booking are at https://www.dryerdudes.com/. " +
    "Already have a job? Use your job reference number at https://www.dryerdudes.com/job-help.html to ask a question or get appointment help. " +
    "Reply STOP to opt out.";

  return res
    .status(200)
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`
    );
};
