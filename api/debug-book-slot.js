// /api/debug-book-slot.js

const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

const SECRET_FALLBACK = "dd-debug-2026-strong-key-91XkLm";
const SCHED_TZ = "America/Los_Angeles";

function laLocalToUTCISO(service_date, time_hms) {
  const d = String(service_date || "");
  const t = String(time_hms || "").slice(0, 8);

  const localIso = `${d}T${t}`;
  const anchor = new Date(`${localIso}Z`);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHED_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(anchor);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const renderedLocalIso = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;

  const desiredMs = Date.parse(`${localIso}Z`);
  const renderedMs = Date.parse(`${renderedLocalIso}Z`);
  const corrected = new Date(anchor.getTime() + (desiredMs - renderedMs));

  return corrected.toISOString();
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const expected = String(process.env.DEBUG_SECRET || SECRET_FALLBACK);

    const secret =
      String((req.query && req.query.secret) || "") ||
      String(req.headers["x-debug-secret"] || "");

    if (!secret || secret !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const input = req.method === "GET" ? (req.query || {}) : (req.body || {});
    const { zone_code, service_date, start_time, end_time, status = "scheduled" } = input;

    const z = String(zone_code || "").toUpperCase();
    const d = String(service_date || "");
    const st = String(start_time || "").slice(0, 8);
    const et = String(end_time || "").slice(0, 8);

    if (!["A", "B", "C", "D", "X"].includes(z)) return res.status(400).json({ ok: false, error: "bad zone_code" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ ok: false, error: "bad service_date" });
    if (!/^\d{2}:\d{2}:\d{2}$/.test(st)) return res.status(400).json({ ok: false, error: "bad start_time" });
    if (!/^\d{2}:\d{2}:\d{2}$/.test(et)) return res.status(400).json({ ok: false, error: "bad end_time" });

    const window_start = laLocalToUTCISO(d, st);
    const window_end = laLocalToUTCISO(d, et);

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) return res.status(500).json({ ok: false, error: "Missing env" });

    const insertUrl = `${SUPABASE_URL}/rest/v1/bookings`;

    const body = {
      window_start,
      window_end,
      zone_code: z,
      route_zone_code: z,
      status: String(status || "scheduled"),
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

    if (!resp.ok) return res.status(resp.status).json({ ok: false, error: "insert failed", details: data });
    return res.status(200).json({ ok: true, inserted: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error", message: err?.message || String(err) });
  }
}
```0
