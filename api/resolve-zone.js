// /api/resolve-zone.js
// Combines: address -> geocode -> zone
// Returns: address + formatted_address + lat/lon + place_id + zone_code/zone_name

module.exports = async (req, res) => {
  try {
    // 1) Read & validate input
    const address = (req.query.address || "").toString().trim();
    if (!address) {
      return res.status(400).json({ error: 'Missing "address" query param' });
    }

    // Build a base URL to call your existing endpoints on the same deployment
    // Works on Vercel + locally (mostly).
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const baseUrl = `${proto}://${host}`;

    // 2) Call your existing /api/geocode endpoint
    const geocodeUrl = `${baseUrl}/api/geocode?address=${encodeURIComponent(address)}`;
    const geoResp = await fetch(geocodeUrl);
    const geoJson = await geoResp.json();

    if (!geoResp.ok) {
      return res.status(geoResp.status).json({
        error: "Geocode failed",
        address,
        details: geoJson,
      });
    }

    const { lat, lon, formatted_address, place_id } = geoJson || {};
    if (typeof lat !== "number" || typeof lon !== "number") {
      return res.status(500).json({
        error: "Geocode did not return numeric lat/lon",
        address,
        details: geoJson,
      });
    }

    // 3) Call your existing /api/zone endpoint
    const zoneUrl = `${baseUrl}/api/zone?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    const zoneResp = await fetch(zoneUrl);
    const zoneJson = await zoneResp.json();

    if (!zoneResp.ok) {
      return res.status(zoneResp.status).json({
        error: "Zone lookup failed",
        address,
        lat,
        lon,
        formatted_address,
        place_id,
        details: zoneJson,
      });
    }

    const { zone_code, zone_name } = zoneJson || {};

    // 4) Final combined response
    return res.status(200).json({
      address_input: address,
      formatted_address: formatted_address || null,
      place_id: place_id || null,
      lat,
      lon,
      zone_code: zone_code || null,
      zone_name: zone_name || null,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unexpected server error",
      message: err?.message || String(err),
    });
  }
};
