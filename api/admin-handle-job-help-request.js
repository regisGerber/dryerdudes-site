function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getBearerToken(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { ok: resp.ok, status: resp.status, data, text };
}

async function getUserFromToken({ supabaseUrl, serviceRole, accessToken }) {
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.id) return null;
  return data;
}

async function getAdminProfile({ supabaseUrl, serviceRole, userId }) {
  const url = new URL(`${supabaseUrl}/rest/v1/profiles`);
  url.searchParams.set("select", "user_id,role");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Profile lookup failed: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

function statusForAction(action) {
  const a = String(action || "").trim().toLowerCase();

  if (a === "in_review") return "in_review";
  if (a === "responded") return "responded";
  if (a === "resolved") return "resolved";
  if (a === "closed") return "closed";

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const accessToken = getBearerToken(req);

    if (!accessToken) {
      return res.status(401).json({
        ok: false,
        error: "Missing admin auth token",
      });
    }

    const user = await getUserFromToken({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      accessToken,
    });

    if (!user?.id) {
      return res.status(401).json({
        ok: false,
        error: "Invalid admin auth token",
      });
    }

    const profile = await getAdminProfile({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      userId: user.id,
    });

    if (profile?.role !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "Only admins can update job help requests.",
      });
    }

    const id = String(req.body?.id || "").trim();
    const action = String(req.body?.action || "").trim();
    const adminNotes = String(req.body?.admin_notes || "").trim();

    const newStatus = statusForAction(action);

    if (!id || !newStatus) {
      return res.status(400).json({
        ok: false,
        error: "Missing id or invalid action.",
      });
    }

    const patch = {
      status: newStatus,
      updated_at: new Date().toISOString(),
    };

    if (adminNotes) patch.admin_notes = adminNotes;
    if (newStatus === "responded") patch.responded_at = new Date().toISOString();
    if (newStatus === "resolved" || newStatus === "closed") patch.resolved_at = new Date().toISOString();

    const url = new URL(`${SUPABASE_URL}/rest/v1/job_help_requests`);
    url.searchParams.set("id", `eq.${id}`);

    const r = await sbFetchJson(url.toString(), {
      method: "PATCH",
      headers: {
        ...sbHeaders(SERVICE_ROLE),
        Prefer: "return=representation",
      },
      body: JSON.stringify(patch),
    });

    if (!r.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not update job help request.",
        details: r.data,
      });
    }

    return res.status(200).json({
      ok: true,
      request: Array.isArray(r.data) ? r.data[0] : null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
