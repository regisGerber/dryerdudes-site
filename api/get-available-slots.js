// /api/get-available-slots.js

const handler = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const zone = String(req.query.zone || "").trim().toUpperCase();
    const debug = String(req.query.debug || "") === "1";

    if (!["A", "B", "C", "D"].includes(zone)) {
      return res.status(400).json({ error: "zone must be A, B, C, or D" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Debug: prove the function is running + show environment sanity
    if (debug) {
      return res.status(200).json({
        ok: true,
        zone,
        node: process.version,
        hasFetch: typeof fetch === "function",
        hasSUPABASE_URL: !!SUPABASE_URL,
        hasSERVICE_ROLE: !!SERVICE_ROLE,
        nowISO: new Date().toISOString(),
      });
    }

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const todayISO = new Date().toISOString().slice(0, 10);

    const zonesToFetch = `X,${zone}`;
    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&is_booked=eq.false` +
      `&service_date=gte.${todayISO}` +
      `&zone_code=in.(${zonesToFetch})` +
      `&order=service_date.asc,start_time.asc,slot_index.asc` +
      `&limit=2000`;

    const resp = await fetch(fetchUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
      },
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({
        error: "Supabase returned non-JSON",
        status: resp.status,
        body: text.slice(0, 500),
      });
    }

    if (!resp.ok) {
      return res.status(500).json({
        error: "Supabase request failed",
        status: resp.status,
        details: data,
      });
    }

    if (!Array.isArray(data)) {
      return res.status(500).json({ error: "Supabase response not an array" });
    }

    // Just return raw slots (we’ll add your 5-option logic after we confirm no crashes)
    return res.status(200).json({
      zone,
      count: data.length,
      slots: data,
    });
  } catch (err) {
    // If you still see crash page after this, it's almost certainly a syntax/deploy issue, not runtime logic.
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 1200) : null,
    });
  }
};

// Force Node runtime (prevents Edge weirdness)
handler.config = { runtime: "nodejs" };

module.exports = handler;
