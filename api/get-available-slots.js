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

    // Adjacency preference order (IMPORTANT)
    const adjPreference = {
      A: ["B"],
      B: ["A", "C"], // B prefers A-day first
      C: ["D", "B"], // C prefers D-day first
      D: ["C"],
    };

    // Fetch set for NON-Wednesday logic (requested + adj + second-tier),
    // but we must fetch ALL zones so Wednesday can actually appear.
    const zonesToFetch = Array.from(
      new Set([zone, ...(adj[zone] || []), ...(secondTier[zone] || [])])
    );

    const ALL_ZONES = ["A", "B", "C", "D"];
    const zoneInAll = ALL_ZONES.join(",");

    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&is_booked=eq.false` +
      `&service_date=gte.${todayISO}` +
      // IMPORTANT: fetch all zones so Wednesday slots aren't accidentally excluded
      `&zone_code=in.(${zoneInAll})` +
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

      if (dow === WED) return true; // only global flex day
      return dow === mainDow; // all other days must match slot's zone day
    });

    if (allowedSlots.length === 0) {
      return res.status(200).json({
        zone,
        appointmentType: type,
        primary: [],
        more: { options: [], show_no_one_home_cta: type !== "no_one_home" },
      });
    }

    // ---------- Day cap: max 2 options per calendar day ----------
    const dayCount = new Map(); // service_date -> count
    const canUseDay = (dateStr) => (dayCount.get(dateStr) || 0) < 2;
    const bumpDay = (dateStr) =>
      dayCount.set(dateStr, (dayCount.get(dateStr) || 0) + 1);

    const picked = new Set();

    const takeSlot = (slot) => {
      if (!slot) return null;
      const k = slotKey(slot);
      const d = String(slot.service_date);
      if (picked.has(k)) return null;
      if (!canUseDay(d)) return null;
      picked.add(k);
      bumpDay(d);
      return slot;
    };

    const pickFrom = (arr, predicate) => {
      const s = pickEarliest(arr, predicate);
      return takeSlot(s);
    };

    // ---------- Slot pools ----------
    const customerMainDow = mainWeekdayForZone[zone];

    // customer zone slots (any allowed day, including Wednesday)
    const customerZoneSlots = allowedSlots.filter(
      (s) => String(s.zone_code || "").toUpperCase() === zone
    );

    // customer main-day only (NOT Wednesday)
    const customerMainDaySlots = customerZoneSlots.filter((s) => {
      const dow = weekdayUTC(toDateOnlyUTC(s.service_date));
      return dow === customerMainDow;
    });

    // Adjacent slots (NON-Wednesday) with preference order
    const preferredAdjZones = adjPreference[zone] || (adj[zone] || []);

    // Adjacent pools should only consider "zonesToFetch" (tightening scope)
    const allowedAdjZone = (z) => zonesToFetch.includes(z);

    const adjNonWedSlotsByZone = (z) =>
      allowedSlots.filter((s) => {
        const zz = String(s.zone_code || "").toUpperCase();
        if (zz !== z) return false;
        if (!allowedAdjZone(zz)) return false;

        const dow = weekdayUTC(toDateOnlyUTC(s.service_date));
        return dow !== WED; // options 3/4 are not Wednesday
      });

    const pickAdjacentAM = () => {
      for (const z of preferredAdjZones) {
        const pool = adjNonWedSlotsByZone(z);

        const found = pickFrom(
          pool,
          (s) =>
            isMorning(s) &&
            !picked.has(slotKey(s)) &&
            canUseDay(String(s.service_date))
        );
        if (found) return found;

        const any = pickFrom(
          pool,
          (s) => !picked.has(slotKey(s)) && canUseDay(String(s.service_date))
        );
        if (any) return any;
      }
      return null;
    };

    const pickAdjacentPMPreferSameDay = (sameDayStr) => {
      // Try SAME DAY afternoon first (across preferred adj zones in order)
      if (sameDayStr) {
        for (const z of preferredAdjZones) {
          const poolSameDay = adjNonWedSlotsByZone(z).filter(
            (s) => String(s.service_date) === String(sameDayStr)
          );

          const found = pickFrom(
            poolSameDay,
            (s) =>
              isAfternoon(s) &&
              !picked.has(slotKey(s)) &&
              canUseDay(String(s.service_date))
          );
          if (found) return found;
        }

        // If no afternoon on same day, take any on same day
        for (const z of preferredAdjZones) {
          const poolSameDay = adjNonWedSlotsByZone(z).filter(
            (s) => String(s.service_date) === String(sameDayStr)
          );

          const any = pickFrom(
            poolSameDay,
            (s) => !picked.has(slotKey(s)) && canUseDay(String(s.service_date))
          );
          if (any) return any;
        }
      }

      // Otherwise take next earliest adjacent PM (preferred zones in order)
      for (const z of preferredAdjZones) {
        const pool = adjNonWedSlotsByZone(z);

        const found = pickFrom(
          pool,
          (s) =>
            isAfternoon(s) &&
            !picked.has(slotKey(s)) &&
            canUseDay(String(s.service_date))
        );
        if (found) return found;

        const any = pickFrom(
          pool,
          (s) => !picked.has(slotKey(s)) && canUseDay(String(s.service_date))
        );
        if (any) return any;
      }
      return null;
    };

    const pickWednesday = () => {
      // Wednesday can be ANY zone (because we fetched all zones)
      const wedSlots = allowedSlots.filter(
        (s) => weekdayUTC(toDateOnlyUTC(s.service_date)) === WED
      );
      return pickFrom(
        wedSlots,
        (s) => !picked.has(slotKey(s)) && canUseDay(String(s.service_date))
      );
    };

    // ---------- Build 5 options (structured) ----------
    // 1) Customer zone main-day AM
    const option1 = pickFrom(
      customerMainDaySlots,
      (s) => isMorning(s) && !picked.has(slotKey(s))
    );

    // 2) Customer zone main-day PM
    const option2 = pickFrom(
      customerMainDaySlots,
      (s) => isAfternoon(s) && !picked.has(slotKey(s))
    );

    // 3) Adjacent day AM (B->A first, C->D first)
    const option3 = pickAdjacentAM();

    // 4) Adjacent day PM (prefer same day as #3)
    const option4 = pickAdjacentPMPreferSameDay(
      option3 ? String(option3.service_date) : null
    );

    // 5) Wednesday (force Wednesday if exists)
    let option5 = pickWednesday();

    // Fallback: still respects day cap + allowedSlots + uniqueness
    if (!option5) {
      option5 = pickFrom(
        allowedSlots,
        (s) => !picked.has(slotKey(s)) && canUseDay(String(s.service_date))
      );
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
