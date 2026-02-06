const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  // TEMP TEST MODE: allow GET to send a test email
  if (req.method === "GET") {
    req.body = {
      customerEmail: "regisfranklingerber@gmail.com",
      customerName: "Regis",
      service: "Dryer Repair",
      date: "Test Booking",
      timeWindow: "12–2pm",
      address: "Test Address",
      notes: "This is a test booking email",
    };
  } else if (req.method !== "POST") {
    return res
      .status(405)
      .json({ success: false, error: "Method not allowed" });
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
    } = req.body;

    const result = await resend.emails.send({
      from: "Dryer Dudes <scheduling@dryerdudes.com>",
      to: customerEmail,
      subject: "Booking confirmed – Dryer Dudes",
      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>You're booked ✅</h2>
          <p>Hi ${customerName},</p>

          <p>Your Dryer Dudes service is confirmed:</p>

          <ul>
            <li><b>Service:</b> ${service}</li>
            <li><b>Date:</b> ${date}</li>
            <li><b>Time window:</b> ${timeWindow}</li>
            <li><b>Address:</b> ${address}</li>
            <li><b>Notes:</b> ${notes}</li>
          </ul>

          <p>If anything changes, just reply to this email.</p>
          <p><b>– Dryer Dudes</b></p>
        </div>
      `,
    });

    res.status(200).json({ success: true, result });
  } catch (error) {
    console.error("Booking email error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Email failed",
    });
  }
};
