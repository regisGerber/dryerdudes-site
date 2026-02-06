import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  try {
    const result = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: "regisfranklingerber@gmail.com", // CHANGE THIS
      subject: "Resend test – Dryer Dudes",
      html: `
        <h2>Resend is working ✅</h2>
        <p>This email was sent successfully from <b>${process.env.FROM_EMAIL}</b>.</p>
      `,
    });

    res.status(200).json({ success: true, result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
}
