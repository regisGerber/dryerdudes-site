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
    const secondTier = {
  A: ["C"],
  B: ["D"],
  C: ["A"],
  D: ["B"],
};


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

    // ---------- Zone rules ----------
    // Mon=B, Tue=D, Wed=X, Thu=A, Fri=C
    const WED = 3;

    const mainWeekdayForZone = { A: 4, B: 1, C: 5, D: 2, X: WED }; // X is Wednesday-only

    // 1-step adjacency + 2-step fallback
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };
    const adj2 = { A: ["C"], B: ["D"], C: ["A"], D: ["B"] };

    // IMPORTANT: preference inside adjacency
    // B prefers A before C; C prefers D before B
    const adjPreference = {
      A: ["B"],
      B: ["A", "C"],
      C: ["D", "B"],
      D: ["C"],
    };

    // Fetch only: requested zone + 1-step + 2-step + X
    const zonesToFetch = Array.from(
      new Set(["X", zone, ...(adj1[zone] || []), ...(adj2[zone] || [])])
    );

    // Supabase in() wants: in.(A,B,C) with no quotes
    const zoneIn = zonesToFetch.join(",");

    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&is_booked=eq.false` +
      `&service_date=gte.${todayISO}` +
      `&zone_code=in.(${zoneIn})` +
      `&order=service_date.asc,start_time.asc,slot_index.asc` +
      `&limit=1000`;

    const supaResp = await fetch(fetchUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
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

    slots.sort(sortByDateThenStart);

    // ---------- HARD enforce zone logic ----------
    // - X only allowed on Wednesday
    // - A/B/C/D only allowed on their assigned weekday
    const allowedSlots = slots.filter((s) => {
      const z = String(s.zone_code || "").toUpperCase();
      const dow = weekdayUTC(toDateOnlyUTC(s.service_date));

      if (z === "X") return dow === WED;

      const mainDow = mainWeekdayForZone[z];
      if (mainDow === undefined) return false;

      return dow === mainDow;
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

    const pickFrom = (arr, predicate) => takeSlot(pickEarliest(arr, predicate));

    // ---------- Pools ----------
    const customerMainDow = mainWeekdayForZone[zone];

    const customerMainDaySlots = allowedSlots.filter((s) => {
      const z = String(s.zone_code || "").toUpperCase();
      if (z !== zone) return false;
      const dow = weekdayUTC(toDateOnlyUTC(s.service_date));
      return dow === customerMainDow;
    });

    const xWedSlots = allowedSlots.filter(
      (s) => String(s.zone_code || "").toUpperCase() === "X"
    );

    const preferredAdjZones = adjPreference[zone] || adj1[zone] || [];
    const secondTierZones = adj2[zone] || [];

    const poolForZoneNonWed = (z) =>
      allowedSlots.filter((s) => {
        const zz = String(s.zone_code || "").toUpperCase();
        if (zz !== z) return false;
        const dow = weekdayUTC(toDateOnlyUTC(s.service_date));
        return dow !== WED; // never use X/Wed pool for adj slots
      });

    const pickAdjAM = () => {
      // 1-step first, then 2-step if needed
      const order = [...preferredAdjZones, ...secondTierZones];
      for (const z of order) {
        const pool = poolForZoneNonWed(z);
        const am = pickFrom(pool, (s) => isMorning(s) && !picked.has(slotKey(s)));
        if (am) return am;
        const any = pickFrom(pool, (s) => !picked.has(slotKey(s)));
        if (any) return any;
      }
      return null;
    };

    const pickAdjPMPreferSameDay = (sameDayStr) => {
      const order = [...preferredAdjZones, ...secondTierZones];

      if (sameDayStr) {
        for (const z of order) {
          const poolSame = poolForZoneNonWed(z).filter(
            (s) => String(s.service_date) === String(sameDayStr)
          );
          const pm = pickFrom(poolSame, (s) => isAfternoon(s) && !picked.has(slotKey(s)));
          if (pm) return pm;
          const any = pickFrom(poolSame, (s) => !picked.has(slotKey(s)));
          if (any) return any;
        }
      }

      for (const z of order) {
        const pool = poolForZoneNonWed(z);
        const pm = pickFrom(pool, (s) => isAfternoon(s) && !picked.has(slotKey(s)));
        if (pm) return pm;
        const any = pickFrom(pool, (s) => !picked.has(slotKey(s)));
        if (any) return any;
      }
      return null;
    };

    const pickWednesdayX = () =>
      pickFrom(xWedSlots, (s) => !picked.has(slotKey(s)));

    // ---------- Build options ----------
    // Your “shape” stays:
    // 1-2 = customer zone day
    // 3-4 = adjacent day (1-step preferred, 2-step fallback)
    // 5 = Wednesday X (strategic)
    //
    // BUT: for PARTS, we pull Wednesday into PRIMARY if it exists.

    const option1 = pickFrom(customerMainDaySlots, (s) => isMorning(s) && !picked.has(slotKey(s)));
    const option2 = pickFrom(customerMainDaySlots, (s) => isAfternoon(s) && !picked.has(slotKey(s)));

    const option3 = pickAdjAM();
    const option4 = pickAdjPMPreferSameDay(option3 ? String(option3.service_date) : null);

    let option5 = pickWednesdayX();

    // Safe fallback if no Wed exists
    if (!option5) {
      option5 = pickFrom(allowedSlots, (s) => !picked.has(slotKey(s)));
    }

   // ---------- PARTS MODE (nudged) ----------
if (type === "parts") {
  const WED = 3;

  const step = Math.max(0, parseInt(String(req.query.step || "0"), 10) || 0);
  const cursorRaw = String(req.query.cursor || "").trim();

  // 3,2,1,1,1... (pressure)
  const batchSizes = [3, 2, 1];
  const batchSize = batchSizes[Math.min(step, batchSizes.length - 1)];

  // Parse cursor "YYYY-MM-DD|slot_index"
  const parseCursor = (c) => {
    const [d, idx] = String(c || "").split("|");
    const n = parseInt(idx, 10);
    if (!d || !Number.isFinite(n)) return null;
    return { d, n };
  };

  const cursor = parseCursor(cursorRaw);

  // Only consider slots strictly AFTER cursor for "next available" filling
  const isAfterCursor = (s) => {
    if (!cursor) return true;
    const d = String(s.service_date);
    const n = Number(s.slot_index ?? 0);
    if (d > cursor.d) return true;
    if (d < cursor.d) return false;
    return n > cursor.n;
  };

  // Day cap still applies (prevents dumping one day)
  const dayCount = new Map();
  const canUseDay = (dateStr) => (dayCount.get(dateStr) || 0) < 2;
  const bumpDay = (dateStr) => dayCount.set(dateStr, (dayCount.get(dateStr) || 0) + 1);

  const picked = new Set();
  const chosen = [];

  const take = (s) => {
    if (!s) return false;
    const k = slotKey(s);
    const d = String(s.service_date);
    if (picked.has(k)) return false;
    if (!canUseDay(d)) return false;
    picked.add(k);
    bumpDay(d);
    chosen.push(s);
    return true;
  };

  // Wednesday pool (zone_code === "X" OR any zone on Wed — pick what you’re actually using)
  // If you set Wed slots to zone_code "X", this is best:
  const wedPool = allowedSlots.filter((s) => {
    const z = String(s.zone_code || "").toUpperCase();
    if (z !== "X") return false;
    const dow = weekdayUTC(toDateOnlyUTC(s.service_date));
    return dow === WED;
  });

  // Your adjacency preference order:
  // (B prefers A first; C prefers D first; etc.)
  const preferredAdjZones = adjPreference?.[zone] || adj?.[zone] || [];
  const secondTierZones = secondTier?.[zone] || [];

  // “Eligibility pools” for next-available filling
  const poolCustomer = allowedSlots.filter((s) => String(s.zone_code || "").toUpperCase() === zone);

  const poolAdj = allowedSlots.filter((s) => {
    const z = String(s.zone_code || "").toUpperCase();
    return preferredAdjZones.includes(z);
  });

  const poolSecond = allowedSlots.filter((s) => {
    const z = String(s.zone_code || "").toUpperCase();
    return secondTierZones.includes(z);
  });

  // Helper: earliest slot in pool that is after cursor, not picked, respects day cap
  const pickNextFromPool = (pool) =>
    pickEarliest(pool, (s) => isAfterCursor(s) && !picked.has(slotKey(s)) && canUseDay(String(s.service_date)));

  // 1) On FIRST screen only (step 0), try to lead with Wed AM + Wed PM (pressure)
  if (step === 0) {
    const wedAM = pickEarliest(wedPool, (s) => isMorning(s));
    if (wedAM) take(wedAM);

    const wedPM = pickEarliest(wedPool, (s) => isAfternoon(s) && !picked.has(slotKey(s)));
    if (wedPM) take(wedPM);
  }

  // 2) Fill remaining slots by true “next available” logic
  // Priority: customer zone first, then preferred adjacent, then second-tier, then anything allowed.
  while (chosen.length < batchSize) {
    let next =
      pickNextFromPool(poolCustomer) ||
      pickNextFromPool(poolAdj) ||
      pickNextFromPool(poolSecond) ||
      pickEarliest(allowedSlots, (s) => isAfterCursor(s) && !picked.has(slotKey(s)) && canUseDay(String(s.service_date)));

    if (!next) break;
    take(next);
  }

  // Determine nextCursor for “Show more”
  // Use the last chosen slot OR fall back to cursor
  const last = chosen[chosen.length - 1];
  const nextCursor = last ? `${last.service_date}|${last.slot_index}` : (cursorRaw || "");

  // Determine if more exist after nextCursor
  const nextCursorObj = parseCursor(nextCursor);
  const moreAvailable = allowedSlots.some((s) => {
    if (!nextCursorObj) return true;
    const d = String(s.service_date);
    const n = Number(s.slot_index ?? 0);
    if (d > nextCursorObj.d) return true;
    if (d < nextCursorObj.d) return false;
    return n > nextCursorObj.n;
  });

  // Output: treat "parts" as primary list only (no 5-option structure)
  return res.status(200).json({
    zone,
    appointmentType: type,
    primary: chosen.map(toPublic),
    more: {
      options: [],
      show_no_one_home_cta: true, // always available for parts
    },
    meta: {
      step,
      nextStep: step + 1,
      nextCursor,
      moreAvailable,
      batchSize,
    },
  });
}

    const primary = all.slice(0, 3);
    const more = type === "no_one_home" ? [] : all.slice(3, 5);

    return res.status(200).json({
      zone,
      appointmentType: type,
      primary: primary.map(toPublic),
      more: {
        options: more.map(toPublic),
        show_no_one_home_cta: type !== "no_one_home",
      },
      // optional debug you can remove:
      meta: {
        todayISO,
        zonesFetched: zonesToFetch,
        allowedCount: allowedSlots.length,
        wedXCount: xWedSlots.length,
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
