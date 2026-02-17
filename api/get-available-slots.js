// /api/get-available-slots.js
// Implements Option B:
// - 5 independent pools
// - NO cross-pool backfill (opt3/opt4 never replaced by same-zone options)
// - opt3/opt4 always adjacent-day only; scan forward in time until found
// - removes old pair-lock rules (keeps ≤2 zones per AM/PM block constraint)
// - adds Supabase pagination so we can look farther out than the first page

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
    const home_location_code = String(req.query.zone || "").trim().toUpperCase();

    const typeRaw = String(req.query.type || "standard").trim().toLowerCase();
    const appointmentType =
      typeRaw === "parts"
        ? "parts"
        : typeRaw === "no_one_home" || typeRaw === "no-one-home" || typeRaw === "noonehome"
        ? "no_one_home"
        : "standard";

    const debug = String(req.query.debug || "").trim() === "1";
    const cursorRaw = req.query.cursor ? String(req.query.cursor) : null;

    if (!["A", "B", "C", "D"].includes(home_location_code)) {
      return res.status(400).json({ error: "zone must be A, B, C, or D" });
    }

    /* -------------------- Env -------------------- */
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    /* -------------------- Date/time helpers -------------------- */
    const todayISO = new Date().toISOString().slice(0, 10);
    const WED = 3; // UTC day-of-week for Wednesday

    const toUTCDate = (d) => {
      const [y, m, day] = String(d).split("-").map(Number);
      return new Date(Date.UTC(y, (m || 1) - 1, day || 1));
    };
    const dowUTC = (d) => toUTCDate(d).getUTCDay(); // 0=Sun..6=Sat

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
      return {
        date: `${map.year}-${map.month}-${map.day}`, // YYYY-MM-DD
        time: `${map.hour}:${map.minute}:${map.second}`, // HH:MM:SS
      };
    };
    const nowLocal = getNowInTZ(SCHED_TZ);

    const isMorning = (s) => {
      if (s.daypart) return String(s.daypart).toLowerCase() === "morning";
      return String(s.start_time || "").slice(0, 5) < "12:00";
    };

    const sortChrono = (a, b) =>
      String(a.service_date).localeCompare(String(b.service_date)) ||
      String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
      Number(a.slot_index) - Number(b.slot_index);

    const slotKey = (s) =>
      `${String(s.service_date)}|${Number(s.slot_index)}|${String(s.route_day_zone || "")}`;

    /* -------------------- Zone rules -------------------- */
    // Dispatch-day mapping: Mon=B, Tue=D, Wed=X, Thu=A, Fri=C
    const dayZoneForDow = { 1: "B", 2: "D", 3: "X", 4: "A", 5: "C" };

    // 1-step adjacency around A-B-C-D
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };

    const CORE = new Set([1, 2, 5, 6]); // must be the route_day_zone on non-Wed
    const FLEX_AM = new Set([3, 4]);
    const FLEX_PM = new Set([7, 8]);
    const AM_BLOCK = new Set([1, 2, 3, 4]);
    const PM_BLOCK = new Set([5, 6, 7, 8]);

    // Slot priorities (per your rules)
    const PRI_OPT1_AM = [1, 2, 3, 4]; // exact AM crawl
    const PRI_OPT2_PM = [5, 6, 7, 8]; // exact PM crawl
    const PRI_OPT3_ADJ_AM = [4, 3]; // adjacent AM inside-out
    const PRI_OPT4_ADJ_PM = [8, 7]; // adjacent PM inside-out (mirrors opt3)
    const PRI_WED = [1, 2, 3, 4, 5, 6, 7, 8]; // Wed preference

    /* -------------------- Supabase fetch (paginated) -------------------- */
    // We page because limit=2000 can truncate the calendar and make it "look like" we ran out of slots.
    const zonesToFetch = "X,A,B,C,D";
    const baseUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&service_date=gte.${todayISO}` +
      `&zone_code=in.(${zonesToFetch})` +
      `&order=service_date.asc,start_time.asc,slot_index.asc`;

    const PAGE_SIZE = 1000;      // Supabase REST plays nicest with 0-999 ranges
    const MAX_PAGES = 25;        // 25k rows cap for safety (adjust if you ever need)
    const allRows = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const resp = await fetchFn(baseUrl, {
        method: "GET",
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: `Bearer ${SERVICE_ROLE}`,
          Accept: "application/json",
          Range: `${from}-${to}`,
        },
      });

      const rawText = await resp.text();
      let rows;
      try {
        rows = JSON.parse(rawText);
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
          details: rows,
        });
      }

      if (!Array.isArray(rows)) {
        return res.status(500).json({ error: "Bad Supabase response (not array)" });
      }

      allRows.push(...rows);

      // If we got fewer than a full page, we're done.
      if (rows.length < PAGE_SIZE) break;
    }

    if (!allRows.length) {
      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType,
        primary: [],
        more: { options: [], show_no_one_home_cta: appointmentType !== "no_one_home" },
      });
    }

    /* -------------------- Normalize / enrich rows -------------------- */
    const normalized = allRows
      .map((r) => {
        const service_date = String(r.service_date || "");
        const slot_index = Number(r.slot_index);
        const slot_zone_code = String(r.zone_code || "").toUpperCase();
        const dOw = service_date ? dowUTC(service_date) : null;
        const route_day_zone = dOw != null ? dayZoneForDow[dOw] : null;

        return {
          service_date,
          slot_index,
          slot_zone_code,
          zone_code: slot_zone_code, // legacy naming
          daypart: r.daypart ?? null,
          window_label: r.window_label ?? null,
          start_time: r.start_time ?? null,
          end_time: r.end_time ?? null,
          is_booked: Boolean(r.is_booked),
          dow_utc: dOw,
          route_day_zone: route_day_zone ? String(route_day_zone).toUpperCase() : null,
        };
      })
      .filter((r) => r.service_date && Number.isFinite(r.slot_index) && r.route_day_zone)
      .sort(sortChrono);

    /* -------------------- Started-slot filter (offers only) -------------------- */
    const notStarted = (r) => {
      const d = r.service_date;
      const st = String(r.start_time || "").slice(0, 8); // HH:MM:SS
      if (d === nowLocal.date && st && st <= nowLocal.time) return false;
      return true;
    };

    /* -------------------- ≤2 route zones per AM/PM block on regular days -------------------- */
    const bookedZonesByDate = new Map();
    const ensureDate = (d) => {
      if (!bookedZonesByDate.has(d)) {
        bookedZonesByDate.set(d, { am: new Set(), pm: new Set() });
      }
      return bookedZonesByDate.get(d);
    };

    for (const r of normalized) {
      if (!r.is_booked) continue;
      if (r.route_day_zone === "X") continue; // Wed gets its own logic, skip ≤2 rule
      const entry = ensureDate(r.service_date);
      if (AM_BLOCK.has(r.slot_index)) entry.am.add(r.slot_zone_code);
      if (PM_BLOCK.has(r.slot_index)) entry.pm.add(r.slot_zone_code);
    }

    const passesTwoZoneRule = (r) => {
      if (r.route_day_zone === "X") return true;
      const entry = ensureDate(r.service_date);
      const z = r.slot_zone_code;

      if (AM_BLOCK.has(r.slot_index)) {
        const s = new Set(entry.am);
        s.add(z);
        return s.size <= 2;
      }
      if (PM_BLOCK.has(r.slot_index)) {
        const s = new Set(entry.pm);
        s.add(z);
        return s.size <= 2;
      }
      return true;
    };

    /* -------------------- Base eligibility for offer-candidates -------------------- */
    const isOfferEligible = (r) => {
      if (r.is_booked) return false;
      if (!notStarted(r)) return false;

      const dayZone = r.route_day_zone;
      if (!dayZone) return false;

      // Wednesday: X-only
      if (dayZone === "X") {
        return r.slot_zone_code === "X";
      }

      // Non-Wed: never X
      if (r.slot_zone_code === "X") return false;

      // Core slots MUST match day zone
      if (CORE.has(r.slot_index)) {
        if (r.slot_zone_code !== dayZone) return false;
        return passesTwoZoneRule(r);
      }

      // Flex slots: day zone OR adjacent to day zone
      if (FLEX_AM.has(r.slot_index) || FLEX_PM.has(r.slot_index)) {
        const allowedZ = new Set([dayZone, ...(adj1[dayZone] || [])]);
        if (!allowedZ.has(r.slot_zone_code)) return false;
        return passesTwoZoneRule(r);
      }

      return false;
    };

    const offerCandidates = normalized.filter(isOfferEligible).sort(sortChrono);

    if (offerCandidates.length === 0) {
      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType,
        primary: [],
        more: { options: [], show_no_one_home_cta: appointmentType !== "no_one_home" },
        meta: debug ? { debug, nowLocal, todayISO } : undefined,
      });
    }

    /* =====================================================
       Cursor logic (parts only)
       ===================================================== */
    const parseCursor = (c) => {
      if (!c) return null;
      const [d, i] = String(c).split("|");
      const n = Number(i);
      if (!d || !Number.isFinite(n)) return null;
      return { d, i: n };
    };
    const cursor = parseCursor(cursorRaw);
    const afterCursor = (r) => {
      if (!cursor) return true;
      const sd = String(r.service_date);
      const si = Number(r.slot_index);
      if (sd > cursor.d) return true;
      if (sd < cursor.d) return false;
      return si > cursor.i;
    };

    if (appointmentType === "parts") {
      const picked = new Set();
      const out = [];

      const eligibleZone = (z) => {
        z = String(z || "").toUpperCase();
        if (!z) return false;
        if (z === home_location_code) return true;
        return (adj1[home_location_code] || []).includes(z);
      };

      const take = (r) => {
        if (!r) return;
        const k = slotKey(r);
        if (picked.has(k)) return;
        picked.add(k);
        out.push(r);
      };

      const firstPage = !cursorRaw;

      const wedPool = offerCandidates.filter((r) => r.route_day_zone === "X" && afterCursor(r));
      const chronoPool = offerCandidates.filter((r) => {
        if (r.route_day_zone === "X") return false;
        return eligibleZone(r.slot_zone_code) && afterCursor(r);
      });

      if (firstPage) {
        take(wedPool.find((r) => isMorning(r)));
        take(wedPool.find((r) => !isMorning(r)));
      }

      for (const r of chronoPool) {
        if (out.length >= 3) break;
        take(r);
      }

      const last = out[out.length - 1];
      const nextCursor = last ? `${last.service_date}|${Number(last.slot_index)}` : cursorRaw || "";

      const toPublicParts = (r) => ({
        service_date: r.service_date,
        slot_index: r.slot_index,
        zone_code: r.slot_zone_code,
        daypart: r.daypart ? String(r.daypart).toLowerCase() : isMorning(r) ? "morning" : "afternoon",
        window_label: r.window_label,
        start_time: r.start_time,
        end_time: r.end_time,
      });

      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType: "parts",
        primary: out.map(toPublicParts),
        more: { options: [], show_no_one_home_cta: true },
        meta: { nextCursor, ...(debug ? { debug, nowLocal, todayISO } : {}) },
      });
    }

    /* =====================================================
       STANDARD / NO-ONE-HOME  (Option B)
       - 5 independent pools
       - NO cross-pool backfill
       - opt3/opt4 ALWAYS adjacent-day only; scan forward until found
       ===================================================== */

    const groupByDate = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const d = r.service_date;
        if (!m.has(d)) m.set(d, []);
        m.get(d).push(r);
      }
      return m;
    };

    const pickByDateAndSlotPriority = (rows, slotPriority, excludeSet) => {
      const byDate = groupByDate(rows);
      const dates = Array.from(byDate.keys()).sort((a, b) => a.localeCompare(b));
      for (const d of dates) {
        const dayRows = byDate.get(d);
        const idxMap = new Map(dayRows.map((r) => [r.slot_index, r]));
        for (const idx of slotPriority) {
          const r = idxMap.get(idx);
          if (!r) continue;
          if (excludeSet && excludeSet.has(slotKey(r))) continue;
          return r;
        }
      }
      return null;
    };

    // Pools (strict per your rules)
    const adjDayZonesForHome = adj1[home_location_code] || [];

    // Option 1: exact AM, route_day_zone == home, slot_zone_code == home, slots 1→2→3→4
    const opt1Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone !== home_location_code) return false;
      if (!AM_BLOCK.has(r.slot_index)) return false;
      return r.slot_zone_code === home_location_code;
    });

    // Option 2: exact PM, route_day_zone == home, slot_zone_code == home, slots 5→6→7→8
    const opt2Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone !== home_location_code) return false;
      if (!PM_BLOCK.has(r.slot_index)) return false;
      return r.slot_zone_code === home_location_code;
    });

    // Option 3: adjacent-day AM ONLY (route_day_zone in adj1[home]), slots 4→3
    // Strict: slot_zone_code == route_day_zone (i.e., truly that adjacent route-day’s core/valid zone)
    const opt3Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone === "X") return false;
      if (!adjDayZonesForHome.includes(r.route_day_zone)) return false;
      if (!FLEX_AM.has(r.slot_index)) return false;
      return r.slot_zone_code === r.route_day_zone;
    });

    // Option 4: adjacent-day PM ONLY, same constraints as opt3, slots 8→7
    const opt4Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone === "X") return false;
      if (!adjDayZonesForHome.includes(r.route_day_zone)) return false;
      if (!FLEX_PM.has(r.slot_index)) return false;
      return r.slot_zone_code === r.route_day_zone;
    });

    // Option 5: Wednesday X, nearest, slots 1..8 priority
    const opt5Pool = offerCandidates.filter((r) => r.route_day_zone === "X" && r.slot_zone_code === "X");

    // Uniqueness across returned slots (still needed)
    const picked = new Set();
    const takeUnique = (r) => {
      if (!r) return null;
      const k = slotKey(r);
      if (picked.has(k)) return null;
      picked.add(k);
      return r;
    };

    // Pick each option from its own pool only
    const o1 = takeUnique(pickByDateAndSlotPriority(opt1Pool, PRI_OPT1_AM, picked));
    const o2 = takeUnique(pickByDateAndSlotPriority(opt2Pool, PRI_OPT2_PM, picked));
    const o3 = takeUnique(pickByDateAndSlotPriority(opt3Pool, PRI_OPT3_ADJ_AM, picked));
    const o4 = takeUnique(pickByDateAndSlotPriority(opt4Pool, PRI_OPT4_ADJ_PM, picked));
    const o5 = takeUnique(pickByDateAndSlotPriority(opt5Pool, PRI_WED, picked));

    // IMPORTANT: Option B = no cross-pool backfill.
    // If any option is missing, it stays missing (unless you later decide to add "fallback policy").
    // We still keep uniqueness (picked) so we never duplicate a slot.

    let options = [o1, o2, o3, o4, o5].filter(Boolean);

    // Keep Wed last if present
    const xs = options.filter((r) => r.route_day_zone === "X");
    const nonX = options.filter((r) => r.route_day_zone !== "X");
    if (xs.length) options = [...nonX, ...xs];

    const toPublic = (r) => ({
      service_date: r.service_date,
      slot_index: r.slot_index,
      zone_code: r.slot_zone_code, // legacy field used by UI / downstream
      daypart: r.daypart ? String(r.daypart).toLowerCase() : isMorning(r) ? "morning" : "afternoon",
      window_label: r.window_label ?? null,
      start_time: r.start_time,
      end_time: r.end_time,
    });

    const primary = options.slice(0, 3).map(toPublic);
    const moreOptions = options.slice(3, 5).map(toPublic);

    return res.status(200).json({
      zone: home_location_code,
      home_location_code,
      appointmentType,
      primary,
      more: {
        options: appointmentType === "no_one_home" ? [] : moreOptions,
        show_no_one_home_cta: appointmentType !== "no_one_home",
      },
      meta: debug
        ? {
            debug: true,
            nowLocal,
            todayISO,
            fetched_rows: allRows.length,
            candidates: offerCandidates.length,
            pools: {
              opt1: opt1Pool.length,
              opt2: opt2Pool.length,
              opt3: opt3Pool.length,
              opt4: opt4Pool.length,
              opt5: opt5Pool.length,
            },
            note:
              "Option B active: no cross-pool backfill. opt3/opt4 are adjacent-day only and will scan forward within adjacent days; if your calendar doesn't contain future adjacent days, pools can be empty.",
          }
        : undefined,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 1400) : null,
    });
  }
};
