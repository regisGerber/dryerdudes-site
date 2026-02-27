// /api/get-available-slots.js  (FULL REPLACEMENT - CommonJS)
// Option B scheduler with:
// - slots table as source of available candidates
// - bookings table as final truth for already-booked (via bookings.slot_id)
// - 21-day horizon
// - filters out slots that fall on the assigned HOME zone tech's time off
//   using exact match: tech_time_off(tech_id, service_date, slot_index)
//
// Requires:
// - public.zone_tech_assignments(zone_code text primary key, tech_id uuid)
// - public.slots(id uuid, tech_id uuid, slot_date date, slot_index int, start_time time, daypart text, zone text, status text, ...)
// - public.bookings(slot_id uuid, status text, ...)
// - public.tech_time_off(tech_id uuid, service_date date, slot_index int, ...)

const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    Accept: "application/json",
  };
}

async function sbFetchJson(url, headers, opts = {}) {
  const resp = await fetchFn(url, { method: opts.method || "GET", headers });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data, text };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

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
      return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}:${map.second}` };
    };

    const nowLocal = getNowInTZ(SCHED_TZ);

    const addDaysISO = (iso, days) => {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
      return dt.toISOString().slice(0, 10);
    };

    const horizonISO = addDaysISO(todayISO, 21);

    const toUTCDate = (d) => {
      const [y, m, day] = String(d).split("-").map(Number);
      return new Date(Date.UTC(y, (m || 1) - 1, day || 1));
    };
    const dowUTC = (d) => toUTCDate(d).getUTCDay();

    const isMorning = (s) => {
      if (s.daypart) {
        const d = String(s.daypart).toLowerCase();
        if (["morning", "am", "a.m."].includes(d)) return true;
        if (["afternoon", "pm", "p.m."].includes(d)) return false;
      }
      return String(s.start_time || "").slice(0, 5) < "12:00";
    };

    const sortChrono = (a, b) =>
      String(a.service_date).localeCompare(String(b.service_date)) ||
      String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
      Number(a.slot_index) - Number(b.slot_index);

    const slotKey = (s) => `${String(s.service_date)}|${Number(s.slot_index)}|${String(s.route_day_zone || "")}`;

    /* -------------------- Zone rules -------------------- */
    // Dispatch-day mapping: Mon=B, Tue=D, Wed=X, Thu=A, Fri=C
    const dayZoneForDow = { 1: "B", 2: "D", 3: "X", 4: "A", 5: "C" };
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };

    const CORE = new Set([1, 2, 5, 6]);
    const FLEX_AM = new Set([3, 4]);
    const FLEX_PM = new Set([7, 8]);
    const AM_BLOCK = new Set([1, 2, 3, 4]);
    const PM_BLOCK = new Set([5, 6, 7, 8]);

    const PRI_OPT1_AM = [1, 2, 3, 4];
    const PRI_OPT2_PM = [5, 6, 7, 8];
    const PRI_OPT3_ADJ_AM = [4, 3];
    const PRI_OPT4_ADJ_PM = [8, 7];
    const PRI_WED = [1, 2, 3, 4, 5, 6, 7, 8];

    /* -------------------- Look up HOME zone's assigned tech -------------------- */
    const ztaUrl =
      `${SUPABASE_URL}/rest/v1/zone_tech_assignments` +
      `?zone_code=eq.${encodeURIComponent(home_location_code)}` +
      `&select=tech_id&limit=1`;

    const ztaResp = await sbFetchJson(ztaUrl, sbHeaders(SERVICE_ROLE));
    if (!ztaResp.ok) {
      return res.status(500).json({
        error: "Supabase zone_tech_assignments fetch failed",
        status: ztaResp.status,
        body: ztaResp.text?.slice?.(0, 800),
      });
    }

    const homeTechId = Array.isArray(ztaResp.data) ? (ztaResp.data[0]?.tech_id ? String(ztaResp.data[0].tech_id) : null) : null;

    if (!homeTechId) {
      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType,
        primary: [],
        more: { options: [], show_no_one_home_cta: appointmentType !== "no_one_home" },
        meta: debug ? { debug: true, nowLocal, todayISO, horizonISO, note: "No tech assigned for this zone." } : undefined,
      });
    }

    /* -------------------- Fetch tech time off (exact match) -------------------- */
    // tech_time_off: (tech_id, service_date, slot_index)
    const offUrl =
      `${SUPABASE_URL}/rest/v1/tech_time_off` +
      `?tech_id=eq.${encodeURIComponent(homeTechId)}` +
      `&service_date=gte.${encodeURIComponent(todayISO)}` +
      `&service_date=lte.${encodeURIComponent(horizonISO)}` +
      `&select=service_date,slot_index`;

    const offResp = await sbFetchJson(offUrl, sbHeaders(SERVICE_ROLE));
    if (!offResp.ok) {
      return res.status(500).json({
        error: "Supabase tech_time_off fetch failed",
        status: offResp.status,
        body: offResp.text?.slice?.(0, 800),
      });
    }

    const offSet = new Set();
    for (const o of Array.isArray(offResp.data) ? offResp.data : []) {
      const d = String(o?.service_date || "");
      const i = Number(o?.slot_index);
      if (d && Number.isFinite(i)) offSet.add(`${d}|${i}`);
    }
    const isSlotOffForHomeTech = (service_date, slot_index) => offSet.has(`${service_date}|${Number(slot_index)}`);

    /* -------------------- Fetch zone assignments (for zone inference fallback) -------------------- */
    const ztaAllUrl =
      `${SUPABASE_URL}/rest/v1/zone_tech_assignments` +
      `?select=zone_code,tech_id`;

    const ztaAllResp = await sbFetchJson(ztaAllUrl, sbHeaders(SERVICE_ROLE));
    if (!ztaAllResp.ok) {
      return res.status(500).json({
        error: "Supabase zone_tech_assignments (all) fetch failed",
        status: ztaAllResp.status,
        body: ztaAllResp.text?.slice?.(0, 800),
      });
    }

    const inferredZoneByTechId = new Map();
    for (const row of Array.isArray(ztaAllResp.data) ? ztaAllResp.data : []) {
      const techId = row?.tech_id ? String(row.tech_id) : "";
      const zoneCode = String(row?.zone_code || "").trim().toUpperCase();
      if (!techId || !["A", "B", "C", "D", "X"].includes(zoneCode)) continue;
      if (!inferredZoneByTechId.has(techId)) inferredZoneByTechId.set(techId, zoneCode);
    }

    /* -------------------- Fetch slots (source pool) -------------------- */
    // Pull all zones X,A,B,C,D because your routing rules reference them
    const zonesToFetch = "X,A,B,C,D";

    // NOTE: we do NOT filter by tech_id here because you purposely offer adjacent-zone options.
    // verify-offer will resolve to the correct tech for the CUSTOMER'S zone at checkout time.
    // Include null zone rows and infer zone from zone_tech_assignments by tech_id.
    const slotZoneOrClause = `(zone.in.(${zonesToFetch}),zone.is.null)`;
    const slotsUrl =
      `${SUPABASE_URL}/rest/v1/slots` +
      `?select=id,tech_id,slot_date,slot_index,start_time,daypart,zone,status` +
      `&slot_date=gte.${encodeURIComponent(todayISO)}` +
      `&slot_date=lte.${encodeURIComponent(horizonISO)}` +
      `&or=${encodeURIComponent(slotZoneOrClause)}` +
      `&order=slot_date.asc,start_time.asc,slot_index.asc`;

    const slotsResp = await sbFetchJson(slotsUrl, sbHeaders(SERVICE_ROLE));
    if (!slotsResp.ok) {
      return res.status(500).json({
        error: "Supabase slots fetch failed",
        status: slotsResp.status,
        body: slotsResp.text?.slice?.(0, 800),
      });
    }

    const slotRows = Array.isArray(slotsResp.data) ? slotsResp.data : [];
    if (!slotRows.length) {
      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType,
        primary: [],
        more: { options: [], show_no_one_home_cta: appointmentType !== "no_one_home" },
        meta: debug ? { debug: true, nowLocal, todayISO, horizonISO, fetched_rows: 0 } : undefined,
      });
    }

    /* -------------------- Fetch bookings for same horizon (truth via slot_id) -------------------- */
    const bookingsUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?select=slot_id,status,zone_code,window_start` +
      `&window_start=gte.${encodeURIComponent(`${todayISO}T00:00:00Z`)}` +
      `&window_start=lt.${encodeURIComponent(`${addDaysISO(horizonISO, 1)}T00:00:00Z`)}`;

    const bookingsResp = await sbFetchJson(bookingsUrl, sbHeaders(SERVICE_ROLE));
    if (!bookingsResp.ok) {
      return res.status(500).json({
        error: "Supabase bookings fetch failed",
        status: bookingsResp.status,
        body: bookingsResp.text?.slice?.(0, 800),
      });
    }

    const BOOKED_STATUSES = new Set(["scheduled", "en_route", "on_site", "completed"]);
    const bookedSlotIdSet = new Set();

    // also used for the "≤2 zones per AM/PM block" rule
    const bookedZonesByDate = new Map();
    const ensureDate = (d) => {
      if (!bookedZonesByDate.has(d)) bookedZonesByDate.set(d, { am: new Set(), pm: new Set() });
      return bookedZonesByDate.get(d);
    };

    for (const b of Array.isArray(bookingsResp.data) ? bookingsResp.data : []) {
      const st = String(b?.status || "").toLowerCase();
      if (!BOOKED_STATUSES.has(st)) continue;

      if (b?.slot_id) bookedSlotIdSet.add(String(b.slot_id));

      // For 2-zone rule, rely on bookings window_start + zone_code.
      // We convert window_start to scheduler-local date to group.
      const z = String(b?.zone_code || "").toUpperCase();
      const ws = b?.window_start ? new Date(b.window_start) : null;
      if (!z || !ws || isNaN(ws.getTime())) continue;

      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: SCHED_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(ws);
      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
      const localDate = `${map.year}-${map.month}-${map.day}`;
      const localTime = `${map.hour}:${map.minute}:${map.second}`;

      // infer block based on time vs noon, since bookings has window_start
      const entry = ensureDate(localDate);
      if (localTime < "12:00:00") entry.am.add(z);
      else entry.pm.add(z);
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

    /* -------------------- Normalize / enrich slot rows -------------------- */
    const normalized = slotRows
      .map((r) => {
        const service_date = String(r.slot_date || "");
        const slot_index = Number(r.slot_index);
        const inferredZone = inferredZoneByTechId.get(String(r.tech_id || "")) || "";
        const slot_zone_code = String(r.zone || inferredZone || "").toUpperCase();
        const dOw = service_date ? dowUTC(service_date) : null;
        const route_day_zone = dOw != null ? dayZoneForDow[dOw] : null;

        const start_time = r.start_time ?? null;

        const slotId = r?.id ? String(r.id) : null;

        // booked if slot.status isn't open OR bookings says it's booked
        const status = String(r.status || "").toLowerCase();
        const is_booked = (status && status !== "open") || (slotId ? bookedSlotIdSet.has(slotId) : false);

        return {
          slot_id: slotId,               // internal (not returned)
          service_date,
          slot_index,
          slot_zone_code,
          zone_code: slot_zone_code,
          daypart: r.daypart ?? null,
          window_label: null,            // slots table doesn't have it
          start_time,
          end_time: null,                // slots table doesn't have it
          is_booked,
          dow_utc: dOw,
          route_day_zone: route_day_zone ? String(route_day_zone).toUpperCase() : null,
        };
      })
      .filter((r) => r.service_date && Number.isFinite(r.slot_index) && r.route_day_zone && r.slot_zone_code)
      .sort(sortChrono);

    /* -------------------- Started-slot filter -------------------- */
    const notStarted = (r) => {
      const d = r.service_date;
      const st = String(r.start_time || "").slice(0, 8);
      if (d === nowLocal.date && st && st <= nowLocal.time) return false;
      return true;
    };

    /* -------------------- Base eligibility -------------------- */
    const isOfferEligible = (r) => {
      if (r.is_booked) return false;
      if (!notStarted(r)) return false;

      const dayZone = r.route_day_zone;
      if (!dayZone) return false;

      if (dayZone === "X") return r.slot_zone_code === "X";
      if (r.slot_zone_code === "X") return false;

      if (CORE.has(r.slot_index)) {
        if (r.slot_zone_code !== dayZone) return false;
        return passesTwoZoneRule(r);
      }

      if (FLEX_AM.has(r.slot_index) || FLEX_PM.has(r.slot_index)) {
        const allowedZ = new Set([dayZone, ...(adj1[dayZone] || [])]);
        if (!allowedZ.has(r.slot_zone_code)) return false;
        return passesTwoZoneRule(r);
      }

      return false;
    };

    let offerCandidates = normalized.filter(isOfferEligible).sort(sortChrono);

    /* -------------------- Filter by HOME tech time off (exact match) -------------------- */
    offerCandidates = offerCandidates.filter((r) => !isSlotOffForHomeTech(r.service_date, r.slot_index));

    if (offerCandidates.length === 0) {
      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType,
        primary: [],
        more: { options: [], show_no_one_home_cta: appointmentType !== "no_one_home" },
        meta: debug
          ? {
              debug: true,
              nowLocal,
              todayISO,
              horizonISO,
              fetched_rows: slotRows.length,
              candidates: 0,
              homeTechId,
              timeoff_rows: offSet.size,
              booked_slot_ids: bookedSlotIdSet.size,
              note: "All candidates removed by time-off filtering.",
            }
          : undefined,
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

    const toPublic = (r) => ({
      service_date: r.service_date,
      slot_index: r.slot_index,
      zone_code: r.slot_zone_code,
      daypart: r.daypart ? String(r.daypart).toLowerCase() : isMorning(r) ? "morning" : "afternoon",
      window_label: r.window_label ?? null,
      start_time: r.start_time,
      end_time: r.end_time,
    });

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

      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType: "parts",
        primary: out.map(toPublic),
        more: { options: [], show_no_one_home_cta: true },
        meta: {
          nextCursor,
          ...(debug
            ? {
                debug: true,
                nowLocal,
                todayISO,
                horizonISO,
                fetched_rows: slotRows.length,
                candidates: offerCandidates.length,
                homeTechId,
                timeoff_rows: offSet.size,
                booked_slot_ids: bookedSlotIdSet.size,
              }
            : {}),
        },
      });
    }

    /* =====================================================
       STANDARD / NO-ONE-HOME  (Option B)
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

    const adjDayZonesForHome = adj1[home_location_code] || [];

    const opt1Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone !== home_location_code) return false;
      if (!AM_BLOCK.has(r.slot_index)) return false;
      return r.slot_zone_code === home_location_code;
    });

    const opt2Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone !== home_location_code) return false;
      if (!PM_BLOCK.has(r.slot_index)) return false;
      return r.slot_zone_code === home_location_code;
    });

    const opt3Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone === "X") return false;
      if (!adjDayZonesForHome.includes(r.route_day_zone)) return false;
      if (!FLEX_AM.has(r.slot_index)) return false;
      return r.slot_zone_code === r.route_day_zone;
    });

    const opt4Pool = offerCandidates.filter((r) => {
      if (r.route_day_zone === "X") return false;
      if (!adjDayZonesForHome.includes(r.route_day_zone)) return false;
      if (!FLEX_PM.has(r.slot_index)) return false;
      return r.slot_zone_code === r.route_day_zone;
    });

    const opt5Pool = offerCandidates.filter((r) => r.route_day_zone === "X" && r.slot_zone_code === "X");

    const picked = new Set();
    const takeUnique = (r) => {
      if (!r) return null;
      const k = slotKey(r);
      if (picked.has(k)) return null;
      picked.add(k);
      return r;
    };

    const o1 = takeUnique(pickByDateAndSlotPriority(opt1Pool, PRI_OPT1_AM, picked));
    const o2 = takeUnique(pickByDateAndSlotPriority(opt2Pool, PRI_OPT2_PM, picked));
    const o3 = takeUnique(pickByDateAndSlotPriority(opt3Pool, PRI_OPT3_ADJ_AM, picked));
    const o4 = takeUnique(pickByDateAndSlotPriority(opt4Pool, PRI_OPT4_ADJ_PM, picked));
    const o5 = takeUnique(pickByDateAndSlotPriority(opt5Pool, PRI_WED, picked));

    let options = [o1, o2, o3, o4, o5].filter(Boolean);

    const xs = options.filter((r) => r.route_day_zone === "X");
    const nonX = options.filter((r) => r.route_day_zone !== "X");
    if (xs.length) options = [...nonX, ...xs];

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
            horizonISO,
            fetched_rows: slotRows.length,
            candidates: offerCandidates.length,
            homeTechId,
            timeoff_rows: offSet.size,
            booked_slot_ids: bookedSlotIdSet.size,
            note: "Option B active. slots is pool. bookings(slot_id) is truth. horizon 21 days. Time-off uses exact (service_date, slot_index).",
          }
        : undefined,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 1600) : null,
    });
  }
};
