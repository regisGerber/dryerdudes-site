// /api/send-booking-sms.js
const { sendSmsTwilio } = require("./_twilio");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const {
      toPhone,
      customerName,
      serviceDate,     // "2026-02-09"
      arrivalStart,    // "10:00"
      arrivalEnd,      // "12:00"
      addressLine,     // single line is fine
      jobRef,          // "DD-123456"
    } = req.body || {};

    if (!toPhone) return res.status(400).json({ ok: false, error: "missing_toPhone" });
    if (!serviceDate || !arrivalStart || !arrivalEnd) {
      return res.status(400).json({ ok: false, error: "missing_arrival_window_fields" });
    }
    if (!jobRef) return res.status(400).json({ ok: false, error: "missing_jobRef" });

    const name = String(customerName || "there").trim();

    const body =
      `Dryer Dudes — you’re booked ✅\n` +
      `\nHi ${name},` +
      `\n\nArrival window: ${arrivalStart}–${arrivalEnd} on ${serviceDate}` +
      (addressLine ? `\nAddress: ${addressLine}` : "") +
      `\nJob ref: ${jobRef}` +
      `\n\nReply STOP to opt out.`;

    const tw = await sendSmsTwilio({ to: toPhone, body });

    return res.status(200).json({ ok: true, twilio: { sid: tw.sid, status: tw.status } });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || String(err) });
  }
};
