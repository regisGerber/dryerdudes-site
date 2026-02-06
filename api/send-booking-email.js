// /api/send-booking-email.js
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

// Generates a simple job reference like DD-123456
// (Good enough for now; later we can switch to a stronger random/ref format if you want.)
function makeJobRef() {
  return `DD-${Date.now().toString().slice(-6)}`;
}

module.exports = async (req, res) => {
  // Only allow POST
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

    // Keep subject simple + includes jobRef
    const subject = `Booking confirmed - Dryer Dudes (Job #${jobRef})`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.45; color:#111;">
        <h2 style="margin:0 0 10px 0;">You're booked ✅</h2>

        <p style="margin:0 0 14px 0;">
          <b>Job reference:</b> ${jobRef}
        </p>

        <p style="margin:0 0 12px 0;">Hi ${customerName || "there"},</p>

        <p style="margin:0 0 10px 0;">
          Your <b>Dryer Dudes</b> service is confirmed:
        </p>

        <ul style="margin:0 0 14px 18px; padding:0;">
          <li><b>Service:</b> ${service || "-"}</li>
          <li><b>Date:</b> ${date || "-"}</li>
          <li><b>Time window:</b> ${timeWindow || "-"}</li>
          <li><b>Address:</b> ${address || "-"}</li>
          <li><b>Notes:</b> ${notes || "-"}</li>
        </ul>

        <p style="margin:0 0 8px 0; font-size: 0.95em; color:#444;">
          Use this job reference if you need to reach us.
        </p>

        <p style="margin:0;"><b>- Dryer Dudes</b></p>
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
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
    });
  }
};
```0
