function makeTempPassword() {
  return `DryerDudes!${Math.random().toString(36).slice(2, 10)}A1`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const { request_id, action } = req.body || {};

    if (!request_id || !action) {
      return res.status(400).json({
        ok: false,
        error: "Missing request_id or action"
      });
    }

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid action"
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

    // Load the pending request
    const reqResp = await fetch(
      `${SUPABASE_URL}/rest/v1/property_manager_requests?id=eq.${encodeURIComponent(request_id)}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reqRows = await reqResp.json().catch(() => []);

    if (!reqResp.ok || !Array.isArray(reqRows) || !reqRows.length) {
      return res.status(404).json({
        ok: false,
        error: "Request not found"
      });
    }

    const row = reqRows[0];

    if (action === "reject") {
      const rejectResp = await fetch(
        `${SUPABASE_URL}/rest/v1/property_manager_requests?id=eq.${encodeURIComponent(request_id)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ status: "rejected" })
        }
      );

      const rejectData = await rejectResp.json().catch(() => null);

      if (!rejectResp.ok) {
        return res.status(500).json({
          ok: false,
          error: "Could not reject request",
          details: rejectData
        });
      }

      return res.status(200).json({ ok: true, status: "rejected" });
    }

    // APPROVE FLOW

    // 1) Create auth user
    const tempPassword = makeTempPassword();

    const createUserResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: row.email,
        password: tempPassword,
        email_confirm: true
      })
    });

    const createdUser = await createUserResp.json().catch(() => null);

    if (!createUserResp.ok || !createdUser?.id) {
      return res.status(500).json({
        ok: false,
        error: "Could not create auth user",
        details: createdUser
      });
    }

    const user_id = createdUser.id;

    // 2) Upsert profile role
    const profileResp = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify([{
        user_id,
        role: "property_manager"
      }])
    });

    const profileData = await profileResp.json().catch(() => null);

    if (!profileResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not create profile",
        details: profileData
      });
    }

    // 3) Create property_managers row
    const pmResp = await fetch(`${SUPABASE_URL}/rest/v1/property_managers`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([{
        user_id,
        company_name: row.company_name,
        contact_name: row.contact_name,
        email: row.email,
        phone: row.phone,
        default_job_approval_limit_cents: row.default_job_approval_limit_cents,
        billing_address_line_1: row.billing_address_line_1,
        billing_address_line_2: row.billing_address_line_2,
        billing_city: row.billing_city,
        billing_state: row.billing_state,
        billing_zip: row.billing_zip
      }])
    });

    const pmData = await pmResp.json().catch(() => null);

    if (!pmResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not create property manager account",
        details: pmData
      });
    }

    // 4) Mark request approved
    const approveResp = await fetch(
      `${SUPABASE_URL}/rest/v1/property_manager_requests?id=eq.${encodeURIComponent(request_id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ status: "approved" })
      }
    );

    const approveData = await approveResp.json().catch(() => null);

    if (!approveResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Property manager account created, but request status did not update",
        details: approveData
      });
    }

    return res.status(200).json({
      ok: true,
      status: "approved",
      temp_password: tempPassword
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err)
    });
  }
}
