// /api/get-available-slots.js
// Option B scheduler with:
// - bookings table = source of truth for booked
// - 21-day horizon
// - filters out slots that fall on the assigned tech's time off for the HOME zone
//   - type='slot' => exact match only
//   - type in ('am','pm','all_day') => overlap blocks
//
// Requires:
// - public.zone_tech_assignments(zone_code text primary key, tech_id uuid references techs(id))
// - public.tech_time_off(tech_id uuid, start_ts timestamptz, end_ts timestamptz, type text, ...)

const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

module.exports = async (req, res) => {
  // Always return JSON
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
      return {
        date: `${map.year}-${map.month}-${map.day}`,
        time: `${map.hour}:${map.minute}:${map.second}`,
      };
    };

    const dtPartsInTZ = (d, tz) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
      return {
        date: `${map.year}-${map.month}-${map.day}`,
        time: `${map.hour}:${map.minute}:${map.second}`,
      };
    };

    const nowLocal = getNowInTZ(SCHED_TZ);

    const addDaysISO = (iso, days) => {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
      return dt.toISOString().slice(0, 10);
    };

    const horizonISO = addDaysISO(todayISO, 21);
    const horizonPlus1ISO = addDaysISO(horizonISO, 1);

    // Stable DOW from YYYY-MM-DD
    const toUTCDate = (d) => {
      const [y, m, day] = String(d).split("-").map(Number);
      return new Date(Date.UTC(y, (m || 1) - 1, day || 1));
    };
    const dowUTC = (d) => toUTCDate(d).getUTCDay();

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

    const slotKeyPublic = (service_date, start_time, zone_code) =>
      `${String(service_date)}|${String(start_time || "").slice(0, 8)}|${String(zone_code || "").toUpperCase()}`;

    const toMs = (isoString) => {
      const d = new Date(isoString);
      const ms = d.getTime();
      return Number.isFinite(ms) ? ms : null;
    };

    const overlapsMs = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

    // Convert a schedule_slot "service_date + HH:MM(:SS)" to a real ms timestamp in LA time.
    // We do this by building a Date for that wall-clock moment in LA using Intl and a safe trick:
    // - Start with a UTC Date, then format it as LA parts and adjust isn't straightforward without libs,
    // so instead we accept a simpler assumption:
    // - Your Feb dates are standard time (-08:00), so using "-08:00" is safe for now.
    // If you later cross DST, we should switch to a proper TZ library.
    const LA_OFFSET_FEB_SAFE = "-08:00";

    const makeLATimestamptz = (service_date, hhmmss) => {
      if (!service_date || !hhmmss) return null;
      const t = String(hhmmss).trim().slice(0, 8);
      const m = t.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
      if (!m) return null;
      const hh = m[1];
      const mm = m[2];
      const ss = m[3] ?? "00";
      return `${service_date}T${hh}:${mm}:${ss}${LA_OFFSET_FEB_SAFE}`;
    };

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

    const ztaResp = await fetchFn(ztaUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
      },
    });

    const ztaText = await ztaResp.text();
    let ztaRows = [];
    try { ztaRows = ztaText ? JSON.parse(ztaText) : []; } catch { ztaRows = []; }

    if (!ztaResp.ok) {
      return res.status(500).json({
        error: "Supabase zone_tech_assignments fetch failed",
        status: ztaResp.status,
        body: ztaText.slice(0, 800),
      });
    }

    const homeTechId =
      Array.isArray(ztaRows) && ztaRows[0]?.tech_id ? String(ztaRows[0].tech_id) : null;

    // Your rule: nothing should book without a tech assignment for the zone
    if (!homeTechId) {
      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType,
        primary: [],
        more: { options: [], show_no_one_home_cta: appointmentType !== "no_one_home" },
        meta: debug
          ? { debug: true, nowLocal, todayISO, horizonISO, note: "No tech assigned for this zone." }
          : undefined,
      });
    }

    /* -------------------- Fetch tech time off for horizon (SAFE UTC filters) -------------------- */
    const offUrl =
      `${SUPABASE_URL}/rest/v1/tech_time_off` +
      `?tech_id=eq.${encodeURIComponent(homeTechId)}` +
      `&end_ts=gte.${encodeURIComponent(`${todayISO}T00:00:00Z`)}` +
      `&start_ts=lt.${encodeURIComponent(`${horizonPlus1ISO}T00:00:00Z`)}` +
      `&select=start_ts,end_ts,type`;

    const offResp = await fetchFn(offUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
      },
    });

    const offText = await offResp.text();
    let offRows = [];
    try { offRows = offText ? JSON.parse(offText) : []; } catch { offRows = []; }

    if (!offResp.ok) {
      return res.status(500).json({
        error: "Supabase tech_time_off fetch failed",
        status: offResp.status,
        body: offText.slice(0, 800),
      });
    }

    const isSlotOffForHomeTech = (service_date, start_time, end_time) => {
      const sIso = makeLATimestamptz(service_date, start_time);
      const eIso = makeLATimestamptz(service_date, end_time);

      const sMs = sIso ? toMs(sIso) : null;
      const eMs = eIso ? toMs(eIso) : null;
      if (sMs == null || eMs == null) return false;

      return (Array.isArray(offRows) ? offRows : []).some((o) => {
        const os = o?.start_ts ? toMs(o.start_ts) : null;
        const oe = o?.end_ts ? toMs(o.end_ts) : null;
        if (os == null || oe == null) return false;

        const t = String(o?.type || "").toLowerCase();

        // slot blocks only exact match
        if (t === "slot") return os === sMs && oe === eMs;

        // am/pm/all_day blocks overlap
        return overlapsMs(sMs, eMs, os, oe);
      });
    };

    /* -------------------- Fetch schedule_slots (paginated) -------------------- */
    const zonesToFetch = "X,A,B,C,D";
    const baseUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&service_date=gte.${todayISO}` +
      `&service_date=lte.${horizonISO}` +
      `&zone_code=in.(${zonesToFetch})` +
      `&order=service_date.asc,start_time.asc,slot_index.asc`;

    const PAGE_SIZE = 1000;
    const MAX_PAGES = 25;
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
          error: "Bad Supabase response (schedule_slots non-JSON)",
          status: resp.status,
          body: rawText.slice(0, 800),
        });
      }

      if (!resp.ok) {
        return res.status(500).json({
          error: "Supabase schedule_slots fetch failed",
          status: resp.status,
          details: rows,
        });
      }

      if (!Array.isArray(rows)) {
        return res.status(500).json({ error: "Bad Supabase response (schedule_slots not array)" });
      }

      allRows.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }

    if (!allRows.length) {
      return res.status(200).json({
        zone: home_location_code,
        home_location_code,
        appointmentType,
        primary: [],
        more: { options: [], show_no_one_home_cta: appointmentType !== "no_one_home" },
        meta: debug ? { debug: true, nowLocal, todayISO, horizonISO, fetched_rows: 0 } : undefined,
      });
    }

    /* -------------------- Fetch bookings (truth) for same horizon -------------------- */
    const bookingsUrl =
      `${SUPABASE_URL}/rest/v1/bookings` +
      `?select=window_start,zone_code,status` +
      `&window_start=gte.${todayISO}T00:00:00Z` +
      `&window_start=lt.${horizonPlus1ISO}T00:00:00Z`;

    const bookingsResp = await fetchFn(bookingsUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
      },
    });

    const bookingsText = await bookingsResp.text();
    let bookingsRows = [];
    try { bookingsRows = bookingsText ? JSON.parse(bookingsText) : []; } catch { bookingsRows = []; }

    if (!bookingsResp.ok) {
      return res.status(500).json({
        error: "Supabase bookings fetch failed",
        status: bookingsResp.status,
        body: bookingsText.slice(0, 800),
      });
    }

    const BOOKED_STATUSES = new Set(["scheduled", "en_route", "on_site", "completed"]);
    const bookedSet = new Set();

    for (const b of Array.isArray(bookingsRows) ? bookingsRows : []) {
      const st = String(b?.status || "").toLowerCase();
      if (!BOOKED_STATUSES.has(st)) continue;

      const z = String(b?.zone_code || "").toUpperCase();
      if (!z) continue;

      const ws = b?.window_start ? new Date(b.window_start) : null;
      if (!ws || isNaN(ws.getTime())) continue;

      const local = dtPartsInTZ(ws, SCHED_TZ);
      bookedSet.add(slotKeyPublic(local.date, local.time, z));
    }

    /* -------------------- Normalize / enrich rows -------------------- */
    const normalized = allRows
      .map((r) => {
        const service_date = String(r.service_date || "");
        const slot_index = Number(r.slot_index);
        const slot_zone_code = String(r.zone_code || "").toUpperCase();
        const dOw = service_date ? dowUTC(service_date) : null;
        const route_day_zone = dOw != null ? dayZoneForDow[dOw] : null;

        const start_time = r.start_time ?? null;

        const is_booked = bookedSet.has(slotKeyPublic(service_date, start_time, slot_zone_code));

        return {
          service_date,
          slot_index,
          slot_zone_code,
          zone_code: slot_zone_code,
          daypart: r.daypart ?? null,
          window_label: r.window_label ?? null,
          start_time,
          end_time: r.end_time ?? null,
          is_booked,
          dow_utc: dOw,
          route_day_zone: route_day_zone ? String(route_day_zone).toUpperCase() : null,
        };
      })
      .filter((r) => r.service_date && Number.isFinite(r.slot_index) && r.route_day_zone)
      .sort(sortChrono);

    /* -------------------- Started-slot filter -------------------- */
    const notStarted = (r) => {
      const d = r.service_date;
      const st = String(r.start_time || "").slice(0, 8);
      if (d === nowLocal.date && st && st <= nowLocal.time) return false;
      return true;
    };

    /* -------------------- ≤2 route zones per AM/PM block rule -------------------- */
    const bookedZonesByDate = new Map();
    const ensureDate = (d) => {
      if (!bookedZonesByDate.has(d)) bookedZonesByDate.set(d, { am: new Set(), pm: new Set() });
      return bookedZonesByDate.get(d);
    };

    for (const r of normalized) {
      if (!r.is_booked) continue;
      if (r.route_day_zone === "X") continue;
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

    /* -------------------- Filter by HOME tech time off -------------------- */
    offerCandidates = offerCandidates.filter((r) => {
      return !isSlotOffForHomeTech(r.service_date, r.start_time, r.end_time);
    });

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
              fetched_rows: allRows.length,
              bookings_rows: Array.isArray(bookingsRows) ? bookingsRows.length : 0,
              booked_keys: bookedSet.size,
              homeTechId,
              off_rows: Array.isArray(offRows) ? offRows.length : 0,
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
        meta: {
          nextCursor,
          ...(debug
            ? {
                debug: true,
                nowLocal,
                todayISO,
                horizonISO,
                fetched_rows: allRows.length,
                bookings_rows: Array.isArray(bookingsRows) ? bookingsRows.length : 0,
                booked_keys: bookedSet.size,
                homeTechId,
                off_rows: Array.isArray(offRows) ? offRows.length : 0,
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

    const toPublic = (r) => ({
      service_date: r.service_date,
      slot_index: r.slot_index,
      zone_code: r.slot_zone_code,
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
            horizonISO,
            fetched_rows: allRows.length,
            bookings_rows: Array.isArray(bookingsRows) ? bookingsRows.length : 0,
            booked_keys: bookedSet.size,
            candidates: offerCandidates.length,
            homeTechId,
            off_rows: Array.isArray(offRows) ? offRows.length : 0,
            note:
              "Option B active. bookings is truth. horizon 21 days. Filter removes slots during HOME zone's assigned tech time off.",
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
