// /api/get-available-slots.js
module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    /* -------------------- Inputs -------------------- */
    const zone = String(req.query.zone || "").toUpperCase();
    const typeRaw = String(req.query.type || "standard").toLowerCase();
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

    const cursorRaw = req.query.cursor || null;

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
      const [y, m, day] = d.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, day));
    };
    const dow = (d) => toUTCDate(d).getUTCDay();

    const isMorning = (s) =>
      s.daypart
        ? s.daypart === "morning"
        : String(s.start_time).slice(0, 5) < "12:00";

    const slotKey = (s) => `${s.service_date}|${s.slot_index}`;

    /* -------------------- Zone rules -------------------- */
    const mainDow = { A: 4, B: 1, C: 5, D: 2, X: WED };
    const adj1 = { A: ["B"], B: ["A", "C"], C: ["B", "D"], D: ["C"] };
    const adj2 = { A: ["C"], B: ["D"], C: ["A"], D: ["B"] };
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
      `&order=service_date.asc,start_time.asc,slot_index.asc`;

    const resp = await fetch(fetchUrl, {
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
    });

    const slots = await resp.json();
    if (!Array.isArray(slots)) {
      return res.status(500).json({ error: "Bad Supabase response" });
    }

    /* -------------------- Enforce weekday discipline -------------------- */
    const allowed = slots.filter((s) => {
      const z = String(s.zone_code || "").toUpperCase();
      if (z === "X") return dow(s.service_date) === WED;
      return mainDow[z] === dow(s.service_date);
    });

    /* -------------------- Cursor logic (parts only) -------------------- */
    const parseCursor = (c) => {
      if (!c) return null;
      const [d, i] = c.split("|");
      return { d, i: Number(i) };
    };
    const cursor = parseCursor(cursorRaw);

    const afterCursor = (s) => {
      if (!cursor) return true;
      if (s.service_date > cursor.d) return true;
      if (s.service_date < cursor.d) return false;
      return s.slot_index > cursor.i;
    };

    /* =====================================================
       PARTS FLOW (progressive, nudged, infinite)
       ===================================================== */
    if (type === "parts") {
      const picked = new Set();
      const out = [];

      const eligibleZone = (z) =>
        z === zone ||
        (adj1[zone] || []).includes(z) ||
        (adj2[zone] || []).includes(z);

      const wedPool = allowed.filter((s) => s.zone_code === "X");
      const chronoPool = allowed.filter(
        (s) =>
          s.zone_code !== "X" &&
          eligibleZone(s.zone_code) &&
          afterCursor(s)
      );

      const take = (s) => {
        if (!s) return;
        const k = slotKey(s);
        if (picked.has(k)) return;
        picked.add(k);
        out.push(s);
      };

      // Step 0: Wednesday pressure
      take(wedPool.find(isMorning));
      take(wedPool.find((s) => !isMorning(s)));

      // Fill next chronological
      for (const s of chronoPool) {
        if (out.length >= 3) break;
        take(s);
      }

      const last = out[out.length - 1];
      const nextCursor = last
        ? `${last.service_date}|${last.slot_index}`
        : cursorRaw;

      return res.status(200).json({
        zone,
        appointmentType: "parts",
        primary: out.map((s) => ({
          service_date: s.service_date,
          slot_index: s.slot_index,
          zone_code: s.zone_code,
          daypart: s.daypart,
          start_time: s.start_time,
          end_time: s.end_time,
        })),
        more: { options: [], show_no_one_home_cta: true },
        meta: { nextCursor },
      });
    }

    /* =====================================================
       STANDARD / NO-ONE-HOME (5 structured)
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
      (s) => s.zone_code === zone && dow(s.service_date) === mainDow[zone]
    );
    const wed = allowed.filter((s) => s.zone_code === "X");

    const adjPool = (z) =>
      allowed.filter(
        (s) =>
          s.zone_code === z &&
          dow(s.service_date) !== WED
      );

    const o1 = take(mainDay.find(isMorning));
    const o2 = take(mainDay.find((s) => !isMorning(s)));

    let o3 = null;
    for (const z of adjPref[zone] || []) {
      o3 = take(adjPool(z).find(isMorning));
      if (o3) break;
    }

    let o4 = null;
    if (o3) {
      for (const z of adjPref[zone] || []) {
        o4 = take(
          adjPool(z).find(
            (s) =>
              !isMorning(s) &&
              s.service_date === o3.service_date
          )
        );
        if (o4) break;
      }
    }

    const o5 = take(wed[0]);

    const all = [o1, o2, o3, o4, o5].filter(Boolean);

    return res.status(200).json({
      zone,
      appointmentType: type,
      primary: all.slice(0, 3).map((s) => ({
        service_date: s.service_date,
        slot_index: s.slot_index,
        zone_code: s.zone_code,
        daypart: s.daypart,
        start_time: s.start_time,
        end_time: s.end_time,
      })),
      more: {
        options:
          type === "no_one_home"
            ? []
            : all.slice(3).map((s) => ({
                service_date: s.service_date,
                slot_index: s.slot_index,
                zone_code: s.zone_code,
                daypart: s.daypart,
                start_time: s.start_time,
                end_time: s.end_time,
              })),
        show_no_one_home_cta: type !== "no_one_home",
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err.message,
    });
  }
};
