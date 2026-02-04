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

    /* -------------------- Date helpers -------------------- */
    const todayISO = new Date().toISOString().slice(0, 10);
    const WED = 3;

    const toUTCDate = (d) => {
      const [y, m, day] = String(d).split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, day));
    };
    const dow = (d) => toUTCDate(d).getUTCDay(); // 0=Sun..6=Sat

    const isMorning = (s) => {
      if (s.daypart) return String(s.daypart).toLowerCase() === "morning";
      return String(s.start_time || "").slice(0, 5) < "12:00";
    };

    const slotKey = (s) => `${s.service_date}|${Number(s.slot_index)}`;

    const toPublic = (s) => ({
      service_date: s.service_date,
      slot_index: Number(s.slot_index),
      zone_code: String(s.zone_code || "").toUpperCase(),
      daypart: s.daypart ? String(s.daypart).toLowerCase() : (isMorning(s) ? "morning" : "afternoon"),
      window_label: s.window_label ?? null,
      start_time: s.start_time,
      end_time: s.end_time,
    });

    const sortChrono = (a, b) =>
      String(a.service_date).localeCompare(String(b.service_date)) ||
      String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
      (Number(a.slot_index) - Number(b.slot_index));

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
    // Dispatch-day mapping:
    // Mon=B, Tue=D, Wed=X, Thu=A, Fri=C
    const mainDow = { A: 4, B: 1, C: 5, D: 2, X: WED };
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };
    const adjPref = { A: ["B"], B: ["A", "C"], C: ["D", "B"], D: ["C"] };

    /* -------------------- Fetch -------------------- */
    const zonesToFetch = Array.from(new Set(["X", "A", "B", "C", "D"])).join(",");

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
    // 3-4 can be the day's zone OR "left" adjacent
    // 7-8 can be the day's zone OR "right" adjacent
    const CORE_SLOTS = new Set([1, 2, 5, 6]);
    const LEFT_SLOTS = new Set([3, 4]);
    const RIGHT_SLOTS = new Set([7, 8]);

    // “Left” and “Right” adjacency around the line A-B-C-D
    const leftAdj = { A: "B", B: "A", C: "B", D: "C" };
    const rightAdj = { A: null, B: "C", C: "D", D: null };

    const allowed = slots.filter((s) => {
      const d = String(s.service_date || "");
      if (!d) return false;

      const idx = Number(s.slot_index);
      if (!Number.isFinite(idx)) return false;

      const dowNum = dow(d);
      const dayZone = dayZoneForDow[dowNum];
      if (!dayZone) return false; // only Mon-Fri

      const z = String(s.zone_code || "").toUpperCase();

      // Wednesday: only X
      if (dayZone === "X") {
        return z === "X" && dowNum === WED;
      }

      // Non-Wed: never X
      if (z === "X") return false;

      // Enforce the slot_index pattern by day
      if (CORE_SLOTS.has(idx)) return z === dayZone;

      if (LEFT_SLOTS.has(idx)) {
        const la = leftAdj[dayZone];
        return z === dayZone || (la && z === la);
      }

      if (RIGHT_SLOTS.has(idx)) {
        const ra = rightAdj[dayZone];
        return z === dayZone || (ra && z === ra);
      }

      return false;
    });

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
       PARTS FLOW (progressive, nudged, infinite)
       - first page: Wed X AM + X PM (if available)
       - then next-available chronological slots
       - non-Wed parts eligible: customer zone + adj1 ONLY (no tier2)
       ===================================================== */
    if (type === "parts") {
      const picked = new Set();
      const out = [];

      const eligibleZone = (z) => {
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
       3-4: adjacent zone (preference order), AM then PM same day if possible
       5: Wednesday X (last)
       ===================================================== */
    const pickedStd = new Set();
    const dayCount = new Map();
    const canUseDay = (d) => (dayCount.get(d) || 0) < 2;

    const takeStd = (s) => {
      if (!s) return null;
      const k = slotKey(s);
      if (pickedStd.has(k)) return null;
      if (!canUseDay(String(s.service_date))) return null;
      pickedStd.add(k);
      dayCount.set(String(s.service_date), (dayCount.get(String(s.service_date)) || 0) + 1);
      return s;
    };

    const mainDay = allowed
      .filter((s) => String(s.zone_code || "").toUpperCase() === zone && dow(s.service_date) === mainDow[zone])
      .sort(sortChrono);

    const wed = allowed
      .filter((s) => String(s.zone_code || "").toUpperCase() === "X")
      .sort(sortChrono);

    const adjPool = (z) =>
      allowed
        .filter((s) => String(s.zone_code || "").toUpperCase() === z && dow(s.service_date) !== WED)
        .sort(sortChrono);

    const o1 = takeStd(mainDay.find((s) => isMorning(s)));
    const o2 = takeStd(mainDay.find((s) => !isMorning(s)));

    let o3 = null;
    for (const z of adjPref[zone] || []) {
      o3 = takeStd(adjPool(z).find((s) => isMorning(s))) || takeStd(adjPool(z).find((s) => !isMorning(s)));
      if (o3) break;
    }

    let o4 = null;
    if (o3) {
      for (const z of adjPref[zone] || []) {
        o4 = takeStd(
          adjPool(z).find((s) => !isMorning(s) && String(s.service_date) === String(o3.service_date))
        );
        if (o4) break;
      }
      if (!o4) {
        for (const z of adjPref[zone] || []) {
          o4 = takeStd(adjPool(z).find((s) => !isMorning(s)));
          if (o4) break;
        }
      }
    }

    const o5 = takeStd(wed[0] || null);

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
      // uncomment if you want during debugging:
      // stack: err?.stack ? String(err.stack).slice(0, 500) : undefined,
    });
  }
};
