// /api/get-available-slots.js
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const zone = String(req.query.zone || "").trim().toUpperCase();
    const typeRaw = String(req.query.type || "standard").trim().toLowerCase();

    // type: standard | parts | no_one_home
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

    // ---- Helpers ----
    const toDateOnly = (iso) => {
      // expects YYYY-MM-DD
      const [y, m, d] = String(iso).split("-").map((n) => parseInt(n, 10));
      return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
    };

    const weekday = (dateOnlyUTC) => {
      // 0=Sun ... 6=Sat
      return dateOnlyUTC.getUTCDay();
    };

    const isMorning = (slot) => {
      if (slot.daypart) return String(slot.daypart).toLowerCase() === "morning";
      // fallback: start_time < 12:00
      const t = String(slot.start_time || "").slice(0, 5); // HH:MM
      return t && t < "12:00";
    };

    const isAfternoon = (slot) => !isMorning(slot);

    const sameDate = (a, b) => String(a) === String(b);

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

    // "Jump 1 to 3 when necessary" (A<->C, B<->D allowed as second-tier)
    const secondTier = {
      A: ["C"],
      B: ["D"],
      C: ["A"],
      D: ["B"],
    };

    const nextDatesMatchingWeekday = (slots, targetDow) => {
      // returns unique service_dates (sorted) that match targetDow
      const dates = new Set();
      for (const s of slots) {
        const d = toDateOnly(s.service_date);
        if (weekday(d) === targetDow) dates.add(String(s.service_date));
      }
      return Array.from(dates).sort();
    };

    const pickEarliestOnDate = (slots, service_date, predicate) => {
      const filtered = slots
        .filter((s) => sameDate(s.service_date, service_date))
        .filter(predicate)
        .sort(sortByDateThenStart);
      return filtered[0] || null;
    };

    const pickEarliestOnDates = (slots, service_dates, predicate) => {
      for (const d of service_dates) {
        const found = pickEarliestOnDate(slots, d, predicate);
        if (found) return found;
      }
      return null;
    };

    const dedupeSlots = (arr) => {
      const seen = new Set();
      const out = [];
      for (const s of arr) {
        if (!s) continue;
        const key = `${s.service_date}|${s.slot_index}`;
        if (seen.has(key)) continue;
        seen.add(key);
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

    // ---- Fetch “eligible slots for this customer zone” from Supabase ----
    // This assumes your DB view/function already applies your zone-eligibility rules.
    // If your table/view name differs, change ONLY the path below.
    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&zone_code=eq.${encodeURIComponent(zone)}` +
      `&is_booked=eq.false` +
      `&service_date=gte.${new Date().toISOString().slice(0, 10)}` +
      `&order=service_date.asc,slot_index.asc` +
      `&limit=400`;

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
      // Keep the response shape stable
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

    // ---- Selection logic (your rules) ----

    // Find next “main day” date(s) for this zone
    const mainDow = mainWeekdayForZone[zone];
    const mainDates = nextDatesMatchingWeekday(slots, mainDow);

    // Adjacent-zone days (based on adjacent zone’s main day)
    const adjZones = adj[zone] || [];
    const adjDows = adjZones.map((z) => mainWeekdayForZone[z]);
    const adjDates = Array.from(
      new Set(adjDows.flatMap((dow) => nextDatesMatchingWeekday(slots, dow)))
    ).sort();

    // Wednesday dates
    const wedDates = nextDatesMatchingWeekday(slots, 3);

    // PRIMARY:
    // - standard: main-day morning + main-day afternoon + one adjacent-day (prefer morning)
    // - parts: prefer Wednesday-heavy first (3 best on Wednesday), then fall back to standard
    // - no_one_home: only 3 best (same as primary), and we will NOT return “more options”
    let primary = [];
    let moreOptions = [];

    const buildStandardPrimary = () => {
      const p = [];
      const mainMorning = pickEarliestOnDates(slots, mainDates, (s) => isMorning(s));
      const mainAfternoon = pickEarliestOnDates(slots, mainDates, (s) => isAfternoon(s));

      // Adjacent day: pick morning first if possible (your example), else afternoon
      const adjMorning = pickEarliestOnDates(slots, adjDates, (s) => isMorning(s));
      const adjAfternoon = pickEarliestOnDates(slots, adjDates, (s) => isAfternoon(s));
      const adjPick = adjMorning || adjAfternoon;

      p.push(mainMorning, mainAfternoon, adjPick);
      return dedupeSlots(p).slice(0, 3);
    };

    const pickWednesdayOptionForZone = () => {
      // Wednesday “favor” rules:
      // Try same-zone first; then adjacent zones; then second-tier; avoid A<->D if possible.
      // NOTE: your DB may already encode eligibility, so we just pick from returned slots.
      // We’ll bias by choosing the earliest Wednesday slot.
      const base = pickEarliestOnDates(slots, wedDates, () => true);
      return base;
    };

    if (type === "parts") {
      // 3 options that are Wednesday-heavy
      const wedMorning = pickEarliestOnDates(slots, wedDates, (s) => isMorning(s));
      const wedAfternoon = pickEarliestOnDates(slots, wedDates, (s) => isAfternoon(s));
      const wedAny2 = pickEarliestOnDates(
        slots,
        wedDates,
        (s) => ![wedMorning, wedAfternoon].includes(s)
      );

      primary = dedupeSlots([wedMorning, wedAfternoon, wedAny2]).slice(0, 3);

      // If not enough Wednesday slots, fill with standard primary
      if (primary.length < 3) {
        const standardFill = buildStandardPrimary();
        primary = dedupeSlots([...primary, ...standardFill]).slice(0, 3);
      }
    } else {
      primary = buildStandardPrimary();
    }

    // MORE OPTIONS (only if NOT no_one_home):
    // Option 1: opposite half of the *adjacent day* that was shown in primary (if any)
    // Option 2: Wednesday pressure valve (following Wednesday bias)
    if (type !== "no_one_home") {
      // Find which adjacent-day we used (if we did)
      const primaryAdj = primary.find((s) => {
        const d = toDateOnly(s.service_date);
        const dow = weekday(d);
        return adjDows.includes(dow);
      });

      let oppositeAdj = null;
      if (primaryAdj) {
        const targetDate = String(primaryAdj.service_date);
        oppositeAdj = pickEarliestOnDate(
          slots,
          targetDate,
          (s) => (isMorning(primaryAdj) ? isAfternoon(s) : isMorning(s))
        );
      } else {
        // If we didn’t have an adjacent primary, still try to provide one “adjacent opposite half”
        const anyAdjMorning = pickEarliestOnDates(slots, adjDates, (s) => isMorning(s));
        const anyAdjAfternoon = pickEarliestOnDates(slots, adjDates, (s) => isAfternoon(s));
        oppositeAdj = anyAdjMorning || anyAdjAfternoon;
      }

      const wedOption = pickWednesdayOptionForZone();

      moreOptions = dedupeSlots([oppositeAdj, wedOption])
        .filter(Boolean)
        .filter((s) => !primary.some((p) => p.service_date === s.service_date && p.slot_index === s.slot_index))
        .slice(0, 2);
    }

    const response = {
      zone,
      appointmentType: type,
      primary: primary.map(stripToPublic),
      more: {
        options: moreOptions.map(stripToPublic),
        show_no_one_home_cta: type !== "no_one_home",
      },
    };

    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
