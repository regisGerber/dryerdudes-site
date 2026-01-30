export default async function handler(req, res) {
  try {
    const address = (req.query.address || "").toString().trim();
    if (!address) return res.status(400).json({ error: "address is required" });

    const key = process.env.GOOGLE_GEOCODING_KEY;
    if (!key) return res.status(500).json({ error: "Missing GOOGLE_GEOCODING_KEY env var" });

    const url =
      "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(address) +
      "&key=" +
      encodeURIComponent(key);

    const r = await fetch(url);
    const data = await r.json();

    if (data.status !== "OK" || !data.results?.length) {
      return res.status(404).json({ error: "No geocode match", status: data.status, data });
    }

    const best = data.results[0];
    const { lat, lng } = best.geometry.location;

    return res.status(200).json({
      lat,
      lon: lng,
      formatted_address: best.formatted_address,
      place_id: best.place_id,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
