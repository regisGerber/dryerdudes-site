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

  if (!resp.ok || !data?.id) {
    return null;
  }

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
        error: "Only admins can generate schedule slots",
      });
    }

    const daysAheadRaw = Number(req.body?.days_ahead || 90);
    const daysAhead = Math.min(Math.max(daysAheadRaw || 90, 1), 180);

    const rpcResp = await sbFetchJson(
      `${SUPABASE_URL}/rest/v1/rpc/admin_generate_schedule_slots`,
      {
        method: "POST",
        headers: sbHeaders(SERVICE_ROLE),
        body: JSON.stringify({
          p_days_ahead: daysAhead,
        }),
      }
    );

    if (!rpcResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Could not generate schedule slots",
        details: rpcResp.data,
        status: rpcResp.status,
      });
    }

    const result = Array.isArray(rpcResp.data) ? rpcResp.data[0] : rpcResp.data;

    return res.status(200).json({
      ok: true,
      days_ahead: daysAhead,
      result,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
