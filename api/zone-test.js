export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { lat, lng } = req.body;

  if (lat == null || lng == null) {
    return res.status(400).json({ error: "Missing lat/lng" });
  }

  try {
    const response = await fetch(
      process.env.SUPABASE_URL + "/rest/v1/rpc/resolve_zone",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ lat, lng }),
      }
    );

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Zone lookup failed" });
  }
}
