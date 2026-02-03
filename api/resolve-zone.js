// /api/resolve-zone.js
export default async function handler(req, res) {
  // POST only
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { lat, lng } = req.body || {};

    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng must be numbers" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      });
    }

    // Calls your Postgres function: public.resolve_zone(lat, lng)
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/resolve_zone`;

    const rpcResp = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ lat, lng }),
    });

    const data = await rpcResp.json();

    if (!rpcResp.ok) {
      return res.status(rpcResp.status).json({
        error: "Supabase RPC failed",
        details: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
