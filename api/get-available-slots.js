// /api/get-available-slots.js
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

    /* -------------------- Zone rules -------------------- */
    // Dispatch-day mapping:
    // Mon=B, Tue=D, Wed=X, Thu=A, Fri=C
    const mainDow = { A: 4, B: 1, C: 5, D: 2, X: WED };
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };
    const adj2 = { A: ["C"], B: ["D"], C: ["A"], D: ["B"] }; // fetched only; NOT allowed except via slot-pattern (won't pass)
    const adjPref = { A: ["B"], B: ["A", "C"], C: ["D", "B"], D: ["C"] };

    /* -------------------- Fetch -------------------- */
    const zonesToFetch = Array.from(
      new Set(["X", zone, ...(adj1[zone] || []), ...(adj2[zone] || [])])
    ).join(",");

    const fetchUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?select=service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,is_booked` +
      `&is_booked=eq.false` +
      `&service_date=gte.${todayISO}` +
      `&zone_code=in.(${zonesToFetch})` +
      `&order=service_date.asc,start_time.asc,slot_index.asc` +
      `&limit=1000`;

    const resp = await fetch(fetchUrl, {
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

    /* -------------------- Enforce weekday + slot_index discipline -------------------- */
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
       Rules:
       - Show Wed X AM + X PM first ONLY on the first page (no cursor)
       - Then fill with next-available chronological slots
       - Eligible zones for NON-Wed parts: customer zone + adj1 only
       - Tier-2 is NOT allowed for parts (tier-2 reserved for Wed chaining only)
       ===================================================== */
    if (type === "parts") {
      const picked = new Set();
      const out = [];

      // Eligible zones for parts: ONLY customer zone + 1-step adjacent
      const eligibleZone = (z) => {
        if (!z) return false;
        if (z === zone) return true;
        return (adj1[zone] || []).includes(z);
      };

      // Wednesday pool (X only). Apply cursor too (so pagination doesn't repeat Wed forever).
      const wedPool = allowed
        .filter((s) => String(s.zone_code || "").toUpperCase() === "X" && afterCursor(s))
        .sort((a, b) =>
          String(a.service_date).localeCompare(String(b.service_date)) ||
          String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
          Number(a.slot_index) - Number(b.slot_index)
        );

      // Strict chronological non-wed pool
      const chronoPool = allowed.filter((s) => {
        const zc = String(s.zone_code || "").toUpperCase();
        return zc !== "X" && eligibleZone(zc) && afterCursor(s);
      });

      const take = (s) => {
        if (!s) return;
        const k = slotKey(s);
        if (picked.has(k)) return;
        picked.add(k);
        out.push(s);
      };

      const firstPage = !cursorRaw;

      // Step 0 pressure: lead with Wed AM + Wed PM if available (only on first page)
      if (firstPage) {
        take(wedPool.find((s) => isMorning(s)));
        take(wedPool.find((s) => !isMorning(s)));
      }

      // Fill to 3 with next available chronological slots
      for (const s of chronoPool) {
        if (out.length >= 3) break;
        take(s);
      }

      const last = out[out.length - 1];
      const nextCursor = last ? `${last.service_date}|${Number(last.slot_index)}` : cursorRaw;

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
       5: Wednesday X (as the last option)
       ===================================================== */
    const picked = new Set();
    const dayCount = new Map();
    const canUseDay = (d) => (dayCount.get(d) || 0) < 2;

    const take = (s) => {
      if (!s) return null;
      const k = slotKey(s);
      if (picked.has(k)) return null;
      if (!canUseDay(s.service_date)) return null;
      picked.add(k);
      dayCount.set(s.service_date, (dayCount.get(s.service_date) || 0) + 1);
      return s;
    };

    const mainDay = allowed.filter(
      (s) => String(s.zone_code || "").toUpperCase() === zone && dow(s.service_date) === mainDow[zone]
    );

    const wed = allowed.filter((s) => String(s.zone_code || "").toUpperCase() === "X");

    const adjPool = (z) =>
      allowed.filter((s) => String(s.zone_code || "").toUpperCase() === z && dow(s.service_date) !== WED);

    const o1 = take(mainDay.find((s) => isMorning(s)));
    const o2 = take(mainDay.find((s) => !isMorning(s)));

    let o3 = null;
    for (const z of adjPref[zone] || []) {
      o3 = take(adjPool(z).find((s) => isMorning(s)));
      if (o3) break;
      o3 = take(adjPool(z).find((s) => !isMorning(s)));
      if (o3) break;
    }

    let o4 = null;
    if (o3) {
      for (const z of adjPref[zone] || []) {
        o4 = take(
          adjPool(z).find(
            (s) => !isMorning(s) && String(s.service_date) === String(o3.service_date)
          )
        );
        if (o4) break;
      }
      if (!o4) {
        for (const z of adjPref[zone] || []) {
          o4 = take(adjPool(z).find((s) => !isMorning(s)));
          if (o4) break;
        }
      }
    }

    const o5 = take(wed.find((s) => afterCursor(s) || true)); // standard ignores cursor; kept safe

    const all = [o1, o2, o3, o4, o5].filter(Boolean);

    return res.status(200).json({
      zone,
      appointmentType: type,
      primary: all.slice(0, 3).map(toPublic),
      more: {
        options:
          type === "no_one_home" ? [] : all.slice(3).map(toPublic),
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
```0
