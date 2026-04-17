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
    const SITE_ORIGIN = String(process.env.SITE_ORIGIN || "https://www.dryerdudes.com").replace(/\/+$/, "");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing Supabase server env vars"
      });
    }

    async function apiFetch(path, options = {}) {
      const resp = await fetch(`${SUPABASE_URL}${path}`, {
        ...options,
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });

      const text = await resp.text();
      let data = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      return { resp, data };
    }

    // 1) Load request row
    const { resp: reqResp, data: reqRows } = await apiFetch(
      `/rest/v1/property_manager_requests?id=eq.${encodeURIComponent(request_id)}&select=*`
    );

    if (!reqResp.ok || !Array.isArray(reqRows) || !reqRows.length) {
      return res.status(404).json({
        ok: false,
        error: "Request not found",
        details: reqRows
      });
    }

    const row = reqRows[0];

    if (action === "reject") {
      const { resp: rejectResp, data: rejectData } = await apiFetch(
        `/rest/v1/property_manager_requests?id=eq.${encodeURIComponent(request_id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "rejected" })
        }
      );

      if (!rejectResp.ok) {
        return res.status(500).json({
          ok: false,
          error: "Could not reject request",
          details: rejectData
        });
      }

      return res.status(200).json({ ok: true, status: "rejected" });
    }

    // 2) If PM account already exists, just mark request approved
    const { resp: existingPmResp, data: existingPmRows } = await apiFetch(
      `/rest/v1/property_managers?email=eq.${encodeURIComponent(row.email)}&select=*`
    );

    if (!existingPmResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not check existing property manager accounts",
        details: existingPmRows
      });
    }

    if (Array.isArray(existingPmRows) && existingPmRows.length) {
      const { resp: approveResp, data: approveData } = await apiFetch(
        `/rest/v1/property_manager_requests?id=eq.${encodeURIComponent(request_id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "approved" })
        }
      );

      if (!approveResp.ok) {
        return res.status(500).json({
          ok: false,
          error: "Account already existed, but request status did not update",
          details: approveData
        });
      }

      return res.status(200).json({
        ok: true,
        status: "approved",
        message: "Property manager account already existed. Request marked approved."
      });
    }

    // 3) Invite auth user
    const inviteRedirectTo = `${SITE_ORIGIN}/set-password.html`;

    const { resp: inviteResp, data: invitedUser } = await apiFetch(
      `/auth/v1/invite`,
      {
        method: "POST",
        body: JSON.stringify({
          email: row.email,
          data: {
            role: "property_manager"
          },
          redirect_to: inviteRedirectTo
        })
      }
    );

    const user_id = invitedUser?.user?.id || invitedUser?.id || null;

    if (!inviteResp.ok || !user_id) {
      return res.status(500).json({
        ok: false,
        error: "Could not send property manager invite",
        details: invitedUser,
        status_code: inviteResp.status
      });
    }

    // 4) Create/update profile
    const { resp: profileResp, data: profileData } = await apiFetch(
      `/rest/v1/profiles`,
      {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates"
        },
        body: JSON.stringify([
          {
            user_id,
            role: "property_manager"
          }
        ])
      }
    );

    if (!profileResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not create profile",
        details: profileData
      });
    }

    // 5) Create property_managers row
    const { resp: pmResp, data: pmData } = await apiFetch(
      `/rest/v1/property_managers`,
      {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify([
          {
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
          }
        ])
      }
    );

    if (!pmResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not create property manager account",
        details: pmData
      });
    }

    // 6) Mark request approved
    const { resp: approveResp, data: approveData } = await apiFetch(
      `/rest/v1/property_manager_requests?id=eq.${encodeURIComponent(request_id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "approved" })
      }
    );

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
      message: "Property manager approved and invite email sent."
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err)
    });
  }
}
