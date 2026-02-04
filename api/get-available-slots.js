// /api/get-available-slots.js
module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const zone = String(req.query.zone || "").trim().toUpperCase();
    const typeRaw = String(req.query.type || "standard").trim().toLowerCase();
    const type =
      typeRaw === "parts"
        ? "parts"
        : typeRaw === "no_one_home" || typeRaw === "no-one-home" || typeRaw === "noonehome"
        ? "no_one_home"
        : "standard";

    if (!["A", "B", "C", "D"].includes(zone)) {
      return res.status(400).json({ error: "zone must be A, B, C, or D" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({
        error: "Missing env vars",
        missing: {
          SUPABASE_URL: !SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: !SERVICE_ROLE,
        },
      });
    }

    // ---------- Helpers ----------
    const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const toDateOnlyUTC = (iso) => {
      const [y, m, d] = String(iso).split("-").map((n) => parseInt(n, 10));
      return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
    };

    const weekdayUTC = (dateOnlyUTC) => dateOnlyUTC.getUTCDay(); // 0=Sun..6=Sat

    const isMorning = (slot) => {
      if (slot.daypart) return String(slot.daypart).toLowerCase() === "morning";
      const t = String(slot.start_time || "").slice(0, 5); // HH:MM
      return t && t < "12:00";
    };

    const isAfternoon = (slot) => !isMorning(slot);

    const slotKey = (s) => `${s.service_date}|${s.slot_index}`;

    const sortByDateThenStart = (a, b) => {
      const da = String(a.service_date || "");
      const db = String(b.service_date || "");
      if (da < db) return -1;
      if (da > db) return 1;

      const sa = String(a.start_time || "");
      const sb = String(b.start_time || "");
      if (sa < sb) return -1;
      if (sa > sb) return 1;

      return (a.slot_index ?? 0) - (b.slot_index ?? 0);
    };

    const pickEarliest = (arr, predicate) => {
      for (const s of arr) {
        if (predicate(s)) return s;
      }
      return null;
    };

    // Public shape
    const toPublic = (s) => ({
      service_date: s.service_date,
      slot_index: s.slot_index,
      zone_code: s.zone_code,
      daypart: s.daypart ?? (isMorning(s) ? "morning" : "afternoon"),
      window_label: s.window_label ?? null,
      start_time: s.start_time,
      end_time: s.end_time,
    });

    // ---------- Zone rules (locked down) ----------
    // Mon=B, Tue=D, Wed=flex, Thu=A, Fri=C
    const mainWeekdayForZone = { A: 4, B: 1, C: 5, D: 2 }; // 0=Sun..6=Sat
    const WED = 3;

    const adj = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };
    const secondTier = { A: ["C"], B: ["D"], C: ["A"], D: ["B"] };

    // Fetch only: requested zone + adjacent + second-tier
    const zonesToFetch = Array.from(
      new Set([zone, ...(adj[zone] || []), ...(secondTier[zone] || [])])
    );

    // Supabase in() wants: in.(A,B,C) (no quotes)
    const zoneIn = zonesToFetch.join(",");

    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&is_booked=eq.false` +
      `&service_date=gte.${todayISO}` +
      `&zone_code=in.(${zoneIn})` +
      `&order=service_date.asc,start_time.asc,slot_index.asc` +
      `&limit=800`;

    const supaResp = await fetch(fetchUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
    });

    const rawText = await supaResp.text();
    let slots;
    try {
      slots = JSON.parse(rawText);
    } catch {
      return res.status(500).json({
        error: "Supabase returned non-JSON",
        status: supaResp.status,
        body: rawText.slice(0, 400),
      });
    }

    if (!supaResp.ok) {
      return res.status(500).json({
        error: "Supabase fetch failed",
        status: supaResp.status,
        details: slots,
      });
    }

    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(200).json({
        zone,
        appointmentType: type,
        primary: [],
        more: { options: [], show_no_one_home_cta: type !== "no_one_home" },
      });
    }

    // Ensure deterministic sorting (even if Supabase changes order)
    slots.sort(sortByDateThenStart);

    // ---------- HARD enforce zone logic on every slot ----------
    // Allowed if:
    // - Wednesday (flex) OR
    // - slot occurs on that slot.zone_code’s main weekday
    const allowedSlots = slots.filter((s) => {
      const z = String(s.zone_code || "").toUpperCase();
      const mainDow = mainWeekdayForZone[z];
      if (mainDow === undefined) return false;

      const dow = weekdayUTC(toDateOnlyUTC(s.service_date));
      return dow === WED || dow === mainDow;
    });

    if (allowedSlots.length === 0) {
      return res.status(200).json({
        zone,
        appointmentType: type,
        primary: [],
        more: { options: [], show_no_one_home_cta: type !== "no_one_home" },
      });
    }

    // ---------- Build 5 options (structured, safe) ----------
    const picked = new Set();

    // Slots for the customer’s zone only
    const customerZoneSlots = allowedSlots.filter(
      (s) => String(s.zone_code || "").toUpperCase() === zone
    );

    const customerMainDow = mainWeekdayForZone[zone];
    const customerMainDaySlots = customerZoneSlots.filter(
      (s) => weekdayUTC(toDateOnlyUTC(s.service_date)) === customerMainDow
    );

    // 1) Next main-day morning for customer zone
    const option1 = pickEarliest(customerMainDaySlots, (s) => isMorning(s));
    if (option1) picked.add(slotKey(option1));

    // 2) Next main-day afternoon for customer zone
    const option2 = pickEarliest(
      customerMainDaySlots,
      (s) => isAfternoon(s) && !picked.has(slotKey(s))
    );
    if (option2) picked.add(slotKey(option2));

    // 3) Earliest allowed slot across allowed zones (can be earlier than main day)
    const option3 = pickEarliest(allowedSlots, (s) => !picked.has(slotKey(s)));
    if (option3) picked.add(slotKey(option3));

    // 4) Prefer same-day as option3 but opposite AM/PM; else next allowed slot
    let option4 = null;
    if (option3) {
      const sameDay = allowedSlots.filter(
        (s) => String(s.service_date) === String(option3.service_date)
      );
      const wantOpposite = isMorning(option3) ? isAfternoon : isMorning;

      option4 = pickEarliest(
        sameDay,
        (s) => wantOpposite(s) && !picked.has(slotKey(s))
      );
    }
    if (!option4) option4 = pickEarliest(allowedSlots, (s) => !picked.has(slotKey(s)));
    if (option4) picked.add(slotKey(option4));

    // 5) Wednesday pressure valve:
    // Prefer ANY Wednesday slot not already picked.
    // If none exists in our fetched horizon, fall back to next allowed slot.
   // 5) Wednesday pressure valve — ALWAYS Wednesday if any exist
const wedSlots = allowedSlots
  .filter((s) => weekdayUTC(toDateOnlyUTC(s.service_date)) === WED)
  .sort(sortByDateThenStart);

// Pick the earliest Wednesday that is not already picked
let option5 = pickEarliest(wedSlots, (s) => !picked.has(slotKey(s)));

if (option5) {
  picked.add(slotKey(option5));
} else {
  // Absolute fallback only if NO Wednesday exists at all
  option5 = pickEarliest(allowedSlots, (s) => !picked.has(slotKey(s)));
  if (option5) picked.add(slotKey(option5));
}


    const allFive = [option1, option2, option3, option4, option5].filter(Boolean);

    const primary = allFive.slice(0, 3);
    const more = type === "no_one_home" ? [] : allFive.slice(3, 5);

    return res.status(200).json({
      zone,
      appointmentType: type,
      primary: primary.map(toPublic),
      more: {
        options: more.map(toPublic),
        show_no_one_home_cta: type !== "no_one_home",
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 400) : undefined,
    });
  }
};
