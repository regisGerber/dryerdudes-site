export default async function handler(req, res) {
  try {
    const { lat, lon } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: "lat and lon are required" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars" });
    }

    const url = `${SUPABASE_URL}/rest/v1/rpc/get_zone_for_lonlat`;

    // IMPORTANT: Supabase RPC expects the function's parameter names
    const body = {
      p_lat: parseFloat(lat),
      p_lon: parseFloat(lon),
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
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
