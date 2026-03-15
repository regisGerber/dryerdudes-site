// /api/resolve-zone.js
export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const address =
      req.method === "GET"
        ? String(req.query.address || "").trim()
        : String(req.body?.address || "").trim();

    if (!address) {
      return res.status(400).json({
        error: "address is required",
      });
    }

    const GOOGLE_GEOCODING_KEY = process.env.GOOGLE_GEOCODING_KEY;
    if (!GOOGLE_GEOCODING_KEY) {
      return res.status(500).json({
        error: "Missing GOOGLE_GEOCODING_KEY env var",
      });
    }

    const geocodeUrl =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      `?address=${encodeURIComponent(address)}` +
      `&key=${encodeURIComponent(GOOGLE_GEOCODING_KEY)}`;

    const geoResp = await fetch(geocodeUrl);
    const geoData = await geoResp.json();

    if (!geoResp.ok || geoData.status !== "OK" || !geoData.results?.length) {
      return res.status(400).json({
        error: "Geocoding failed",
        message: "Please enter a valid street address.",
        data: geoData,
      });
    }

    const result = geoData.results[0];
    const formattedAddress = String(result?.formatted_address || "");
    const locationType = String(result?.geometry?.location_type || "");
    const partialMatch = result?.partial_match === true;
    const components = Array.isArray(result?.address_components)
      ? result.address_components
      : [];

    const hasComponent = (type) =>
      components.some(
        (c) => Array.isArray(c.types) && c.types.includes(type)
      );

    const hasStreetNumber = hasComponent("street_number");
    const hasRoute = hasComponent("route");
    const hasPostalCode = hasComponent("postal_code");

    // Stricter validation:
    // require exact rooftop-level address match and core street components
    if (
      locationType !== "ROOFTOP" ||
      partialMatch ||
      !hasStreetNumber ||
      !hasRoute ||
      !hasPostalCode
    ) {
      return res.status(400).json({
        error: "Invalid address",
        message: "Please enter a valid street address.",
        address,
        formatted_address: formattedAddress,
        geocode_quality: {
          location_type: locationType,
          partial_match: partialMatch,
          has_street_number: hasStreetNumber,
          has_route: hasRoute,
          has_postal_code: hasPostalCode,
        },
      });
    }

    const loc = result.geometry.location;
    const lat = loc.lat;
    const lng = loc.lng;

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({
        error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars",
      });
    }

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
      formatted_address: formattedAddress,
      lat,
      lng,
      zone_code: row?.zone_code ?? null,
      zone_name: row?.zone_name ?? null,
      priority: row?.priority ?? null,
      geocode_quality: {
        location_type: locationType,
        partial_match: partialMatch,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
