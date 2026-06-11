// /api/return-visit-options.js
// Public token endpoint.
// Parts-return scheduler only. Does NOT change /api/get-available-slots.js.
// Parts return options:
//   Primary: Option 1 = Wednesday AM, Option 2 = Wednesday PM
//   More: Option 3 = home-zone day AM, Option 4 = home-zone day PM, Option 5 = adjacent day outside-in

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { ok: resp.ok, status: resp.status, data, text };
}

async function getSingle({ supabaseUrl, serviceRole, table, filters, select = "*" }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", select);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  url.searchParams.set("limit", "1");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Supabase lookup failed (${table}): ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data[0] || null : null;
}

function todayPacificDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

function nowPacificParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    date: `${m.year}-${m.month}-${m.day}`,
    time: `${m.hour}:${m.minute}:${m.second}`,
  };
}

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

function toUTCDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function dowUTC(iso) {
  return toUTCDate(iso).getUTCDay();
}

function localDateTimeFromWindowStart(value) {
  if (!value) return null;

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    date: `${m.year}-${m.month}-${m.day}`,
    time: `${m.hour}:${m.minute}:${m.second}`,
  };
}

function partStatusLabel(value) {
  const v = String(value || "").toLowerCase();

  if (v === "tech_has_part") return "Dryer Dudes has the part";
  if (v === "customer_has_part") return "Customer has the part";
  if (v === "return_visit_ready") return "Return visit booked";

  return "Part ready";
}

function zoneDistance(a, b) {
  const order = ["A", "B", "C", "D"];
  const ia = order.indexOf(String(a || "").toUpperCase());
  const ib = order.indexOf(String(b || "").toUpperCase());

  if (ia < 0 || ib < 0) return 99;
  return Math.abs(ia - ib);
}

function zonesByDistance(homeZone, maxDistance = 2) {
  return ["A", "B", "C", "D"]
    .map((z) => ({ zone: z, distance: zoneDistance(homeZone, z) }))
    .filter((x) => x.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.zone.localeCompare(b.zone))
    .map((x) => x.zone);
}

function adjacentZones(homeZone) {
  const z = String(homeZone || "").toUpperCase();
  const map = {
    A: ["B"],
    B: ["A", "C"],
    C: ["B", "D"],
    D: ["C"],
  };
  return map[z] || [];
}

function routeDayZoneForDate(serviceDate) {
  // Mon=B, Tue=D, Wed=X, Thu=A, Fri=C
  const map = { 1: "B", 2: "D", 3: "X", 4: "A", 5: "C" };
  return map[dowUTC(serviceDate)] || null;
}

function isMorningSlotIndex(idx) {
  return [1, 2, 3, 4].includes(Number(idx));
}

function isAfternoonSlotIndex(idx) {
  return [5, 6, 7, 8].includes(Number(idx));
}

function sortByDateThenSlot(a, b) {
  return (
    String(a.service_date).localeCompare(String(b.service_date)) ||
    Number(a.slot_index) - Number(b.slot_index) ||
    String(a.zone_code || "").localeCompare(String(b.zone_code || ""))
  );
}

function optionFromRow(row, role) {
  if (!row?.id) return null;

  const idx = Number(row.slot_index);

  return {
    id: row.id,
    slot_id: row.id,
    service_date: row.service_date,
    slot_index: idx,
    zone_code: row.zone_code || null,
    route_day_zone: row.route_day_zone || null,
    home_zone: row.home_zone || null,
    role: role || null,
    daypart: row.daypart || (isMorningSlotIndex(idx) ? "morning" : "afternoon"),
    window_label: row.window_label || null,
    start_time: row.start_time || null,
    end_time: row.end_time || null,
  };
}

