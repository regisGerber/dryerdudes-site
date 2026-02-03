// /api/get-available-slots.js

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const zone = (req.query.zone || "").toString().trim().toUpperCase();
    const type = (req.query.type || "standard").toString().trim().toLowerCase();

    if (!zone) return res.status(400).json({ error: "zone is required" });
    if (!["standard", "no_one_home", "parts_install"].includes(type)) {
      return res.status(400).json({ error: "invalid type" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY; // OK for read-only selects
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY; // only needed for inserts/updates later

    if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL env var" });
    if (!SUPABASE_ANON_KEY && !SERVICE_ROLE) {
      return res.status(500).json({ error: "Missing SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY env var" });
    }

    const API_KEY = SERVICE_ROLE || SUPABASE_ANON_KEY;

    // IMPORTANT: this endpoint must exist in your DB (table or view)
    // If your schema is different, this is where it will fail.
    const url =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time` +
      `&zone_code=eq.${encodeURIComponent(zone)}` +
      `&is_booked=eq.false` +
      `&order=service_date.asc,slot_index.asc` +
      `&limit=50`;

    const resp = await fetch(url, {
      headers: {
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
      },
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // If Supabase returns something non-JSON, show it
      return res.status(502).json({
        error: "Supabase returned non-JSON",
        status: resp.status,
        body: text,
      });
    }

    if (!resp.ok) {
      return res.status(502).json({
        error: "Supabase request failed",
        status: resp.status,
        details: data,
      });
    }

    // For now just return raw slots (we’ll apply “3 primary + more options” formatting next)
    return res.status(200).json({
      zone,
      type,
      slots: data,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
