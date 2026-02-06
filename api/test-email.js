const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  try {
    const result = await resend.emails.send({
      from: "Dryer Dudes <scheduling@dryerdudes.com>",
      to: "regisfranklingerber@gmail.com",
      subject: "Resend test - Dryer Dudes",
      html: "<h2>Resend is working ✅</h2><p>This email was sent successfully.</p>",
    });

    res.status(200).json({ success: true, result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
};
