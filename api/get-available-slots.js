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
    const home_location_code = String(req.query.zone || "")
      .trim()
      .toUpperCase();

    const typeRaw = String(req.query.type || "standard").trim().toLowerCase();
    const appointmentType =
      typeRaw === "parts"
        ? "parts"
        : typeRaw === "no_one_home" ||
          typeRaw === "no-one-home" ||
          typeRaw === "noonehome"
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
      `${String(s.service_date)}|${Number(s.slot_index)}|${String(
        s.route_day_zone || ""
      )}`;

    /* -------------------- Zone rules -------------------- */
    // Dispatch-day mapping: Mon=B, Tue=D, Wed=X, Thu=A, Fri=C
    const dayZoneForDow = { 1: "B", 2: "D", 3: "X", 4: "A", 5: "C" };

    // 1-step adjacency around A-B-C-D (home-location adjacency + route-day adjacency)
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };

    const CORE = new Set([1, 2, 5, 6]); // must be the route_day_zone on non-Wed
    const FLEX_AM = new Set([3, 4]);
    const FLEX_PM = new Set([7, 8]);
    const AM_BLOCK = new Set([1, 2, 3, 4]);
    const PM_BLOCK = new Set([5, 6, 7, 8]);

    // Slot priorities
    const PRI_OPT1_AM = [1, 2, 3, 4]; // option 1 crawl
    const PRI_OPT2_PM = [5, 6, 7, 8]; // option 2 crawl
    const PRI_OPT3_ADJ_AM = [4, 3]; // inside-out for adjacent AM
    const PRI_OPT4_ADJ_PM = [8, 7]; // inside-out for adjacent PM (mirrors option 3)
    const PRI_WED = [1, 2, 3, 4, 5, 6, 7, 8];

    /* -------------------- Fetch schedule slots (include booked) -------------------- */
    const zonesToFetch = "X,A,B,C,D";
    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
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
    let allRows;
    try {
      allRows = JSON.parse(rawText);
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
        details: allRows,
      });
    }

    if (!Array.isArray(allRows)) {
      return res.status(500).json({ error: "Bad Supabase response (not array)" });
    }

    // Normalize / enrich rows
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
          zone_code: slot_zone_code, // keep legacy naming
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

    /* -------------------- Started-slot filter (for offers only) -------------------- */
    const notStarted = (r) => {
      const d = r.service_date;
      const st = String(r.start_time || "").slice(0, 8); // HH:MM:SS
      if (d === nowLocal.date && st && st <= nowLocal.time) return false;
      return true;
    };

    /* -------------------- Booked-zone sets per date/block (≤2 zones constraint) -------------------- */
    // Build: bookedZonesByDate = { [date]: { am:Set, pm:Set } }
    const bookedZonesByDate = new Map();

    const ensureDate = (d) => {
      if (!bookedZonesByDate.has(d)) {
        bookedZonesByDate.set(d, { am: new Set(), pm: new Set() });
      }
      return bookedZonesByDate.get(d);
    };

    for (const r of normalized) {
      if (!r.is_booked) continue;
      const dz = r.route_day_zone;
      if (dz === "X") continue; // ignore Wed (X) for ≤2 rule (not needed)
      const idx = r.slot_index;

      const entry = ensureDate(r.service_date);
      if (AM_BLOCK.has(idx)) entry.am.add(r.slot_zone_code);
      if (PM_BLOCK.has(idx)) entry.pm.add(r.slot_zone_code);
    }

    const passesTwoZoneRule = (r) => {
      // Only enforce on non-Wed
      if (r.route_day_zone === "X") return true;

      const entry = ensureDate(r.service_date);
      const idx = r.slot_index;
      const z = r.slot_zone_code;

      if (AM_BLOCK.has(idx)) {
        const s = new Set(entry.am);
        s.add(z);
        return s.size <= 2;
      }
      if (PM_BLOCK.has(idx)) {
        const s = new Set(entry.pm);
        s.add(z);
        return s.size <= 2;
      }
      return true;
    };

    /* -------------------- Base eligibility for offer-candidates -------------------- */
    const isOfferEligible = (r) => {
      // Only consider unbooked and not-started
      if (r.is_booked) return false;
      if (!notStarted(r)) return false;

      const dayZone = r.route_day_zone;

      // Only Mon-Fri are meaningful in this system (dayZoneForDow maps Mon..Fri)
      if (!dayZone) return false;

      // Wednesday: route_day_zone must be X, and slot_zone_code must be X
      if (dayZone === "X") {
        return r.slot_zone_code === "X";
      }

      // Non-Wed: never allow X slots
      if (r.slot_zone_code === "X") return false;

      // Core slots MUST match the day's zone
      if (CORE.has(r.slot_index)) {
        if (r.slot_zone_code !== dayZone) return false;
        return passesTwoZoneRule(r);
      }

      // Flex slots (3/4, 7/8): may be day zone OR adjacent to the day zone
      if (FLEX_AM.has(r.slot_index) || FLEX_PM.has(r.slot_index)) {
        const allowedZ = new Set([dayZone, ...(adj1[dayZone] || [])]);
        if (!allowedZ.has(r.slot_zone_code)) return false;
        return passesTwoZoneRule(r);
      }

      return false;
    };

    // Candidate offers list (unbooked, not-started, eligible)
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
       Cursor logic (parts only) - unchanged behavior, but uses the new candidate list
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
      // Parts: prefer Wed X (AM + PM), then fill with closest eligible in same/adjacent of home zone.
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

      const wedPool = offerCandidates
        .filter((r) => r.route_day_zone === "X" && afterCursor(r))
        .sort(sortChrono);

      const chronoPool = offerCandidates
        .filter((r) => {
          if (r.route_day_zone === "X") return false;
          return eligibleZone(r.slot_zone_code) && afterCursor(r);
        })
        .sort(sortChrono);

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
        daypart: r.daypart
          ? String(r.daypart).toLowerCase()
          : isMorning(r)
          ? "morning"
          : "afternoon",
        window_label: r.window_label,
        start_time: r.start_time,
        end_time: r.end_time,
        ...(debug
          ? {
              offer_role: "parts",
              home_location_code,
              route_day_zone: r.route_day_zone,
              slot_zone_code: r.slot_zone_code,
              slot_key: `${r.service_date}|${r.slot_index}`,
              dow_utc: r.dow_utc,
              is_morning: isMorning(r),
              day_zone_for_dow: r.route_day_zone,
              now_local_date: nowLocal.date,
              now_local_time: nowLocal.time,
              started_filter_trigger: !notStarted(r),
            }
          : {}),
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
       STANDARD / NO-ONE-HOME
       Implement 5 independent pools (no date-locking), with priorities:
         opt1 (exact AM): 1→2→3→4 on route_day_zone==home
         opt2 (exact PM): 5→6→7→8 on route_day_zone==home
         opt3 (adj AM strict): candidate days route_day_zone ∈ adj1[home], slots 4→3,
                              and slot_zone_code == route_day_zone (clean)
         opt4 (adj PM strict): same constraints as opt3, slots 8→7
         opt5 (Wed X): nearest Wed option, priority 1→2→…→8
       Also: removed old pair-lock behavior entirely.
       Still enforce: ≤2 distinct zones per block (AM and PM) on non-Wed days.
       ===================================================== */

    const picked = new Set();
    const takeUnique = (r, offer_role, bucket) => {
      if (!r) return null;
      const k = slotKey(r);
      if (picked.has(k)) return null;
      picked.add(k);
      return { ...r, offer_role, bucket };
    };

    // Helpers to build pool + pick by priority without doing weird global sorts
    const groupByDate = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const d = r.service_date;
        if (!m.has(d)) m.set(d, []);
        m.get(d).push(r);
      }
      return m;
    };

    const pickByDateAndSlotPriority = (rows, slotPriority) => {
      const byDate = groupByDate(rows);
      const dates = Array.from(byDate.keys()).sort((a, b) => a.localeCompare(b));

      for (const d of dates) {
        const dayRows = byDate.get(d);
        // index => row
        const idxMap = new Map(dayRows.map((r) => [r.slot_index, r]));
        for (const idx of slotPriority) {
          const r = idxMap.get(idx);
          if (r) return r;
        }
      }
      return null;
    };

    // Pools

    // Option 1 (exact AM): route_day_zone == home_location_code, slots 1→2→3→4, AND slot_zone_code must equal home
    const opt1Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone !== home_location_code) return false;
      if (!AM_BLOCK.has(r.slot_index)) return false;
      // Must actually serve the home zone in that slot (slot hasn't broken away)
      return r.slot_zone_code === home_location_code;
    });

    // Option 2 (exact PM): route_day_zone == home_location_code, slots 5→6→7→8, AND slot_zone_code must equal home
    const opt2Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone !== home_location_code) return false;
      if (!PM_BLOCK.has(r.slot_index)) return false;
      return r.slot_zone_code === home_location_code;
    });

    // Option 3 (adjacent-day AM strict): candidate route_day_zone ∈ adj1[home], slots 4→3, AND clean constraint slot_zone_code == route_day_zone
    const adjDayZonesForHome = adj1[home_location_code] || [];
    const opt3Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone === "X") return false;
      if (!adjDayZonesForHome.includes(r.route_day_zone)) return false;
      if (!FLEX_AM.has(r.slot_index)) return false;
      // Clean adjacent-day constraint:
      return r.slot_zone_code === r.route_day_zone;
    });

    // Option 4 (adjacent-day PM strict): same as opt3 but slots 8→7
    const opt4Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone === "X") return false;
      if (!adjDayZonesForHome.includes(r.route_day_zone)) return false;
      if (!FLEX_PM.has(r.slot_index)) return false;
      // Clean adjacent-day constraint:
      return r.slot_zone_code === r.route_day_zone;
    });

    // Option 5 (Wed X): nearest Wednesday X, any slot, priority 1..8
    const opt5Pool = offerCandidates.filter((r) => r.route_day_zone === "X" && r.slot_zone_code === "X");

    // Pick each independently (earliest date, then priority order)
    const r1 = pickByDateAndSlotPriority(opt1Pool, PRI_OPT1_AM);
    const o1 = takeUnique(r1, "opt1_exact_am", "exact_am");

    const r2 = pickByDateAndSlotPriority(opt2Pool, PRI_OPT2_PM);
    const o2 = takeUnique(r2, "opt2_exact_pm", "exact_pm");

    const r3 = pickByDateAndSlotPriority(opt3Pool, PRI_OPT3_ADJ_AM);
    const o3 = takeUnique(r3, "opt3_adjacent_am", "adjacent_am");

    const r4 = pickByDateAndSlotPriority(opt4Pool, PRI_OPT4_ADJ_PM);
    const o4 = takeUnique(r4, "opt4_adjacent_pm", "adjacent_pm");

    const r5 = pickByDateAndSlotPriority(opt5Pool, PRI_WED);
    const o5 = takeUnique(r5, "opt5_wed", "wed");

    // Backfill (still respecting each option's pool intent, but never duplicating a slot)
    // If an option couldn't find anything (pool empty), crawl forward within that same pool again excluding picked.
    const pickWithExclusions = (poolRows, slotPriority, offer_role, bucket) => {
      const filtered = poolRows.filter((r) => !picked.has(slotKey(r)));
      const r = pickByDateAndSlotPriority(filtered, slotPriority);
      return takeUnique(r, offer_role, bucket);
    };

    let options = [o1, o2, o3, o4, o5].filter(Boolean);

    // Ensure we try to fill missing specific options in order (so roles stay meaningful)
    if (!o1) {
      const fill1 = pickWithExclusions(opt1Pool, PRI_OPT1_AM, "opt1_exact_am", "exact_am");
      if (fill1) options.push(fill1);
    }
    if (!o2) {
      const fill2 = pickWithExclusions(opt2Pool, PRI_OPT2_PM, "opt2_exact_pm", "exact_pm");
      if (fill2) options.push(fill2);
    }
    if (!o3) {
      const fill3 = pickWithExclusions(opt3Pool, PRI_OPT3_ADJ_AM, "opt3_adjacent_am", "adjacent_am");
      if (fill3) options.push(fill3);
    }
    if (!o4) {
      const fill4 = pickWithExclusions(opt4Pool, PRI_OPT4_ADJ_PM, "opt4_adjacent_pm", "adjacent_pm");
      if (fill4) options.push(fill4);
    }
    if (!o5) {
      const fill5 = pickWithExclusions(opt5Pool, PRI_WED, "opt5_wed", "wed");
      if (fill5) options.push(fill5);
    }

    // If we still have fewer than 5, fill with “best remaining” in a safe order:
    // prefer exact pools first, then adjacent pools, then wed.
    const fillAny = () => {
      return (
        pickWithExclusions(opt1Pool, PRI_OPT1_AM, "opt1_exact_am_fill", "exact_am") ||
        pickWithExclusions(opt2Pool, PRI_OPT2_PM, "opt2_exact_pm_fill", "exact_pm") ||
        pickWithExclusions(opt3Pool, PRI_OPT3_ADJ_AM, "opt3_adjacent_am_fill", "adjacent_am") ||
        pickWithExclusions(opt4Pool, PRI_OPT4_ADJ_PM, "opt4_adjacent_pm_fill", "adjacent_pm") ||
        pickWithExclusions(opt5Pool, PRI_WED, "opt5_wed_fill", "wed")
      );
    };

    while (options.length < 5) {
      const add = fillAny();
      if (!add) break;
      options.push(add);
    }

    // Keep Wed last if present
    const xs = options.filter((r) => r.route_day_zone === "X");
    const nonX = options.filter((r) => r.route_day_zone !== "X");
    if (xs.length) options = [...nonX, ...xs].slice(0, 5);
    else options = options.slice(0, 5);

    const toPublic = (r) => {
      const base = {
        service_date: r.service_date,
        slot_index: r.slot_index,
        zone_code: r.slot_zone_code, // legacy field used by UI / downstream
        daypart: r.daypart
          ? String(r.daypart).toLowerCase()
          : isMorning(r)
          ? "morning"
          : "afternoon",
        window_label: r.window_label ?? null,
        start_time: r.start_time,
        end_time: r.end_time,
      };

      if (!debug) return base;

      return {
        ...base,
        offer_role: r.offer_role || null,
        home_location_code,
        route_day_zone: r.route_day_zone,
        slot_zone_code: r.slot_zone_code,
        slot_key: `${r.service_date}|${r.slot_index}`,
        dow_utc: r.dow_utc,
        bucket: r.bucket || null,
        is_morning: isMorning(r),
        adj1_for_home: adjDayZonesForHome,
        day_zone_for_dow: r.route_day_zone,
        now_local_date: nowLocal.date,
        now_local_time: nowLocal.time,
        started_filter_trigger: !notStarted(r),
      };
    };

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
            note:
              "Debug mode includes offer_role + route_day_zone/slot_zone_code and confirms the new rules: no pair-lock, ≤2 zones per block, and 5 independent pools w/ priorities.",
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
