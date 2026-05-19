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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
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
        error: "Only admins can view job help requests.",
      });
    }

    const url = new URL(`${SUPABASE_URL}/rest/v1/job_help_requests`);
    url.searchParams.set(
      "select",
      `
        *,
        bookings:booking_id (
          id,
          job_ref,
          status,
          window_start,
          window_end
        ),
        booking_requests:request_id (
          id,
          name,
          phone,
          email,
          address
        )
      `
    );
    url.searchParams.set("status", "neq.closed");
    url.searchParams.set("order", "created_at.desc");
    url.searchParams.set("limit", "75");

    const r = await sbFetchJson(url.toString(), {
      headers: sbHeaders(SERVICE_ROLE),
    });

    if (!r.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not load job help requests.",
        details: r.data,
      });
    }

    return res.status(200).json({
      ok: true,
      requests: Array.isArray(r.data) ? r.data : [],
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
