// /api/send-booking-email.js
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

function makeJobRef() {
  return `DD-${Date.now().toString().slice(-6)}`;
}

function esc(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
  }[c]));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing RESEND_API_KEY" });
    }

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

    const email = String(customerEmail || "").trim();
    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing customerEmail" });
    }

    const jobRef = String(jobRefFromBody || "").trim() || makeJobRef();
    const subject = `Booking confirmed - Dryer Dudes (Job #${jobRef})`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.45; color:#111;">
        <h2 style="margin:0 0 10px 0;">You're booked ✅</h2>

        <p style="margin:0 0 14px 0;">
          <b>Job reference:</b> ${esc(jobRef)}
        </p>

        <p style="margin:0 0 12px 0;">Hi ${esc(customerName || "there")},</p>

        <p style="margin:0 0 10px 0;">
          Your <b>Dryer Dudes</b> service is confirmed:
        </p>

        <ul style="margin:0 0 14px 18px; padding:0;">
          <li><b>Service:</b> ${esc(service || "-")}</li>
          <li><b>Date:</b> ${esc(date || "-")}</li>
          <li><b>Time window:</b> ${esc(timeWindow || "-")}</li>
          <li><b>Address:</b> ${esc(address || "-")}</li>
          <li><b>Notes:</b> ${esc(notes || "-")}</li>
        </ul>

        <p style="margin:0 0 8px 0; font-size: 0.95em; color:#444;">
          Use this job reference if you need to reach us.
        </p>

        <p style="margin:0;"><b>- Dryer Dudes</b></p>
      </div>
    `;

    const result = await resend.emails.send({
      from: "Dryer Dudes <scheduling@dryerdudes.com>",
      to: [email],
      subject,
      html,
    });

    return res.status(200).json({ ok: true, jobRef, result });
  } catch (error) {
    console.error("send-booking-email error:", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Unknown error",
    });
  }
}
