// /api/admin-populate-slots.js (CommonJS)
// Service-role slot horizon population to avoid client-side RLS write failures.

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: resp.ok, status: resp.status, data, text };
}

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

function isBusinessDayISO(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const w = dt.getUTCDay();
  return w >= 1 && w <= 5;
}

const SLOT_TEMPLATES = [
  { slot_index: 1, start_time: "08:00:00", daypart: "morning" },
  { slot_index: 2, start_time: "08:30:00", daypart: "morning" },
  { slot_index: 3, start_time: "09:30:00", daypart: "morning" },
  { slot_index: 4, start_time: "10:00:00", daypart: "morning" },
  { slot_index: 5, start_time: "13:00:00", daypart: "afternoon" },
  { slot_index: 6, start_time: "13:30:00", daypart: "afternoon" },
  { slot_index: 7, start_time: "14:30:00", daypart: "afternoon" },
  { slot_index: 8, start_time: "15:00:00", daypart: "afternoon" },
];

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const days = Math.max(1, Math.min(365, Number(req.body?.days || 120)));
    const todayISO = new Date().toISOString().slice(0, 10);
    const endISO = addDaysISO(todayISO, days);

    const techResp = await sbFetchJson(
      `${SUPABASE_URL}/rest/v1/techs?active=eq.true&select=id`,
      { headers: sbHeaders(SERVICE_ROLE) }
    );
    if (!techResp.ok) {
      return res.status(500).json({ ok: false, error: "techs_fetch_failed", details: techResp.text?.slice(0, 400) });
    }

    const ztaResp = await sbFetchJson(
      `${SUPABASE_URL}/rest/v1/zone_tech_assignments?select=tech_id,zone_code`,
      { headers: sbHeaders(SERVICE_ROLE) }
    );
    if (!ztaResp.ok) {
      return res.status(500).json({ ok: false, error: "zone_assignments_fetch_failed", details: ztaResp.text?.slice(0, 400) });
    }

    const zoneByTech = new Map();
    for (const row of Array.isArray(ztaResp.data) ? ztaResp.data : []) {
      const t = row?.tech_id ? String(row.tech_id) : "";
      const z = String(row?.zone_code || "").trim().toUpperCase();
      if (!t || !z) continue;
      if (!zoneByTech.has(t)) zoneByTech.set(t, z);
    }

    const upserts = [];
    for (const tech of Array.isArray(techResp.data) ? techResp.data : []) {
      const techId = String(tech.id);
      for (let i = 0; i < days; i++) {
        const slotDate = addDaysISO(todayISO, i);
        if (!isBusinessDayISO(slotDate)) continue;
        for (const tpl of SLOT_TEMPLATES) {
          upserts.push({
            tech_id: techId,
            slot_date: slotDate,
            slot_index: tpl.slot_index,
            start_time: tpl.start_time,
            daypart: tpl.daypart,
            zone: zoneByTech.get(techId) || null,
            status: "open",
          });
        }
      }
    }

    if (!upserts.length) return res.status(200).json({ ok: true, inserted: 0, note: "No rows to upsert" });

    const chunkSize = 1000;
    let total = 0;
    for (let i = 0; i < upserts.length; i += chunkSize) {
      const chunk = upserts.slice(i, i + chunkSize);
      const upsertResp = await sbFetchJson(
        `${SUPABASE_URL}/rest/v1/slots?on_conflict=tech_id,slot_date,slot_index`,
        {
          method: "POST",
          headers: { ...sbHeaders(SERVICE_ROLE), Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(chunk),
        }
      );
      if (!upsertResp.ok) {
        return res.status(500).json({ ok: false, error: "slots_upsert_failed", details: upsertResp.text?.slice(0, 800) });
      }
      total += chunk.length;
    }

    return res.status(200).json({ ok: true, inserted: total, start: todayISO, end: endISO });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || String(err) });
  }
};
