// Owner notification only: never sends an invite or activates an account.
async function notifyOwner(row) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Missing RESEND_API_KEY");
  if (!row?.id) throw new Error("Saved PM request did not return an ID");

  const to = process.env.ADMIN_ALERT_EMAIL || "info@dryerdudes.com";
  const text = [
    "A property manager has requested a Dryer Dudes account.",
    "",
    `Company: ${row.company_name}`,
    `Contact: ${row.contact_name}`,
    `Email: ${row.email}`,
    `Phone: ${row.phone || "Not provided"}`,
    `Service area: ${row.service_area || "Not provided"}`,
    `Units: ${row.units || "Not provided"}`,
    `Default repair approval limit: $${(row.default_job_approval_limit_cents / 100).toFixed(2)}`,
    `Request ID: ${row.id}`,
    "",
    "Review and activate the account in Property Manager Requests:",
    "https://www.dryerdudes.com/admin.html",
    "",
    "The account is pending your approval; this notification does not activate it."
  ].join("\n");

  // Keep the payload and idempotency key identical on retry. Await delivery
  // attempts before responding so the serverless runtime doesn't discard them.
  const body = JSON.stringify({
    from: "Dryer Dudes <scheduling@dryerdudes.com>",
    to: [to],
    subject: `New PM signup: ${String(row.company_name).replace(/[\r\n]/g, " ").slice(0, 120)}`,
    text
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    let retryable = true;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `pm-signup-alert/${row.id}`
        },
        body,
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) return;
      retryable = response.status === 429 || response.status >= 500;
      throw new Error(`PM alert email rejected (HTTP ${response.status})`);
    } catch (error) {
      if (!retryable || attempt === 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    if (!process.env.TURNSTILE_SITE_KEY || !process.env.TURNSTILE_SECRET_KEY) {
      return res.status(503).json({ ok: false, message: "Signup verification is temporarily unavailable. Please try again later." });
    }
    // The site key is public. Never return the secret key to the browser.
    return res.status(200).json({ ok: true, siteKey: process.env.TURNSTILE_SITE_KEY });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const b = req.body || {};

    const company_name = String(b.pm_company || "").trim();
    const contact_name = String(b.pm_contact || "").trim();
    const email = String(b.pm_email || "").trim().toLowerCase();
    const phone = String(b.pm_phone || "").trim();
    const service_area = String(b.pm_area || "").trim();
    const units = String(b.pm_units || "").trim();

    const approvalLimitRaw = String(b.pm_approval_limit || "150").trim();
    const default_job_approval_limit_cents = Number(approvalLimitRaw) * 100;

    const billing_address_line_1 = String(b.pm_billing_address_1 || "").trim();
    const billing_address_line_2 = String(b.pm_billing_address_2 || "").trim();
    const billing_city = String(b.pm_billing_city || "").trim();
    const billing_state = String(b.pm_billing_state || "").trim();
    const billing_zip = String(b.pm_billing_zip || "").trim();

    if (!company_name || !contact_name || !email) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields",
        message: "Company name, contact name, and email are required."
      });
    }

    if (!billing_address_line_1 || !billing_city || !billing_state || !billing_zip) {
      return res.status(400).json({
        ok: false,
        error: "Missing billing address",
        message: "Billing address, city, state, and ZIP are required."
      });
    }

    if (
      ![15000, 17500, 20000, 22500, 25000].includes(default_job_approval_limit_cents)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid approval limit",
        message: "Approval limit must be between $150 and $250 in $25 increments."
      });
    }

    // Verify on the server before any database insert or notification. A
    // browser-only check can be bypassed by calling this endpoint directly.
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret || !process.env.TURNSTILE_SITE_KEY) {
      return res.status(503).json({ ok: false, message: "Signup verification is temporarily unavailable. Please try again later." });
    }
    const token = b["cf-turnstile-response"];
    if (typeof token !== "string" || !token.trim() || token.length > 2048) {
      return res.status(400).json({ ok: false, message: "Please complete the verification and try again." });
    }
    let verification;
    try {
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, response: token }),
        signal: AbortSignal.timeout(3000)
      });
      if (!response.ok) throw new Error("Verification service unavailable");
      verification = await response.json();
    } catch {
      return res.status(503).json({ ok: false, message: "Verification is temporarily unavailable. Please try again." });
    }
    const allowedHosts = String(process.env.TURNSTILE_ALLOWED_HOSTNAMES || "dryerdudes.com,www.dryerdudes.com")
      .split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
    if (verification?.success !== true || verification.action !== "pm_signup" ||
        !allowedHosts.includes(String(verification.hostname || "").toLowerCase())) {
      return res.status(400).json({ ok: false, message: "Verification expired or failed. Please verify again." });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing Supabase server env vars"
      });
    }

    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/property_manager_requests`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([{
        company_name,
        contact_name,
        email,
        phone: phone || null,
        service_area: service_area || null,
        units: units || null,
        default_job_approval_limit_cents,
        billing_address_line_1,
        billing_address_line_2: billing_address_line_2 || null,
        billing_city,
        billing_state,
        billing_zip,
        status: "pending"
      }])
    });

    const data = await insertResp.json().catch(() => null);

    if (!insertResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not save request",
        details: data
      });
    }

    // A notification failure must not turn a saved signup into a failed form
    // submission (which would encourage duplicate requests).
    try {
      await notifyOwner(Array.isArray(data) ? data[0] : null);
    } catch (error) {
      console.error("PM signup saved but owner email failed", {
        request_id: Array.isArray(data) ? data[0]?.id : null,
        error: error?.message || "Unknown notification error"
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Setup request received."
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err)
    });
  }
}
