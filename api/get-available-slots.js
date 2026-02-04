// /api/get-available-slots.js

// ---- fetch fallback (prevents Vercel crashes when global fetch is missing) ----
const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    /* -------------------- Inputs -------------------- */
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

    const cursorRaw = req.query.cursor ? String(req.query.cursor) : null;

    /* -------------------- Env -------------------- */
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    /* -------------------- Date/time helpers -------------------- */
    const todayISO = new Date().toISOString().slice(0, 10);
    const WED = 3;

    const toUTCDate = (d) => {
      const [y, m, day] = String(d).split("-").map(Number);
      return new Date(Date.UTC(y, (m || 1) - 1, day || 1));
    };
    const dow = (d) => toUTCDate(d).getUTCDay(); // 0=Sun..6=Sat

    const isMorning = (s) => {
      if (s.daypart) return String(s.daypart).toLowerCase() === "morning";
      return String(s.start_time || "").slice(0, 5) < "12:00";
    };

    const slotKey = (s) => `${String(s.service_date)}|${Number(s.slot_index)}`;

    const toPublic = (s) => ({
      service_date: String(s.service_date),
      slot_index: Number(s.slot_index),
      zone_code: String(s.zone_code || "").toUpperCase(),
      daypart: s.daypart
        ? String(s.daypart).toLowerCase()
        : isMorning(s)
        ? "morning"
        : "afternoon",
      window_label: s.window_label ?? null,
      start_time: s.start_time,
      end_time: s.end_time,
    });

    const sortChrono = (a, b) =>
      String(a.service_date).localeCompare(String(b.service_date)) ||
      String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
      Number(a.slot_index) - Number(b.slot_index);

    // Treat schedule_slots times as Pacific local time
    const SCHED_TZ = "America/Los_Angeles";
    const getNowInTZ = (tz) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(new Date());

      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
      const date = `${map.year}-${map.month}-${map.day}`; // YYYY-MM-DD
      const time = `${map.hour}:${map.minute}:${map.second}`; // HH:MM:SS
      return { date, time };
    };
    const nowLocal = getNowInTZ(SCHED_TZ);

    /* -------------------- Zone rules -------------------- */
    // Dispatch-day mapping: Mon=B, Tue=D, Wed=X, Thu=A, Fri=C
    const mainDow = { A: 4, B: 1, C: 5, D: 2, X: WED };
    const dayZoneForDow = { 1: "B", 2: "D", 3: "X", 4: "A", 5: "C" };

    // 1-step adjacency around A-B-C-D
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };

    /* -------------------- Fetch (all zones including X) -------------------- */
    const zonesToFetch = "X,A,B,C,D";
    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&is_booked=eq.false` +
      `&service_date=gte.${todayISO}` +
      `&zone_code=in.(${zonesToFetch})` +
      `&order=service_date.asc,start_time.asc,slot_index.asc` +
      `&limit=2000`;

    const resp = await fetchFn(fetchUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
      },
    });

    const rawText = await resp.text();
    let slots;
    try {
      slots = JSON.parse(rawText);
    } catch {
      return res.status(500).json({
        error: "Bad Supabase response (non-JSON)",
        status: resp.status,
        body: rawText.slice(0, 500),
      });
    }

    if (!resp.ok) {
      return res.status(500).json({
        error: "Supabase fetch failed",
        status: resp.status,
        details: slots,
      });
    }

    if (!Array.isArray(slots)) {
      return res.status(500).json({ error: "Bad Supabase response (not array)" });
    }

    slots.sort(sortChrono);

    /* -------------------- Discipline rules -------------------- */
    const CORE = new Set([1, 2, 5, 6]);
    const MORNING_PAIR = new Set([3, 4]);
    const AFTERNOON_PAIR = new Set([7, 8]);

    // Pass 1: basic eligibility + remove started slots
    const prelim = slots.filter((s) => {
      const d = String(s.service_date || "");
      if (!d) return false;

      const idx = Number(s.slot_index);
      if (!Number.isFinite(idx)) return false;

      // Don't offer slots that already started (Pacific local time)
      const st = String(s.start_time || "").slice(0, 8); // HH:MM:SS
      if (d === nowLocal.date && st && st <= nowLocal.time) return false;

      const dowNum = dow(d);
      const dayZone = dayZoneForDow[dowNum];
      if (!dayZone) return false; // Mon-Fri only

      const z = String(s.zone_code || "").toUpperCase();

      // Wednesday: only X
      if (dayZone === "X") return z === "X" && dowNum === WED;

      // Non-Wed: never X
      if (z === "X") return false;

      // Core slots MUST match the day's zone
      if (CORE.has(idx)) return z === dayZone;

      // Pair slots can be day zone or either adjacent zone for that day
      if (MORNING_PAIR.has(idx) || AFTERNOON_PAIR.has(idx)) {
        const adj = adj1[dayZone] || [];
        return z === dayZone || adj.includes(z);
      }

      return false;
    });

    // Group by date for pair logic / slot-8 lock rule
    const byDate = new Map();
    for (const s of prelim) {
      const d = String(s.service_date);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    const allowed = [];

    for (const [d, daySlots] of byDate.entries()) {
      const dowNum = dow(d);
      const dayZone = dayZoneForDow[dowNum];
      const dz = String(dayZone || "").toUpperCase();

      // Wednesday is X-only; no special pair logic needed
      if (dz === "X") {
        allowed.push(...daySlots);
        continue;
      }

      const idxMap = new Map(daySlots.map((s) => [Number(s.slot_index), s]));
      const getZ = (s) => String(s?.zone_code || "").toUpperCase();

      // --- Slot 8 lock rule ---
      // If ANY of slots 1-7 are still available, do NOT offer slot 8.
      const hasAny1to7 = [1, 2, 3, 4, 5, 6, 7].some((i) => idxMap.has(i));
      if (hasAny1to7) idxMap.delete(8);

      // --- Morning pair rule (3,4) ---
      // If slot 3 is adjacent (not day zone), slot 4 must match slot 3 zone.
      // If slot 3 is day zone, slot 4 can be day zone OR either adjacent (flex rule).
      const s3 = idxMap.get(3) || null;
      const s4 = idxMap.get(4) || null;
      if (s3 && s4) {
        const z3 = getZ(s3);
        const z4 = getZ(s4);
        if (z3 !== dz) {
          // slot 3 is adjacent -> slot 4 must match
          if (z4 !== z3) idxMap.delete(4);
        }
      }

      // --- Afternoon pair rule (7,8) (with slot8 already possibly removed) ---
      // If slot 7 is adjacent -> slot 8 must match slot 7 zone (if slot 8 exists).
      // If slot 7 is day zone -> slot 8 can be day zone or either adjacent (but slot8 lock may remove it anyway).
      const s7 = idxMap.get(7) || null;
      const s8 = idxMap.get(8) || null;
      if (s7 && s8) {
        const z7 = getZ(s7);
        const z8 = getZ(s8);
        if (z7 !== dz) {
          if (z8 !== z7) idxMap.delete(8);
        }
      }

      allowed.push(...idxMap.values());
    }

    allowed.sort(sortChrono);

    if (allowed.length === 0) {
      return res.status(200).json({
        zone,
        appointmentType: type,
        primary: [],
        more: { options: [], show_no_one_home_cta: type !== "no_one_home" },
      });
    }

    /* -------------------- Cursor logic (parts only) -------------------- */
    const parseCursor = (c) => {
      if (!c) return null;
      const [d, i] = String(c).split("|");
      const n = Number(i);
      if (!d || !Number.isFinite(n)) return null;
      return { d, i: n };
    };
    const cursor = parseCursor(cursorRaw);

    const afterCursor = (s) => {
      if (!cursor) return true;
      const sd = String(s.service_date);
      const si = Number(s.slot_index);
      if (sd > cursor.d) return true;
      if (sd < cursor.d) return false;
      return si > cursor.i;
    };

    /* =====================================================
       PARTS FLOW
       ===================================================== */
    if (type === "parts") {
      const picked = new Set();
      const out = [];

      const eligibleZone = (z) => {
        z = String(z || "").toUpperCase();
        if (!z) return false;
        if (z === zone) return true;
        return (adj1[zone] || []).includes(z);
      };

      const firstPage = !cursorRaw;

      const wedPool = allowed
        .filter((s) => String(s.zone_code || "").toUpperCase() === "X" && afterCursor(s))
        .sort(sortChrono);

      const chronoPool = allowed
        .filter((s) => {
          const zc = String(s.zone_code || "").toUpperCase();
          return zc !== "X" && eligibleZone(zc) && afterCursor(s);
        })
        .sort(sortChrono);

      const take = (s) => {
        if (!s) return;
        const k = slotKey(s);
        if (picked.has(k)) return;
        picked.add(k);
        out.push(s);
      };

      if (firstPage) {
        take(wedPool.find((s) => isMorning(s)));
        take(wedPool.find((s) => !isMorning(s)));
      }

      for (const s of chronoPool) {
        if (out.length >= 3) break;
        take(s);
      }

      const last = out[out.length - 1];
      const nextCursor = last ? `${last.service_date}|${Number(last.slot_index)}` : (cursorRaw || "");

      return res.status(200).json({
        zone,
        appointmentType: "parts",
        primary: out.map(toPublic),
        more: { options: [], show_no_one_home_cta: true },
        meta: { nextCursor },
      });
    }

    /* =====================================================
       STANDARD / NO-ONE-HOME (always 5 options)
       1-2: customer zone on its main day (AM + PM)
       3-4: adjacent-day overflow for customer zone (NOT same date as 1/2)
            Prefer slot 4 then slot 7 then slot 3 then slot 8
            Option 4 tries to be opposite AM/PM from option 3 (same date preferred)
       5: Wednesday X last
       ===================================================== */

    const picked = new Set();
    const take = (s) => {
      if (!s) return null;
      const k = slotKey(s);
      if (picked.has(k)) return null;
      picked.add(k);
      return s;
    };

    // MAIN DAY pool (customer zone on its dispatch day)
    const mainPool = allowed
      .filter((s) => {
        const zc = String(s.zone_code || "").toUpperCase();
        return zc === zone && dow(String(s.service_date)) === mainDow[zone];
      })
      .sort(sortChrono);

  // ADJACENT DAY pool:
// For customer zone "A", adjacent day is "B" day.
// We want slots whose *day zone* is adjacent to the customer zone.
// IMPORTANT: these slots will usually have zone_code = that day’s zone (ex: "B" on Monday),
// not the customer’s zone.
const adjacentDayZones = adj1[zone] || [];

const crossPoolRaw = allowed
  .filter((s) => {
    const d = String(s.service_date || "");
    if (!d) return false;

    const dDow = dow(d);
    if (dDow === WED) return false;

    const dayZone = dayZoneForDow[dDow]; // the day’s route zone (B, D, A, C)
    if (!dayZone) return false;

    // Only consider adjacent-day zones (ex: for zone A, only B-day)
    if (!adjacentDayZones.includes(dayZone)) return false;

    // Only the “flex” slots on that day are valid for adjacent work
    const idx = Number(s.slot_index);
    if (![3, 4, 7, 8].includes(idx)) return false;

    // These slots will normally be stored with zone_code = dayZone.
    // If your generator ever stores adjacent-zone codes here too, we can allow those later,
    // but start strict so we get predictable behavior.
    const zc = String(s.zone_code || "").toUpperCase();
    return zc === dayZone;
  })
  .sort(sortChrono);


    // Priority within a day for cross-day options:
    // prefer slot 4 (mid AM) then slot 7 (early PM) then slot 3 then slot 8
    const crossPriority = (idx) => {
      if (idx === 4) return 0;
      if (idx === 7) return 1;
      if (idx === 3) return 2;
      if (idx === 8) return 3;
      return 9;
    };

    const crossPool = [...crossPoolRaw].sort((a, b) => {
      const da = String(a.service_date),
        db = String(b.service_date);
      if (da !== db) return da.localeCompare(db);
      const pa = crossPriority(Number(a.slot_index));
      const pb = crossPriority(Number(b.slot_index));
      if (pa !== pb) return pa - pb;
      return (
        String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
        Number(a.slot_index) - Number(b.slot_index)
      );
    });

    const wedPool = allowed
      .filter((s) => String(s.zone_code || "").toUpperCase() === "X")
      .sort(sortChrono);

    // Option 1 (main day AM)
    const o1 = take(mainPool.find((s) => isMorning(s)) || mainPool[0] || null);

    // Option 2 (same day PM preferred)
    let o2 = null;
    if (o1) {
      o2 = take(
        mainPool.find(
          (s) =>
            String(s.service_date) === String(o1.service_date) &&
            isMorning(s) !== isMorning(o1)
        ) || null
      );
    }
    if (!o2) {
      const opp = o1 ? mainPool.find((s) => isMorning(s) !== isMorning(o1)) : null;
      o2 = take(opp || mainPool.find((s) => !picked.has(slotKey(s))) || null);
    }

    const blockedDate = o1 ? String(o1.service_date) : null;
    const isBlocked = (s) => blockedDate && String(s.service_date) === blockedDate;

    // Option 3 (adjacent-day overflow, not same date as 1/2)
    let o3 = take(crossPool.find((s) => !isBlocked(s) && !picked.has(slotKey(s))) || null);

    // Option 4 (opposite AM/PM preferred, same date preferred, still not blockedDate)
    let o4 = null;
    if (o3) {
      const wantOpp = !isMorning(o3);

      o4 =
        take(
          crossPool.find(
            (s) =>
              !isBlocked(s) &&
              !picked.has(slotKey(s)) &&
              String(s.service_date) === String(o3.service_date) &&
              isMorning(s) === wantOpp
          ) || null
        ) ||
        take(
          crossPool.find(
            (s) => !isBlocked(s) && !picked.has(slotKey(s)) && isMorning(s) === wantOpp
          ) || null
        ) ||
        take(crossPool.find((s) => !isBlocked(s) && !picked.has(slotKey(s))) || null);
    }

    // Option 5 (Wednesday X last; not blockedDate)
    const o5 = take(wedPool.find((s) => !isBlocked(s)) || wedPool[0] || null);

    // Fill to 5 (still avoid blocked date for slots beyond 1/2 unless absolutely necessary)
    const fill = (pool, respectBlocked) => {
      const found = pool.find((s) => {
        if (picked.has(slotKey(s))) return false;
        if (respectBlocked && isBlocked(s)) return false;
        return true;
      });
      return take(found || null);
    };

    let all = [o1, o2, o3, o4, o5].filter(Boolean);

    while (all.length < 5) {
      const added =
        fill(crossPool, true) ||
        fill(mainPool, true) ||
        fill(wedPool, true) ||
        fill(crossPool, false) ||
        fill(mainPool, false) ||
        fill(wedPool, false);

      if (!added) break;
      all.push(added);
    }

    // Ensure X is last if present
    const xs = all.filter((s) => String(s.zone_code || "").toUpperCase() === "X");
    const nonX = all.filter((s) => String(s.zone_code || "").toUpperCase() !== "X");
    if (xs.length) all = [...nonX, ...xs].slice(0, 5);

    return res.status(200).json({
      zone,
      appointmentType: type,
      primary: all.slice(0, 3).map(toPublic),
      more: {
        options: type === "no_one_home" ? [] : all.slice(3, 5).map(toPublic),
        show_no_one_home_cta: type !== "no_one_home",
      },
    });
  } catch (err) {
    // If you ever see JSON with stack, the function is running and we’re in logic debugging mode (good).
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 1400) : null,
    });
  }
};
