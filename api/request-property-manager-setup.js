export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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
