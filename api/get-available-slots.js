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
        : typeRaw === "no_one_home" ||
          typeRaw === "no-one-home" ||
          typeRaw === "noonehome"
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
      service_date: s.service_date,
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

    // 1-step adjacency (for parts eligibility + general “adjacent zone” concept)
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };

    /* -------------------- Fetch (all zones, including X) -------------------- */
    const zonesToFetch = "X,A,B,C,D";

    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&is_booked=eq.false` +
      `&service_date=gte.${todayISO}` +
      `&zone_code=in.(${zonesToFetch})` +
      `&order=service_date.asc,start_time.asc,slot_index.asc` +
      `&limit=1000`;

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
        body: rawText.slice(0, 400),
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

    /* -------------------- Enforce weekday + slot-index discipline -------------------- */
    // Day zone by DOW (Mon..Fri)
    const dayZoneForDow = { 1: "B", 2: "D", 3: "X", 4: "A", 5: "C" };

    // Slot buckets:
    // 1-2 and 5-6 MUST be the day's zone
    // 3-4 can be the day's zone OR either adjacent zone (pair-lock enforced later)
    // 7-8 can be the day's zone OR either adjacent zone (pair-lock enforced later)
    const CORE_SLOTS = new Set([1, 2, 5, 6]);
    const PAIR_A_SLOTS = new Set([3, 4]);
    const PAIR_B_SLOTS = new Set([7, 8]);

    // First pass: basic per-slot eligibility (incl. "past start time" removal)
    const prelim = slots.filter((s) => {
      const d = String(s.service_date || "");
      if (!d) return false;

      const idx = Number(s.slot_index);
      if (!Number.isFinite(idx)) return false;

      // Don't offer slots that already started (based on Pacific local time)
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

      if (CORE_SLOTS.has(idx)) return z === dayZone;

      if (PAIR_A_SLOTS.has(idx) || PAIR_B_SLOTS.has(idx)) {
        const adj = adj1[dayZone] || [];
        return z === dayZone || adj.includes(z);
      }

      return false;
    });

    // Second pass: enforce pair-lock within each day for (3,4) and (7,8)
    // Rule: if BOTH slots in a pair are available, they must match zone_code.
    // If they don't match, we keep the dayZone one (if present) and drop the adjacent one.
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

      const idxMap = new Map(daySlots.map((s) => [Number(s.slot_index), s]));

      const enforcePair = (i1, i2) => {
        const a = idxMap.get(i1) || null;
        const b = idxMap.get(i2) || null;

        if (!a && !b) return;

        // If one is missing, keep the one that exists.
        if (!a || !b) return;

        const za = String(a.zone_code || "").toUpperCase();
        const zb = String(b.zone_code || "").toUpperCase();

        // Match => ok
        if (za === zb) return;

        // Mismatch => drop the adjacent one and keep dayZone if possible
        const aIsDay = za === dz;
        const bIsDay = zb === dz;

        if (aIsDay && !bIsDay) idxMap.delete(i2);
        else if (bIsDay && !aIsDay) idxMap.delete(i1);
        else {
          // two different adjacent zones (shouldn't happen if your schedule is generated correctly)
          // safest is to drop both to avoid breaking the lock rule
          idxMap.delete(i1);
          idxMap.delete(i2);
        }
      };

      // Don't enforce on Wednesday; it's X-only anyway
      if (dz !== "X") {
        enforcePair(3, 4);
        enforcePair(7, 8);
      }

      for (const s of idxMap.values()) allowed.push(s);
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
       - first page: Wed X AM + X PM (if available)
       - then next-available chronological slots
       - non-Wed parts eligible: customer zone + adj1 ONLY (no tier2)
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
       STANDARD / NO-ONE-HOME (5 structured)
       1-2: customer zone on its main day (AM/PM)
       3-4: customer zone on other non-Wed days (these will only exist in 3/4/7/8 due to allowed rules)
       5: Wednesday X (last)
       ===================================================== */
    const pickedStd = new Set();
    const dayCountStd = new Map();
    const canUseDayStd = (d) => (dayCountStd.get(d) || 0) < 2;

    const takeStd = (s) => {
      if (!s) return null;
      const k = slotKey(s);
      if (pickedStd.has(k)) return null;
      const d = String(s.service_date);
      if (!canUseDayStd(d)) return null;
      pickedStd.add(k);
      dayCountStd.set(d, (dayCountStd.get(d) || 0) + 1);
      return s;
    };

    const mainDayPool = allowed
      .filter((s) => {
        const zc = String(s.zone_code || "").toUpperCase();
        if (zc !== zone) return false;
        return dow(String(s.service_date)) === mainDow[zone];
      })
      .sort(sortChrono);

    const crossDayPool = allowed
      .filter((s) => {
        const zc = String(s.zone_code || "").toUpperCase();
        if (zc !== zone) return false;
        const d = String(s.service_date || "");
        const dDow = dow(d);
        if (dDow === WED) return false;
        return dDow !== mainDow[zone];
      })
      .sort(sortChrono);

    const wedPoolStd = allowed
      .filter((s) => String(s.zone_code || "").toUpperCase() === "X")
      .sort(sortChrono);

    const o1 = takeStd(mainDayPool.find((s) => isMorning(s)));
    const o2 = takeStd(mainDayPool.find((s) => !isMorning(s)));

    let o3 = takeStd(crossDayPool.find((s) => isMorning(s)));
    if (!o3) o3 = takeStd(crossDayPool[0] || null);

    let o4 = null;
    if (o3) {
      o4 =
        takeStd(
          crossDayPool.find(
            (s) =>
              !isMorning(s) &&
              String(s.service_date) === String(o3.service_date)
          )
        ) || null;

      if (!o4) o4 = takeStd(crossDayPool.find((s) => !isMorning(s))) || null;
      if (!o4) o4 = takeStd(crossDayPool.find((s) => true)) || null;
    }

    const o5 = takeStd(wedPoolStd[0] || null);

    const all = [o1, o2, o3, o4, o5].filter(Boolean);

    return res.status(200).json({
      zone,
      appointmentType: type,
      primary: all.slice(0, 3).map(toPublic),
      more: {
        options: type === "no_one_home" ? [] : all.slice(3).map(toPublic),
        show_no_one_home_cta: type !== "no_one_home",
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
