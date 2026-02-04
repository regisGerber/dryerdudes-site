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

    // 1-step adjacency list around A-B-C-D
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

    /* -------------------- Enforce weekday + slot-index discipline -------------------- */
    // Day zone by DOW (Mon..Fri)
    const dayZoneForDow = { 1: "B", 2: "D", 3: "X", 4: "A", 5: "C" };

    // Slot buckets
    const CORE_SLOTS = new Set([1, 2, 5, 6]);
    const PAIR_A_SLOTS = new Set([3, 4]);
    const PAIR_B_SLOTS = new Set([7, 8]);

    // First pass: basic eligibility + "past start time" removal
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

      if (CORE_SLOTS.has(idx)) return z === dayZone;

      if (PAIR_A_SLOTS.has(idx) || PAIR_B_SLOTS.has(idx)) {
        const adj = adj1[dayZone] || [];
        return z === dayZone || adj.includes(z);
      }

      return false;
    });

    // Second pass: enforce pair-lock per day for (3,4) and (7,8)
    // If both exist and mismatch, keep the dayZone one if present; otherwise drop both.
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
        if (!a || !b) return;

        const za = String(a.zone_code || "").toUpperCase();
        const zb = String(b.zone_code || "").toUpperCase();
        if (za === zb) return;

        const aIsDay = za === dz;
        const bIsDay = zb === dz;

        if (aIsDay && !bIsDay) idxMap.delete(i2);
        else if (bIsDay && !aIsDay) idxMap.delete(i1);
        else {
          // two different adjacents (shouldn't happen with a correct schedule generator)
          idxMap.delete(i1);
          idxMap.delete(i2);
        }
      };

      if (dz !== "X") {
        enforcePair(3, 4);
        enforcePair(7, 8);
      }

      for (const s of idxMap.values()) allowed.push(s);
    }

    allowed.sort(sortChrono);

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
       Rules:
       1-2: customer zone on its main day (AM/PM) — walk forward until found
       3-4: cross-day options (customer zone on other non-Wed days)
            - prioritize slot 4 before slot 3 within a day (offer 4 then 3)
            - option 4 tries to be opposite AM/PM from option 3 (same day preferred)
       5: Wednesday X (always last)
       Page behavior:
       - primary shows first 3
       - more.options shows 4 and 5 (unless no_one_home)
       ===================================================== */

    const picked = new Set();

    const take = (s) => {
      if (!s) return null;
      const k = slotKey(s);
      if (picked.has(k)) return null;
      picked.add(k);
      return s;
    };

    const mainPool = allowed
      .filter((s) => {
        const zc = String(s.zone_code || "").toUpperCase();
        return zc === zone && dow(String(s.service_date)) === mainDow[zone];
      })
      .sort(sortChrono);

    const crossPoolRaw = allowed
      .filter((s) => {
        const zc = String(s.zone_code || "").toUpperCase();
        if (zc !== zone) return false;
        const d = String(s.service_date || "");
        const dDow = dow(d);
        if (dDow === WED) return false;
        return dDow !== mainDow[zone];
      })
      .sort(sortChrono);

    // Custom priority for cross-day:
    // Prefer slot 4, then 3, then 7, then 8 (you want "offer 4 then 3")
    const crossPriority = (idx) => {
      if (idx === 4) return 0;
      if (idx === 3) return 1;
      if (idx === 7) return 2;
      if (idx === 8) return 3;
      return 9;
    };

    const crossPool = [...crossPoolRaw].sort((a, b) => {
      const da = String(a.service_date), db = String(b.service_date);
      if (da !== db) return da.localeCompare(db);
      const pa = crossPriority(Number(a.slot_index));
      const pb = crossPriority(Number(b.slot_index));
      if (pa !== pb) return pa - pb;
      // tie-break by time then slot
      return (
        String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
        Number(a.slot_index) - Number(b.slot_index)
      );
    });

    const wedPool = allowed
      .filter((s) => String(s.zone_code || "").toUpperCase() === "X")
      .sort(sortChrono);

    // Helper: pick earliest morning/afternoon from a pool, walking forward.
    const firstByDaypart = (pool, wantMorning) => {
      const target = pool.find((s) => isMorning(s) === wantMorning);
      return target || null;
    };

    // Options 1 & 2 (main day): prefer AM + PM (same day if possible, else walk forward)
    let o1 = take(firstByDaypart(mainPool, true) || mainPool[0] || null);

    let o2 = null;
    if (o1) {
      // Prefer opposite daypart on same date
      const sameDateOpp = mainPool.find(
        (s) => String(s.service_date) === String(o1.service_date) && isMorning(s) !== isMorning(o1)
      );
      o2 = take(sameDateOpp || null);
    }
    if (!o2) {
      // Else pick earliest opposite daypart anywhere, else next earliest
      const opp = o1 ? mainPool.find((s) => isMorning(s) !== isMorning(o1)) : null;
      o2 = take(opp || mainPool.find((s) => !picked.has(slotKey(s))) || null);
    }

    // Option 3 (cross-day): earliest by date, but with slot 4->3->7->8 priority
    let o3 = take(crossPool.find((s) => !picked.has(slotKey(s))) || null);

    // Option 4: prefer opposite AM/PM from option 3, same date if possible, else next opposite anywhere
    let o4 = null;
    if (o3) {
      const wantOpp = !isMorning(o3);

      const sameDateOpp = crossPool.find(
        (s) =>
          !picked.has(slotKey(s)) &&
          String(s.service_date) === String(o3.service_date) &&
          isMorning(s) === wantOpp
      );

      o4 = take(sameDateOpp || null);

      if (!o4) {
        const anyOpp = crossPool.find((s) => !picked.has(slotKey(s)) && isMorning(s) === wantOpp);
        o4 = take(anyOpp || null);
      }

      if (!o4) {
        o4 = take(crossPool.find((s) => !picked.has(slotKey(s))) || null);
      }
    } else {
      // If cross pool is empty, still do NOT promote Wednesday into top 3.
      // We instead keep walking forward via mainPool (next available main day slots).
      const nextMain = mainPool.find((s) => !picked.has(slotKey(s)));
      o3 = take(nextMain || null);

      if (o3) {
        const wantOpp = !isMorning(o3);
        const sameDateOpp = mainPool.find(
          (s) =>
            !picked.has(slotKey(s)) &&
            String(s.service_date) === String(o3.service_date) &&
            isMorning(s) === wantOpp
        );
        o4 = take(sameDateOpp || null);
        if (!o4) {
          const anyOpp = mainPool.find((s) => !picked.has(slotKey(s)) && isMorning(s) === wantOpp);
          o4 = take(anyOpp || null);
        }
        if (!o4) o4 = take(mainPool.find((s) => !picked.has(slotKey(s))) || null);
      }
    }

    // Option 5: Wednesday X (always last)
    const o5 = take(wedPool[0] || null);

    // Hard requirement: always produce 5 if possible by walking forward.
    // If any are missing, fill from mainPool then crossPool then wedPool again (won't duplicate due to picked).
    const fillFrom = (pool) => {
      const s = pool.find((x) => !picked.has(slotKey(x)));
      return take(s || null);
    };

    let all = [o1, o2, o3, o4, o5].filter(Boolean);

    while (all.length < 5) {
      const added =
        fillFrom(mainPool) || fillFrom(crossPoolRaw) || fillFrom(wedPool);

      if (!added) break; // extremely unlikely unless schedule is empty
      all.push(added);
    }

    // Ensure Wednesday is last if it exists in the list
    // (in case fill logic pulled it earlier when schedule is extremely sparse)
    const xs = all.filter((s) => String(s.zone_code || "").toUpperCase() === "X");
    const nonX = all.filter((s) => String(s.zone_code || "").toUpperCase() !== "X");
    if (xs.length > 0) all = [...nonX, ...xs]; // pushes X to end

    // Still return in the 3 + (2 hidden) shape
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
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
