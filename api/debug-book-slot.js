// /api/debug-book-slot.js  (FULL REPLACEMENT)

const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

export default async function handler(req, res) {
  try {
    // Allow GET (querystring) or POST (json body)
    const method = String(req.method || "").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    // Secret can come from:
    //  - header: x-debug-secret  (preferred)
    //  - query:  ?secret=...
    const headerSecret = String(req.headers["x-debug-secret"] || "");
    const querySecret = String((req.query && req.query.secret) || "");
    const providedSecret = headerSecret || querySecret;

    const expectedSecret = String(process.env.DEBUG_SECRET || "").trim();
    if (!expectedSecret) {
      return res.status(500).json({ ok: false, error: "Missing DEBUG_SECRET env var" });
    }
    if (!providedSecret || providedSecret !== expectedSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Read inputs from query (GET) or body (POST)
    const src = method === "GET" ? (req.query || {}) : (req.body || {});

    // Support either slot_index OR explicit start/end times
    const zone_code = src.zone_code ?? src.zone ?? "";
    const service_date = src.service_date ?? src.date ?? "";
    const slot_index_raw = src.slot_index ?? "";

    let start_time = src.start_time ?? "";
    let end_time = src.end_time ?? "";
    const status = src.status ?? "scheduled";

    const z = String(zone_code || "").trim().toUpperCase();
    const d = String(service_date || "").trim();
    const slotIndex = slot_index_raw !== "" && slot_index_raw != null ? Number(slot_index_raw) : null;

    if (!["A", "B", "C", "D", "X"].includes(z)) {
      return res.status(400).json({ ok: false, error: "bad zone_code" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return res.status(400).json({ ok: false, error: "bad service_date" });
    }

    // If slot_index provided, map to times
    const SLOT_TIMES = {
      1: ["08:00:00", "10:00:00"],
      2: ["08:30:00", "10:30:00"],
      3: ["09:30:00", "11:30:00"],
      4: ["10:00:00", "12:00:00"],
      5: ["13:00:00", "15:00:00"],
      6: ["13:30:00", "15:30:00"],
      7: ["14:30:00", "16:30:00"],
      8: ["15:00:00", "17:00:00"],
    };

    if (slotIndex != null && Number.isFinite(slotIndex)) {
      const pair = SLOT_TIMES[slotIndex];
      if (!pair) return res.status(400).json({ ok: false, error: "bad slot_index" });
      start_time = pair[0];
      end_time = pair[1];
    }

    const st = String(start_time || "").slice(0, 8);
    const et = String(end_time || "").slice(0, 8);

    if (!/^\d{2}:\d{2}:\d{2}$/.test(st)) return res.status(400).json({ ok: false, error: "bad start_time" });
    if (!/^\d{2}:\d{2}:\d{2}$/.test(et)) return res.status(400).json({ ok: false, error: "bad end_time" });

    // Convert LA-local date+time to UTC ISO
    const tz = "America/Los_Angeles";
    const localIso = `${d}T${st}`;
    const dt = new Date(`${localIso}Z`);

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(dt);

    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const rendered = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;

    const desiredMs = Date.parse(`${localIso}Z`);
    const renderedMs = Date.parse(`${rendered}Z`);
    const corrected = new Date(dt.getTime() + (desiredMs - renderedMs));

    const window_start = corrected.toISOString();

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: "Missing Supabase env vars" });
    }

    const insertUrl = `${SUPABASE_URL}/rest/v1/bookings`;
    const body = {
      window_start,
      zone_code: z,
      route_zone_code: z,
      status,
      payment_status: "paid",
      base_fee_cents: 8000,
      collected_cents: 8000,
      appointment_type: "standard",
      job_ref: `TEST-${Math.floor(Math.random() * 1000000)}`,
    };

    const resp = await fetchFn(insertUrl, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: "insert failed", details: data });
    }

    return res.status(200).json({
      ok: true,
      used: { zone_code: z, service_date: d, start_time: st, end_time: et, slot_index: slotIndex },
      inserted: data,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error", message: err?.message || String(err) });
  }
}
