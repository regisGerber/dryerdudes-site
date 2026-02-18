// /api/debug-book-slot.js
const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  const secret = String(req.headers["x-debug-secret"] || "");
  if (!process.env.DEBUG_SECRET || secret !== dd-debug-2026-strong-key-91XkLm) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const { zone_code, service_date, start_time, end_time, status = "scheduled" } = req.body || {};
  const z = String(zone_code || "").toUpperCase();
  const d = String(service_date || "");
  const st = String(start_time || "").slice(0, 8);
  const et = String(end_time || "").slice(0, 8);

  if (!["A", "B", "C", "D", "X"].includes(z)) return res.status(400).json({ ok: false, error: "bad zone_code" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ ok: false, error: "bad service_date" });
  if (!/^\d{2}:\d{2}:\d{2}$/.test(st)) return res.status(400).json({ ok: false, error: "bad start_time" });
  if (!/^\d{2}:\d{2}:\d{2}$/.test(et)) return res.status(400).json({ ok: false, error: "bad end_time" });

  // Convert LA-local date+time to a real UTC timestamp.
  // Trick: create a Date from parts in LA by formatting parts in LA for "now" is not enough,
  // so we do a small reliable approach: use Intl to get the offset for that local datetime.
  const tz = "America/Los_Angeles";
  const localIso = `${d}T${st}`;
  const dt = new Date(`${localIso}Z`); // placeholder; we'll shift by LA offset below

  // Get LA offset minutes for that *calendar date/time*:
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
  // This is dt rendered in LA; we want dt such that LA render equals our desired local.
  // Easiest: brute adjust once by comparing desired vs rendered.
  const rendered = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
  const desiredMs = Date.parse(`${localIso}Z`);
  const renderedMs = Date.parse(`${rendered}Z`);
  const corrected = new Date(dt.getTime() + (desiredMs - renderedMs)); // now LA render == desired local

  const window_start = corrected.toISOString(); // UTC timestamptz

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE) return res.status(500).json({ ok: false, error: "Missing env" });

  const insertUrl = `${SUPABASE_URL}/rest/v1/bookings`;
  const body = {
    window_start,
    // window_end optional; keep simple
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
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!resp.ok) return res.status(resp.status).json({ ok: false, error: "insert failed", details: data });
  return res.status(200).json({ ok: true, inserted: data });
}
