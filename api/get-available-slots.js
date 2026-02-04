// /api/get-available-slots.js
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const zone = String(req.query.zone || "")
      .trim()
      .toUpperCase();

    const typeRaw = String(req.query.type || "standard")
      .trim()
      .toLowerCase();

    // type: standard | parts | no_one_home
    const type =
      typeRaw === "parts"
        ? "parts"
        : typeRaw === "no_one_home" ||
          typeRaw === "no-one-home" ||
          typeRaw === "noonehome"
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

    // ---- Helpers ----
    const toDateOnly = (iso) => {
      const [y, m, d] = String(iso).split("-").map((n) => parseInt(n, 10));
      return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
    };

    const weekday = (dateOnlyUTC) => dateOnlyUTC.getUTCDay(); // 0=Sun..6=Sat

    const isMorning = (slot) => {
      if (slot.daypart) return String(slot.daypart).toLowerCase() === "morning";
      const t = String(slot.start_time || "").slice(0, 5); // HH:MM
      return t && t < "12:00";
    };
    const isAfternoon = (slot) => !isMorning(slot);

    const sortByDateThenStart = (a, b) => {
      const da = String(a.service_date);
      const db = String(b.service_date);
      if (da < db) return -1;
      if (da > db) return 1;
      const sa = String(a.start_time || "");
      const sb = String(b.start_time || "");
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return (a.slot_index ?? 0) - (b.slot_index ?? 0);
    };

    const keyOf = (s) => `${s.service_date}|${s.slot_index}`;

    const dedupeSlots = (arr) => {
      const seen = new Set();
      const out = [];
      for (const s of arr) {
        if (!s) continue;
        const k = keyOf(s);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
      }
      return out;
    };

    const stripToPublic = (s) => ({
      service_date: s.service_date,
      slot_index: s.slot_index,
      zone_code: s.zone_code,
      daypart: s.daypart ?? (isMorning(s) ? "morning" : "afternoon"),
      window_label: s.window_label ?? null,
      start_time: s.start_time,
      end_time: s.end_time,
    });

    const pickFirst = (pool, predicate, alreadyPickedSet) => {
      const found = pool
        .filter((s) => !alreadyPickedSet.has(keyOf(s)))
        .filter(predicate)
        .sort(sortByDateThenStart)[0];
      return found || null;
    };

    const pickNextAny = (pool, alreadyPickedSet) => {
      const found = pool
        .filter((s) => !alreadyPickedSet.has(keyOf(s)))
        .sort(sortByDateThenStart)[0];
      return found || null;
    };

    // Zone day mapping (your weekly plan)
    // Mon=B, Tue=D, Wed=flex, Thu=A, Fri=C
    const mainWeekdayForZone = { A: 4, B: 1, C: 5, D: 2 }; // 0=Sun..6=Sat

    // Adjacent relationships A—B—C—D
    const adj = {
      A: ["B"],
      B: ["A", "C"],
      C: ["B", "D"],
      D: ["C"],
    };

    // Second-tier only relevant to Wednesday (soft), never for Mon/Tue/Thu/Fri
    const secondTier = {
      A: ["C"],
      B: ["D"],
      C: ["A"],
      D: ["B"],
    };

    // ---- Fetch open slots from Supabase ----
    // IMPORTANT: zone_code=in.(A,B,C) must NOT include quotes.
    const zonesToFetch = Array.from(
      new Set([zone, ...(adj[zone] || []), ...(secondTier[zone] || [])])
    );
    const zoneList = zonesToFetch.join(",");

    const today = new Date().toISOString().slice(0, 10);

    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&zone_code=in.(${zoneList})` +
      `&is_booked=eq.false` +
      `&service_date=gte.${today}` +
      `&order=service_date.asc,slot_index.asc` +
      `&limit=2000`;

    const supaResp = await fetch(fetchUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
    });

    const slots = await supaResp.json();

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
        more: {
          options: [],
          show_no_one_home_cta: type !== "no_one_home",
        },
      });
    }

    // ---- Build strict pools (protect zone logic) ----
    const mainDow = mainWeekdayForZone[zone];
    const adjZones = adj[zone] || [];
    const adjDows = adjZones.map((z) => mainWeekdayForZone[z]);

    const openMain = slots.filter((s) => {
      const dow = weekday(toDateOnly(s.service_date));
      return s.zone_code === zone && dow === mainDow;
    });

    const openAdj = slots.filter((s) => {
      const dow = weekday(toDateOnly(s.service_date));
      return adjZones.includes(s.zone_code) && adjDows.includes(dow);
    });

    const openWed = slots.filter((s) => weekday(toDateOnly(s.service_date)) === 3);

    // Wednesday preference: same zone first, then adjacent, then second-tier
    const openWedSame = openWed.filter((s) => s.zone_code === zone);
    const openWedAdj = openWed.filter((s) => adjZones.includes(s.zone_code));
    const openWedTier2 = openWed.filter((s) => (secondTier[zone] || []).includes(s.zone_code));
    const openWedOrdered = [...openWedSame, ...openWedAdj, ...openWedTier2].sort(sortByDateThenStart);

    // ---- Selection rules ----
    // ALWAYS:
    // - For standard/parts: return primary (3) + more.options (2) when possible.
    // - Never allow random zones on Mon/Tue/Thu/Fri (only main zone day + adjacent zone day).
    // - Make the 5th option a Wednesday “pressure valve” for standard/parts (if any exist).
    // - For no_one_home: ONLY 3 options, no “more options”, no CTA.
    let primary = [];
    let moreOptions = [];

    const picked = new Set();

    const pushPick = (s) => {
      if (!s) return false;
      const k = keyOf(s);
      if (picked.has(k)) return false;
      picked.add(k);
      primary.push(s);
      return true;
    };

    // STANDARD PRIMARY:
    // 1) main-day morning (zone's main day)
    // 2) main-day afternoon (zone's main day)
    // 3) one adjacent-day slot (either AM or PM, earliest available)
    const buildStandardPrimary = () => {
      const p = [];
      const used = new Set();

      const m1 = pickFirst(openMain, (s) => isMorning(s), used);
      if (m1) used.add(keyOf(m1));

      const m2 = pickFirst(openMain, (s) => isAfternoon(s), used);
      if (m2) used.add(keyOf(m2));

      const a3 = pickNextAny(openAdj, used);
      if (a3) used.add(keyOf(a3));

      return dedupeSlots([m1, m2, a3]).slice(0, 3);
    };

    if (type === "parts") {
      // Parts: Wednesday-heavy primary (3), then fill missing with standard
      const used = new Set();
      const w1 = pickFirst(openWedOrdered, (s) => isMorning(s), used);
      if (w1) used.add(keyOf(w1));
      const w2 = pickFirst(openWedOrdered, (s) => isAfternoon(s), used);
      if (w2) used.add(keyOf(w2));
      const w3 = pickNextAny(openWedOrdered, used);

      primary = dedupeSlots([w1, w2, w3]).slice(0, 3);

      if (primary.length < 3) {
        const fill = buildStandardPrimary();
        const merged = dedupeSlots([...primary, ...fill]).slice(0, 3);
        primary = merged;
      }
    } else {
      primary = buildStandardPrimary();
    }

    // Track picked primary
    for (const s of primary) picked.add(keyOf(s));

    // If no_one_home: only 3 options, no "more"
    if (type === "no_one_home") {
      return res.status(200).json({
        zone,
        appointmentType: type,
        primary: primary.map(stripToPublic),
        more: {
          options: [],
          show_no_one_home_cta: false,
        },
      });
    }

    // MORE OPTIONS (2):
    // Option 4: opposite daypart on the SAME adjacent-day date used in primary (if possible),
    //          otherwise next best adjacent-day slot not already picked.
    // Option 5: Wednesday pressure valve (next best Wednesday slot not already picked).
    const primaryAdj = primary.find((s) => adjZones.includes(s.zone_code));

    // Option 4
    let opt4 = null;
    if (primaryAdj) {
      const targetDate = String(primaryAdj.service_date);
      const oppositePredicate = (s) =>
        String(s.service_date) === targetDate &&
        (isMorning(primaryAdj) ? isAfternoon(s) : isMorning(s));

      // Opposite half on same date (must still be adjacent day and adjacent zone)
      opt4 =
        openAdj
          .filter((s) => !picked.has(keyOf(s)))
          .filter(oppositePredicate)
          .sort(sortByDateThenStart)[0] || null;
    }

    if (!opt4) {
      // fallback: next best adjacent-day slot
      opt4 = pickNextAny(openAdj, picked);
    }

    if (opt4) {
      picked.add(keyOf(opt4));
      moreOptions.push(opt4);
    }

    // Option 5 (Wednesday) — always try to provide this as the final option
    let opt5 = pickNextAny(openWedOrdered, picked);
    if (opt5) {
      picked.add(keyOf(opt5));
      moreOptions.push(opt5);
    }

    // If we still don't have 2 "more" options, fill with another STRICTLY-ALLOWED slot:
    // - Prefer another main-day slot (same zone, same main day)
    // - Else another adjacent-day slot
    while (moreOptions.length < 2) {
      const nextMain = pickNextAny(openMain, picked);
      if (nextMain) {
        picked.add(keyOf(nextMain));
        moreOptions.push(nextMain);
        continue;
      }

      const nextAdj = pickNextAny(openAdj, picked);
      if (nextAdj) {
        picked.add(keyOf(nextAdj));
        moreOptions.push(nextAdj);
        continue;
      }

      // If truly nothing exists in allowed pools, stop (won’t violate zone logic).
      break;
    }

    return res.status(200).json({
      zone,
      appointmentType: type,
      primary: primary.map(stripToPublic),
      more: {
        options: moreOptions.map(stripToPublic).slice(0, 2),
        show_no_one_home_cta: true,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
```0
