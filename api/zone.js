export default async function handler(req, res) {
  try {
    const { lat, lon } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: "lat and lon are required" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      });
    }

    const url = `${SUPABASE_URL}/rest/v1/rpc/get_zone_for_lonlat`;

    // Supabase RPC expects the function's exact parameter names.
    const body = {
      p_lon: parseFloat(lon),
      p_lat: parseFloat(lat),
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Supabase RPC error",
        details: text,
        sent_body: body,
      });
    }

    const data = text ? JSON.parse(text) : null;
    return res.status(200).json(data?.[0] ?? null);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
