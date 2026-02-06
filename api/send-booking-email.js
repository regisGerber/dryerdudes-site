// /api/send-booking-email.js
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

function makeJobRef() {
  return `DD-${Date.now().toString().slice(-6)}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const {
      customerEmail,
      customerName,
      service,
      date,
      timeWindow,
      address,
      notes,
      jobRef: jobRefFromBody,
    } = req.body || {};

    if (!customerEmail) {
      return res.status(400).json({ success: false, error: "Missing customerEmail" });
    }

    const jobRef = jobRefFromBody || makeJobRef();

    const subject = `Booking confirmed - Dryer Dudes (Job #${jobRef})`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.4;">
        <h2>You're booked ✅</h2>

        <p style="margin: 0 0 12px 0;">
          <b>Job Reference:</b> ${jobRef}
        </p>

        <p>Hi ${customerName || "there"},</p>

        <p>Thanks for booking with <b>Dryer Dudes</b>. Here are your details:</p>

        <ul>
          <li><b>Service:</b> ${service || "-"}</li>
          <li><b>Date:</b> ${date || "-"}</li>
          <li><b>Time window:</b> ${timeWindow || "-"}</li>
          <li><b>Address:</b> ${address || "-"}</li>
          <li><b>Notes:</b> ${notes || "-"}</li>
        </ul>

        <p>If anything changes, reply to this email and include <b>${jobRef}</b>.</p>
        <p><b>- Dryer Dudes</b></p>
      </div>
    `;

    const result = await resend.emails.send({
      from: "Dryer Dudes <scheduling@dryerdudes.com>",
      to: customerEmail,
      subject,
      html,
    });

    return res.status(200).json({ success: true, jobRef, result });
  } catch (error) {
    console.error("send-booking-email error:", error);
    return res.status(500).json({ success: false, error: error?.message || "Unknown error" });
  }
};
