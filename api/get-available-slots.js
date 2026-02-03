// /api/get-available-slots.js
// Read-only slot suggestion engine (no booking). Works with GET or POST.
//
// Env vars required (Vercel):
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY

const ZONES = ["A", "B", "C", "D"];

// Weekly zone-day mapping (0=Sun..6=Sat)
const ZONE_DAY = {
  A: 4, // Thu
  B: 1, // Mon
  C: 5, // Fri
  D: 2, // Tue
};

// Adjacent zones (north->south line)
const ADJ = {
  A: ["B"],
  B: ["A", "C"],
  C: ["B", "D"],
  D: ["C"],
};

// Your slot indices (1..8) and dayparts
const MORNING_SLOT_INDEXES = [1, 2, 3, 4]; // A-D
const AFTERNOON_SLOT_INDEXES = [5, 6, 7, 8]; // E-H

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}
function getDow(isoYYYYMMDD) {
  // treat as local date
  const [y, m, d] = isoYYYYMMDD.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

function normalizeType(t) {
  const v = (t || "standard").toString().toLowerCase();
  if (["standard", "normal"].includes(v)) return "standard";
  if (["parts", "parts_in", "parts-in"].includes(v)) return "parts_in";
  if (["no_one_home", "noonehome", "no-one-home", "no_one", "noone"].includes(v))
    return "no_one_home";
  return "standard";
}

// Determine if a row is booked across possible schemas
function rowIsBooked(row) {
  if (row == null) return true;

  // Common patterns
  if (typeof row.is_booked === "boolean") return row.is_booked;
  if (row.booked_at) return true;
  if (row.booking_id) return true;
  if (row.status && String(row.status).toLowerCase() === "booked") return true;

  return false;
}

// Build a display label
function slotLabel(row) {
  if (row.window_label) return row.window_label;
  const s = row.start_time ? String(row.start_time).slice(0, 5) : null;
  const e = row.end_time ? String(row.end_time).slice(0, 5) : null;
  if (s && e) return `${s}–${e}`;
  return `Slot ${row.slot_index}`;
}

// Gate Slot H: only offer if all other 7 slots that day are booked
function isSlotHAllowed(dateRows, row) {
  if (row.slot_index !== 8) return true;
  // must have rows for that date (any zones) to evaluate; if not, be conservative: disallow
  if (!dateRows || dateRows.length === 0) return false;

  // if any slot 1..7 is unbooked anywhere that day, we do NOT allow slot 8 suggestions
  for (const r of dateRows) {
    if (r.slot_index >= 1 && r.slot_index <= 7 && !rowIsBooked(r)) {
      return false;
    }
  }
  return true;
}

async function supabaseFetchSlots({ daysForward = 60 }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  }

  const from = isoDate(new Date());
  const to = isoDate(addDays(new Date(), daysForward));

  // Pull enough columns to work across schema versions
  const selectCols = [
    "service_date",
    "slot_index",
    "zone_code",
    "daypart",
    "window_label",
    "start_time",
    "end_time",
    "is_booked",
    "booked_at",
    "booking_id",
    "status",
  ].join(",");

  // limit to relevant range + zones
  const url =
    `${SUPABASE_URL}/rest/v1/schedule_slots` +
    `?select=${encodeURIComponent(selectCols)}` +
    `&service_date=gte.${from}` +
    `&service_date=lte.${to}` +
    `&zone_code=in.(${ZONES.join(",")})` +
    `&order=service_date.asc,slot_index.asc`;

  const resp = await fetch(url, {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Supabase fetch failed: ${resp.status} ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data : [];
}

function buildIndexes(rows) {
  const byDate = new Map(); // date -> rows[]
  const byDateZone = new Map(); // `${date}|${zone}` -> rows[]
  const byDateZoneDaypart = new Map(); // `${date}|${zone}|${daypart}` -> rows[]

  for (const r of rows) {
    const date = r.service_date;
    const zone = r.zone_code;
    const daypart = r.daypart;

    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);

    const kz = `${date}|${zone}`;
    if (!byDateZone.has(kz)) byDateZone.set(kz, []);
    byDateZone.get(kz).push(r);

    const kzd = `${date}|${zone}|${daypart}`;
    if (!byDateZoneDaypart.has(kzd)) byDateZoneDaypart.set(kzd, []);
    byDateZoneDaypart.get(kzd).push(r);
  }

  return { byDate, byDateZone, byDateZoneDaypart };
}

function pickBestSlotForDate({ date, zone, daypart, idx, indexes }) {
  const key = `${date}|${zone}|${daypart}`;
  const rows = indexes.byDateZoneDaypart.get(key) || [];
  const dateRows = indexes.byDate.get(date) || [];

  // Choose earliest slot_index within that daypart, excluding booked and excluding slot H unless allowed
  const allowedIndexes =
    daypart === "morning" ? MORNING_SLOT_INDEXES : AFTERNOON_SLOT_INDEXES;

  for (const si of allowedIndexes) {
    const row = rows.find((r) => Number(r.slot_index) === si);
    if (!row) continue;
    if (rowIsBooked(row)) continue;
    if (!isSlotHAllowed(dateRows, row)) continue;

    return {
      date,
      zone: row.zone_code,
      daypart: row.daypart,
      slot_index: Number(row.slot_index),
      label: slotLabel(row),
    };
  }

  return null;
}

function findNextZoneDaySlot({ zone, daypart, preferDateStart, rowsIndex }) {
  // search forward from preferDateStart up to 60 days
  const start = preferDateStart ? new Date(preferDateStart) : new Date();
  for (let i = 0; i <= 60; i++) {
    const d = addDays(start, i);
    const date = isoDate(d);
    const dow = d.getDay();

    if (dow !== ZONE_DAY[zone]) continue;

    const slot = pickBestSlotForDate({
      date,
      zone,
      daypart,
      indexes: rowsIndex,
    });

    if (slot) return slot;
  }
  return null;
}

function pickAdjacentDayPrimary({ customerZone, rowsIndex }) {
  const neighbors = ADJ[customerZone] || [];
  // Choose best neighbor by earliest available (prefer morning; if none, try afternoon)
  let best = null;

  for (const nz of neighbors) {
    const morning = findNextZoneDaySlot({
      zone: nz,
      daypart: "morning",
      rowsIndex,
    });
    const afternoon = findNextZoneDaySlot({
      zone: nz,
      daypart: "afternoon",
      rowsIndex,
    });

    const candidate = morning || afternoon;
    if (!candidate) continue;

    if (!best) best = candidate;
    else if (candidate.date < best.date) best = candidate;
    else if (candidate.date === best.date && candidate.slot_index < best.slot_index)
      best = candidate;
  }

  return best;
}

function pickAdjacentOppositeHalf({ adjacentSlot, rowsIndex }) {
  if (!adjacentSlot) return null;
  const opposite = adjacentSlot.daypart === "morning" ? "afternoon" : "morning";
  // same date+zone, opposite half
  const slot = pickBestSlotForDate({
    date: adjacentSlot.date,
    zone: adjacentSlot.zone,
    daypart: opposite,
    indexes: rowsIndex,
  });
  return slot;
}

// Wednesday suggestion: favor staying near the customer zone (no A<->D direct).
function pickWednesdaySlot({ customerZone, rowsIndex }) {
  // Build zone preference order for Wednesday:
  // start at customerZone, then expand outward by adjacency
  // disallow A->D and D->A jumps by never including the opposite end for those
  let order = [];

  if (customerZone === "A") order = ["A", "B", "C"]; // not D
  else if (customerZone === "D") order = ["D", "C", "B"]; // not A
  else if (customerZone === "B") order = ["B", "A", "C", "D"];
  else if (customerZone === "C") order = ["C", "D", "B", "A"];
  else order = [customerZone, "B", "C", "A", "D"];

  // find next Wednesday date with any available slot in preferred zones
  const start = new Date();
  for (let i = 0; i <= 60; i++) {
    const d = addDays(start, i);
    const date = isoDate(d);
    if (d.getDay() !== 3) continue; // Wed

    for (const z of order) {
      // prefer morning first, then afternoon
      const m = pickBestSlotForDate({
        date,
        zone: z,
        daypart: "morning",
        indexes: rowsIndex,
      });
      if (m) return m;

      const a = pickBestSlotForDate({
        date,
        zone: z,
        daypart: "afternoon",
        indexes: rowsIndex,
      });
      if (a) return a;
    }
  }

  return null;
}

function uniqSlots(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s) continue;
    const k = `${s.date}|${s.zone}|${s.slot_index}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const method = req.method || "GET";
    if (!["GET", "POST"].includes(method)) {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const input =
      method === "POST"
        ? (req.body || {})
        : {
            zone: req.query.zone,
            appointmentType: req.query.type,
          };

    const zone = String(input.zone || "").toUpperCase();
    const appointmentType = normalizeType(input.appointmentType);

    if (!ZONES.includes(zone)) {
      return res.status(400).json({ error: "zone must be one of A, B, C, D" });
    }

    const rows = await supabaseFetchSlots({ daysForward: 60 });
    const idx = buildIndexes(rows);

    // PRIMARY suggestions
    let primary = [];

    if (appointmentType === "parts_in") {
      // Nudge toward Wednesday: 2 Wed options + 1 zone-day option
      const wed1 = pickWednesdaySlot({ customerZone: zone, rowsIndex: idx });

      // second Wednesday option: opposite half on same date+zone if possible
      let wed2 = null;
      if (wed1) {
        wed2 = pickBestSlotForDate({
          date: wed1.date,
          zone: wed1.zone,
          daypart: wed1.daypart === "morning" ? "afternoon" : "morning",
          indexes: idx,
        });
      }

      const zoneDayOne = findNextZoneDaySlot({
        zone,
        daypart: "morning",
        rowsIndex: idx,
      }) ||
        findNextZoneDaySlot({
          zone,
          daypart: "afternoon",
          rowsIndex: idx,
        });

      primary = uniqSlots([wed1, wed2, zoneDayOne]).slice(0, 3);
    } else {
      // Standard / no_one_home:
      // 1) customer zone-day morning
      const zMorning = findNextZoneDaySlot({
        zone,
        daypart: "morning",
        rowsIndex: idx,
      });

      // 2) customer zone-day afternoon
      const zAfternoon = findNextZoneDaySlot({
        zone,
        daypart: "afternoon",
        rowsIndex: idx,
      });

      // 3) one adjacent zone-day slot (prefer morning; earliest neighbor wins)
      const adjPrimary = pickAdjacentDayPrimary({
        customerZone: zone,
        rowsIndex: idx,
      });

      primary = uniqSlots([zMorning, zAfternoon, adjPrimary]).slice(0, 3);
    }

    // MORE OPTIONS (only for standard/parts_in; NOT for no_one_home)
    let more = null;

    if (appointmentType !== "no_one_home") {
      const third = primary[2] || null;
      const adjacentOpposite = third ? pickAdjacentOppositeHalf({ adjacentSlot: third, rowsIndex: idx }) : null;

      const wed = pickWednesdaySlot({ customerZone: zone, rowsIndex: idx });

      // Your rule: More options yields exactly:
      // 1) opposite half of adjacent-zone-day (if exists)
      // 2) Wednesday (one option)
      // plus a CTA to switch to no-one-home (handled in UI copy)
      more = {
        options: uniqSlots([adjacentOpposite, wed]).slice(0, 2),
        show_no_one_home_cta: true,
      };
    }

    return res.status(200).json({
      zone,
      appointmentType,
      primary,
      more,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