async function loadScheduleRows({ supabaseUrl, serviceRole, todayISO, horizonISO }) {
  const url = new URL(`${supabaseUrl}/rest/v1/schedule_slots`);
  url.searchParams.set(
    "select",
    "id,service_date,slot_index,zone_code,daypart,window_label,start_time,end_time,tech_id,is_booked,booking_id"
  );
  url.searchParams.append("service_date", `gte.${todayISO}`);
  url.searchParams.append("service_date", `lte.${horizonISO}`);
  url.searchParams.set("zone_code", "in.(X,A,B,C,D)");
  url.searchParams.set("order", "service_date.asc,slot_index.asc,zone_code.asc");
  url.searchParams.set("limit", "2000");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Could not load return visit schedule slots: ${r.status} ${r.text}`);
  }

  return Array.isArray(r.data) ? r.data : [];
}

async function loadActiveBookings({ supabaseUrl, serviceRole, todayISO, horizonISO }) {
  const url = new URL(`${supabaseUrl}/rest/v1/bookings`);
  url.searchParams.set(
    "select",
    "id,slot_id,job_ref,status,zone_code,route_zone_code,window_start,window_end"
  );
  url.searchParams.append("window_start", `gte.${todayISO}T00:00:00Z`);
  url.searchParams.append("window_start", `lt.${addDaysISO(horizonISO, 1)}T00:00:00Z`);
  url.searchParams.set("order", "window_start.asc");
  url.searchParams.set("limit", "1000");

  const r = await sbFetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!r.ok) {
    throw new Error(`Could not load active bookings for return visit scheduler: ${r.status} ${r.text}`);
  }

  const activeStatuses = new Set([
    "scheduled",
    "en_route",
    "on_site",
    "billing_pending",
    "awaiting_payment",
    "parts_approval_needed",
    "parts_on_order",
    "return_visit_needed",
    "completed",
  ]);

  return (Array.isArray(r.data) ? r.data : []).filter((b) => {
    const status = String(b.status || "").toLowerCase();
    return activeStatuses.has(status);
  });
}

function buildScheduleContext({ rawRows, activeBookings, homeZone }) {
  const now = nowPacificParts();

  const rows = rawRows
    .map((r) => {
      const serviceDate = String(r.service_date || "").trim();
      const slotIndex = Number(r.slot_index);
      const zoneCode = String(r.zone_code || "").trim().toUpperCase();
      const routeDayZone = routeDayZoneForDate(serviceDate);

      return {
        ...r,
        service_date: serviceDate,
        slot_index: slotIndex,
        zone_code: zoneCode,
        route_day_zone: routeDayZone,
        home_zone: homeZone,
        start_time: r.start_time || null,
        end_time: r.end_time || null,
      };
    })
    .filter((r) => {
      if (!r.id || !r.service_date || !Number.isFinite(r.slot_index)) return false;
      if (!r.route_day_zone) return false;

      const start = String(r.start_time || "").slice(0, 8);
      if (r.service_date === now.date && start && start <= now.time) return false;

      return true;
    })
    .sort(sortByDateThenSlot);

  const rowById = new Map(rows.map((r) => [String(r.id), r]));
  const rowsByDateIndexZone = new Map();
  const rowsByDateIndex = new Map();

  for (const row of rows) {
    const dateIndexKey = `${row.service_date}|${row.slot_index}`;
    const dateIndexZoneKey = `${row.service_date}|${row.slot_index}|${row.zone_code}`;

    rowsByDateIndexZone.set(dateIndexZoneKey, row);

    if (!rowsByDateIndex.has(dateIndexKey)) {
      rowsByDateIndex.set(dateIndexKey, []);
    }

    rowsByDateIndex.get(dateIndexKey).push(row);
  }

  const occupancyByDateIndex = new Map();

  function setOccupancy({ row, booking, zoneCode, reason }) {
    if (!row?.service_date || !Number.isFinite(Number(row.slot_index))) return;

    const key = `${row.service_date}|${Number(row.slot_index)}`;
    if (occupancyByDateIndex.has(key)) return;

    occupancyByDateIndex.set(key, {
      zone_code: String(zoneCode || booking?.zone_code || row.zone_code || "").toUpperCase(),
      booking_id: booking?.id || row.booking_id || null,
      reason: reason || "occupied",
    });
  }

  // schedule_slots.is_booked is a hard signal, even if bookings lookup is incomplete.
  for (const row of rows) {
    if (row.is_booked === true) {
      setOccupancy({
        row,
        booking: null,
        zoneCode: row.zone_code,
        reason: "schedule_slot_is_booked",
      });
    }
  }

  // bookings table is the stronger signal when we can map booking.slot_id back to a schedule slot.
  for (const booking of activeBookings) {
    const slotRow = booking.slot_id ? rowById.get(String(booking.slot_id)) : null;

    if (slotRow) {
      setOccupancy({
        row: slotRow,
        booking,
        zoneCode: booking.zone_code || booking.route_zone_code || slotRow.zone_code,
        reason: "active_booking_slot_id",
      });
      continue;
    }

    // Fallback: match by local date and start time if slot_id is missing/stale.
    const local = localDateTimeFromWindowStart(booking.window_start);
    if (!local) continue;

    const dateRows = rows.filter((r) => {
      return r.service_date === local.date && String(r.start_time || "").slice(0, 8) === local.time;
    });

    const preferred =
      dateRows.find((r) => String(r.zone_code || "").toUpperCase() === String(booking.zone_code || "").toUpperCase()) ||
      dateRows[0] ||
      null;

    if (preferred) {
      setOccupancy({
        row: preferred,
        booking,
        zoneCode: booking.zone_code || booking.route_zone_code || preferred.zone_code,
        reason: "active_booking_time_fallback",
      });
    }
  }

  function getRowsFor(date, slotIndex) {
    return rowsByDateIndex.get(`${date}|${Number(slotIndex)}`) || [];
  }

  function getRow(date, slotIndex, zoneCode) {
    return rowsByDateIndexZone.get(`${date}|${Number(slotIndex)}|${String(zoneCode || "").toUpperCase()}`) || null;
  }

  function getOccupancy(date, slotIndex) {
    return occupancyByDateIndex.get(`${date}|${Number(slotIndex)}`) || null;
  }

  function isSlotIndexOpen(date, slotIndex) {
    return !getOccupancy(date, slotIndex);
  }

  return {
    rows,
    getRowsFor,
    getRow,
    getOccupancy,
    isSlotIndexOpen,
    now,
  };
}

function pickWednesdayOption({ ctx, homeZone, wantedPart, excludeKeys }) {
  const slotPriority = wantedPart === "am" ? [1, 2, 3, 4] : [5, 6, 7, 8];
  const zonePreference = zonesByDistance(homeZone, 2);

  const wednesdayDates = [...new Set(
    ctx.rows
      .filter((r) => r.route_day_zone === "X")
      .map((r) => r.service_date)
  )].sort();

  for (const date of wednesdayDates) {
    for (const idx of slotPriority) {
      if (!ctx.isSlotIndexOpen(date, idx)) continue;

      const rowsAtSlot = ctx.getRowsFor(date, idx);

      // Your current Wednesday rows are stored as X. Accept X as the Wednesday flex slot.
      const xRow = rowsAtSlot.find((r) => r.zone_code === "X");
      if (xRow && !excludeKeys.has(`${xRow.service_date}|${xRow.slot_index}`)) {
        return xRow;
      }

      // If you later generate Wednesday rows with actual A/B/C/D zones, prefer same zone,
      // then 1 away, then 2 away, never 3 away.
      for (const zone of zonePreference) {
        const row = rowsAtSlot.find((r) => r.zone_code === zone);
        if (row && !excludeKeys.has(`${row.service_date}|${row.slot_index}`)) {
          return row;
        }
      }
    }
  }

  return null;
}

function pickHomeZoneDayOption({ ctx, homeZone, wantedPart, excludeKeys }) {
  const slotPriority = wantedPart === "am" ? [1, 2, 3, 4] : [5, 6, 7, 8];

  const dates = [...new Set(
    ctx.rows
      .filter((r) => r.route_day_zone === homeZone)
      .map((r) => r.service_date)
  )].sort();

  for (const date of dates) {
    for (const idx of slotPriority) {
      if (!ctx.isSlotIndexOpen(date, idx)) continue;

      const row = ctx.getRow(date, idx, homeZone);
      if (!row) continue;

      const key = `${row.service_date}|${row.slot_index}`;
      if (excludeKeys.has(key)) continue;

      return row;
    }
  }

  return null;
}

function pickAdjacentOutsideInOption({ ctx, homeZone, excludeKeys }) {
  const adjacent = new Set(adjacentZones(homeZone));

  const dates = [...new Set(
    ctx.rows
      .filter((r) => adjacent.has(r.route_day_zone))
      .map((r) => r.service_date)
  )].sort();

  function candidateIfOpen(date, idx) {
    if (!ctx.isSlotIndexOpen(date, idx)) return null;

    const rowsAtSlot = ctx.getRowsFor(date, idx);
    const routeDayZone = rowsAtSlot[0]?.route_day_zone || null;

    // Prefer a schedule row explicitly for this job's home zone.
    // If the table only has one route-day row for that slot, fall back to it.
    const row =
      ctx.getRow(date, idx, homeZone) ||
      (routeDayZone ? ctx.getRow(date, idx, routeDayZone) : null) ||
      rowsAtSlot[0] ||
      null;

    if (!row) return null;

    const key = `${row.service_date}|${row.slot_index}`;
    if (excludeKeys.has(key)) return null;

    return row;
  }

  function slotBookedWithHomeZone(date, idx) {
    const occ = ctx.getOccupancy(date, idx);
    if (!occ) return false;
    return String(occ.zone_code || "").toUpperCase() === homeZone;
  }

  for (const date of dates) {
    // AM outside-in:
    // 1) Slot 4 if open.
    // 2) If slot 4 is booked with the same zone as this job, slot 3 can be offered if open.
    // 3) If slot 4 is booked by any other zone, do not offer slot 3.
    const slot4 = candidateIfOpen(date, 4);
    if (slot4) return slot4;

    if (slotBookedWithHomeZone(date, 4)) {
      const slot3 = candidateIfOpen(date, 3);
      if (slot3) return slot3;
    }

    // PM outside-in:
    // 1) Slot 8 if open.
    // 2) If slot 8 is booked with the same zone as this job, slot 7 can be offered if open.
    // 3) If slot 8 is booked by any other zone, do not offer slot 7.
    const slot8 = candidateIfOpen(date, 8);
    if (slot8) return slot8;

    if (slotBookedWithHomeZone(date, 8)) {
      const slot7 = candidateIfOpen(date, 7);
      if (slot7) return slot7;
    }
  }

  return null;
}

function buildPartsReturnOptions({ ctx, homeZone }) {
  const excludeKeys = new Set();

  function take(row, role) {
    if (!row) return null;
    const key = `${row.service_date}|${row.slot_index}`;
    if (excludeKeys.has(key)) return null;
    excludeKeys.add(key);
    return optionFromRow(row, role);
  }

  const option1 = take(
    pickWednesdayOption({ ctx, homeZone, wantedPart: "am", excludeKeys }),
    "wednesday_am"
  );

  const option2 = take(
    pickWednesdayOption({ ctx, homeZone, wantedPart: "pm", excludeKeys }),
    "wednesday_pm"
  );

  const option3 = take(
    pickHomeZoneDayOption({ ctx, homeZone, wantedPart: "am", excludeKeys }),
    "home_zone_am"
  );

  const option4 = take(
    pickHomeZoneDayOption({ ctx, homeZone, wantedPart: "pm", excludeKeys }),
    "home_zone_pm"
  );

  const option5 = take(
    pickAdjacentOutsideInOption({ ctx, homeZone, excludeKeys }),
    "adjacent_outside_in"
  );

  return {
    primary: [option1, option2].filter(Boolean),
    moreOptions: [option3, option4, option5].filter(Boolean),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const token = String(req.query?.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Missing return visit token",
      });
    }

    const billing = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_billing",
      filters: { return_visit_token: token },
      select: "*",
    });

    if (!billing) {
      return res.status(404).json({
        ok: false,
        error: "Return visit link not found",
      });
    }

    if (String(billing.payment_status || "").toLowerCase() !== "paid") {
      return res.status(409).json({
        ok: false,
        error: "The ordered part must be paid before scheduling the return visit.",
      });
    }

    const partStatus = String(billing.part_status || "").toLowerCase();
    const partDeliveryDestination =
      String(billing.part_delivery_destination || "").toLowerCase() === "customer"
        ? "customer"
        : "tech";

    const booking = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: billing.booking_id },
      select: "id,request_id,job_ref,status,slot_id,zone_code,home_location_code,route_zone_code,tech_id,assigned_tech_id",
    });

    if (!booking) {
      return res.status(404).json({
        ok: false,
        error: "Booking not found",
      });
    }

    const request = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: booking.request_id },
      select: "id,name,email,phone,address,zone_code,home_location_code,notes",
    });

    if (partStatus === "customer_receiving" && partDeliveryDestination === "customer") {
      return res.status(200).json({
        ok: true,
        token,
        waiting_for_customer_part: true,
        job: {
          booking_id: booking.id,
          job_ref: booking.job_ref || "",
          customer_name: request?.name || "",
          address: request?.address || "",
          part_status: partStatus,
          part_status_label: "Part is shipping to you",
        },
        primary: [],
        more: {
          options: [],
          show_authorized_entry_note: false,
        },
        scheduler: {
          source: "parts_return_scheduler",
          style: "waiting_for_customer_part",
        },
      });
    }

    if (!["tech_has_part", "customer_has_part", "return_visit_ready"].includes(partStatus)) {
      return res.status(409).json({
        ok: false,
        error: "The part is not ready for return visit scheduling yet.",
      });
    }

    const bookingStatus = String(booking.status || "").toLowerCase();

    if (["completed", "cancelled", "canceled", "no_show"].includes(bookingStatus)) {
      return res.status(409).json({
        ok: false,
        error: "This job is no longer available for return visit scheduling.",
      });
    }

    const homeZone =
      String(request?.zone_code || "").trim().toUpperCase() ||
      String(request?.home_location_code || "").trim().toUpperCase() ||
      String(booking.home_location_code || "").trim().toUpperCase() ||
      String(booking.route_zone_code || "").trim().toUpperCase() ||
      String(booking.zone_code || "").trim().toUpperCase();

    if (!["A", "B", "C", "D"].includes(homeZone)) {
      return res.status(400).json({
        ok: false,
        error: "Could not determine the customer's home service zone for return visit scheduling.",
        debug: {
          request_zone_code: request?.zone_code || null,
          request_home_location_code: request?.home_location_code || null,
          booking_home_location_code: booking.home_location_code || null,
          booking_route_zone_code: booking.route_zone_code || null,
          booking_zone_code: booking.zone_code || null,
        },
      });
    }

    const todayISO = todayPacificDate();
    const horizonISO = addDaysISO(todayISO, 21);

    const rawRows = await loadScheduleRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      todayISO,
      horizonISO,
    });

    const activeBookings = await loadActiveBookings({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      todayISO,
      horizonISO,
    });

    const ctx = buildScheduleContext({
      rawRows,
      activeBookings,
      homeZone,
    });

    const { primary, moreOptions } = buildPartsReturnOptions({
      ctx,
      homeZone,
    });

    return res.status(200).json({
      ok: true,
      token,
      zone: homeZone,
      job: {
        booking_id: booking.id,
        job_ref: booking.job_ref || "",
        customer_name: request?.name || "",
        address: request?.address || "",
        part_status: partStatus,
        part_status_label: partStatusLabel(partStatus),
      },
      primary,
      more: {
        options: moreOptions,
        show_authorized_entry_note: true,
      },
      scheduler: {
        source: "parts_return_scheduler",
        style: "2_primary_wednesday_3_more_home_adjacent",
        rules: {
          primary: ["wednesday_am", "wednesday_pm"],
          more: ["home_zone_am", "home_zone_pm", "adjacent_outside_in"],
          adjacent_outside_in: "slot4_then_slot3_if_slot4_same_zone; slot8_then_slot7_if_slot8_same_zone",
          horizon_days: 21,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
