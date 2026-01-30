// /api/resolve-zone.js
export default async function handler(req, res) {
  try {
    // Only allow GET for now (simple browser testing)
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed. Use GET." });
    }

    const address_input = (req.query.address || "").toString().trim();
    if (!address_input) {
      return res.status(400).json({ error: "address is required" });
    }

    // --- 1) Geocode the address via Google ---
    const GOOGLE_GEOCODING_KEY = process.env.GOOGLE_GEOCODING_KEY;
    if (!GOOGLE_GEOCODING_KEY) {
      return res
        .status(500)
        .json({ error: "Missing GOOGLE_GEOCODING_KEY env var" });
    }

    const geocodeUrl =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      `?address=${encodeURIComponent(address_input)}` +
      `&key=${encodeURIComponent(GOOGLE_GEOCODING_KEY)}`;

    const geoResp = await fetch(geocodeUrl);
    const geoData = await geoResp.json();

    if (!geoResp.ok) {
      return res.status(502).json({
        error: "Geocoding request failed",
        status: geoResp.status,
        data: geoData,
      });
    }

    if (!geoData || geoData.status !== "OK" || !geoData.results?.length) {
      return res.status(400).json({
        error: "No geocode match",
        status: geoData?.status ?? "UNKNOWN",
        data: geoData,
      });
    }

    const first = geoData.results[0];
    const formatted_address = first.formatted_address || null;
    const place_id = first.place_id || null;
    const lat = first.geometry?.location?.lat ?? null;
    const lon = first.geometry?.location?.lng ?? null;

    if (lat == null || lon == null) {
      return res.status(400).json({
        error: "Geocoding returned no lat/lon",
        data: geoData,
      });
    }

    // --- 2) Ask Supabase/PostGIS which zone that point is in ---
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({
        error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars",
      });
    }

    // IMPORTANT: your RPC takes p_lat and p_lon (not lat/lon)
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
        p_lon: Number(lon),
      }),
    });

    const zoneData = await rpcResp.json();

    if (!rpcResp.ok) {
      return res.status(502).json({
        error: "Supabase RPC failed",
        status: rpcResp.status,
        data: zoneData,
      });
    }

    // Supabase RPC might return an object OR an array depending on settings
    let zone_code = null;
    let zone_name = null;

    if (zoneData) {
      const row = Array.isArray(zoneData) ? zoneData[0] : zoneData;
      zone_code = row?.zone_code ?? null;
      zone_name = row?.zone_name ?? null;
    }

    // --- Final response JSON (this is what you paste-tested in the browser) ---
    return res.status(200).json({
      address_input,
      formatted_address,
      place_id,
      lat,
      lon,
      zone_code,
      zone_name,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
