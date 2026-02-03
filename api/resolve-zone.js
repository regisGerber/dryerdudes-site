// /api/resolve-zone.js
export default async function handler(req, res) {
  // Allow GET (browser testing) and POST (future form submits)
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Accept address via GET ?address= or POST { address }
    const address =
      req.method === "GET"
        ? (req.query.address || "").toString().trim()
        : (req.body?.address || "").toString().trim();

    if (!address) {
      return res.status(400).json({ error: "address is required" });
    }

    const GOOGLE_GEOCODING_KEY = process.env.GOOGLE_GEOCODING_KEY;
    if (!GOOGLE_GEOCODING_KEY) {
      return res
        .status(500)
        .json({ error: "Missing GOOGLE_GEOCODING_KEY env var" });
    }

    // --- Geocode address ---
    const geocodeUrl =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      `?address=${encodeURIComponent(address)}` +
      `&key=${encodeURIComponent(GOOGLE_GEOCODING_KEY)}`;

    const geoResp = await fetch(geocodeUrl);
    const geoData = await geoResp.json();

    if (!geoResp.ok || geoData.status !== "OK" || !geoData.results?.length) {
      return res.status(400).json({
        error: "Geocoding failed",
        data: geoData,
      });
    }

    const loc = geoData.results[0].geometry.location;
    const lat = loc.lat;
    const lng = loc.lng;

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({
        error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars",
      });
    }

    // --- Call Postgres RPC ---
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/get_zone_for_lonlat`;

    const rpcResp = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        p_lat: Number(lat),
        p_lon: Number(lng),
      }),
    });

    const zoneData = await rpcResp.json();

    if (!rpcResp.ok) {
      return res.status(502).json({
        error: "Supabase RPC failed",
        data: zoneData,
      });
    }

    const row = Array.isArray(zoneData) ? zoneData[0] : zoneData;

    return res.status(200).json({
      address,
      lat,
      lng,
      zone_code: row?.zone_code ?? null,
      zone_name: row?.zone_name ?? null,
      priority: row?.priority ?? null,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}

