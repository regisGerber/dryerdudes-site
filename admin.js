import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config.");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);
const TECH_COLORS = ["#22d3ee", "#a78bfa", "#34d399", "#f59e0b", "#fb7185", "#60a5fa", "#f472b6", "#2dd4bf"];
const SLOT_TEMPLATES = [
  { slot_index: 1, label: "A", start_h: 8, start_m: 0, end_h: 10, end_m: 0, start_time: "08:00:00", daypart: "morning" },
  { slot_index: 2, label: "B", start_h: 8, start_m: 30, end_h: 10, end_m: 30, start_time: "08:30:00", daypart: "morning" },
  { slot_index: 3, label: "C", start_h: 9, start_m: 30, end_h: 11, end_m: 30, start_time: "09:30:00", daypart: "morning" },
  { slot_index: 4, label: "D", start_h: 10, start_m: 0, end_h: 12, end_m: 0, start_time: "10:00:00", daypart: "morning" },
  { slot_index: 5, label: "E", start_h: 13, start_m: 0, end_h: 15, end_m: 0, start_time: "13:00:00", daypart: "afternoon" },
  { slot_index: 6, label: "F", start_h: 13, start_m: 30, end_h: 15, end_m: 30, start_time: "13:30:00", daypart: "afternoon" },
  { slot_index: 7, label: "G", start_h: 14, start_m: 30, end_h: 16, end_m: 30, start_time: "14:30:00", daypart: "afternoon" },
  { slot_index: 8, label: "H", start_h: 15, start_m: 0, end_h: 17, end_m: 0, start_time: "15:00:00", daypart: "afternoon" },
];

// ---------- UI ----------
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");
const focusTech = document.getElementById("focusTech");
const overlayAllBtn = document.getElementById("overlayAllBtn");
const clearOverlayBtn = document.getElementById("clearOverlayBtn");
const dayBtn = document.getElementById("dayBtn");
const weekBtn = document.getElementById("weekBtn");
const monthBtn = document.getElementById("monthBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const todayBtn = document.getElementById("todayBtn");
const rangeLabel = document.getElementById("rangeLabel");
const calWrap = document.getElementById("calWrap");
const topError = document.getElementById("topError");

const offDate = document.getElementById("offDate");
const offBlock = document.getElementById("offBlock");
const offSlot = document.getElementById("offSlot");
const offReason = document.getElementById("offReason");
const addOffBtn = document.getElementById("addOffBtn");
const offList = document.getElementById("offList");
const populateSlotsBtn = document.getElementById("populateSlotsBtn");
const sysNote = document.getElementById("sysNote");

function show(el, on = true) { if (el) el.style.display = on ? "" : "none"; }
function setText(el, t) { if (el) el.textContent = t ?? ""; }
function toISODate(d) { return d.toISOString().slice(0, 10); }
function fmtDay(d) { return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }
function fmtDate(d) { return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); }
function fmtTimeLabel(h1, m1, h2, m2) { const pad = (n) => String(n).padStart(2, "0"); return `${h1}:${pad(m1)}–${h2}:${pad(m2)}`; }
function statusLabel(s) { return String(s || "").toLowerCase() || "scheduled"; }
function isBusinessDay(d) { const w = d.getDay(); return w >= 1 && w <= 5; }

function getWeekStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function getRangeForView(anchor, mode) {
  if (mode === "day") {
    const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    const e = new Date(s);
    e.setDate(e.getDate() + 1);
    return { start: s, end: e };
  }
  if (mode === "month") {
    const s = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const e = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    return { start: s, end: e };
  }
  const s = getWeekStart(anchor);
  const e = new Date(s);
  e.setDate(e.getDate() + 7);
  return { start: s, end: e };
}

function getViewDays(start, end, mode) {
  const days = [];
  for (const d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    if (mode === "week" && !isBusinessDay(d)) continue;
    days.push(new Date(d));
  }
  return days;
}

// ---------- auth ----------
async function requireAdmin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { window.location.href = "/login.html"; return null; }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", session.user.id)
    .single();

  if (profile?.role !== "admin") { window.location.href = "/tech.html"; return null; }
  setText(whoami, session.user.email);
  return session;
}

logoutBtn?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.href = "/login.html";
});

// ---------- state ----------
let viewMode = "week";
let overlayAll = true;
let focusTechId = "all";
let anchorDate = new Date();
let techRows = [];
const techById = new Map();
const zoneByTechId = new Map();

function assignTechColors() {
  techById.clear();
  techRows.forEach((t, idx) => {
    techById.set(String(t.id), { ...t, color: TECH_COLORS[idx % TECH_COLORS.length] });
  });
}

async function loadZoneAssignments() {
  zoneByTechId.clear();
  const { data, error } = await supabase
    .from("zone_tech_assignments")
    .select("tech_id,zone_code");
  if (error) throw error;

  for (const row of data || []) {
    const techId = row?.tech_id ? String(row.tech_id) : "";
    const zoneCode = String(row?.zone_code || "").trim().toUpperCase();
    if (!techId || !zoneCode) continue;
    if (!zoneByTechId.has(techId)) zoneByTechId.set(techId, zoneCode);
  }
}

function getSelectedTechIds() {
  if (overlayAll || focusTechId === "all") return techRows.map((t) => String(t.id));
  return [String(focusTechId)];
}

function syncViewButtons() {
  [dayBtn, weekBtn, monthBtn].forEach((btn) => btn?.classList.remove("active"));
  if (viewMode === "day") dayBtn?.classList.add("active");
  if (viewMode === "week") weekBtn?.classList.add("active");
  if (viewMode === "month") monthBtn?.classList.add("active");
}

function shiftAnchor(direction) {
  if (viewMode === "day") {
    anchorDate.setDate(anchorDate.getDate() + direction);
    return;
  }
  if (viewMode === "week") {
    anchorDate.setDate(anchorDate.getDate() + (7 * direction));
    return;
  }
  anchorDate.setMonth(anchorDate.getMonth() + direction);
}

// ---------- techs ----------
async function loadTechs() {
  const { data } = await supabase
    .from("techs")
    .select("id,name,active")
    .eq("active", true)
    .order("created_at");

  techRows = data || [];
  assignTechColors();

  focusTech.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "All techs";
  focusTech.appendChild(optAll);

  for (const t of techRows) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.name;
    focusTech.appendChild(o);
  }
}

// ---------- data ----------
async function loadSlots(start, end) {
  const { data, error } = await supabase
    .from("slots")
    .select("id,tech_id,slot_date,slot_index,start_time,status,zone")
    .gte("slot_date", toISODate(start))
    .lt("slot_date", toISODate(end))
    .order("slot_date")
    .order("slot_index")
    .order("start_time");

  if (error) throw error;
  return data || [];
}

async function loadBookings(start, end) {
  const { data, error } = await supabase
    .from("bookings")
    .select("id,slot_id,window_start,status,job_ref,assigned_tech_id,booking_requests:request_id(name,address)")
    .gte("window_start", start.toISOString())
    .lt("window_start", end.toISOString());

  if (error) throw error;
  return data || [];
}

async function loadTimeOff(start, end) {
  const startDate = toISODate(start);
  const endDate = toISODate(new Date(end.getTime() - 1));

  const { data, error } = await supabase
    .from("tech_time_off")
    .select("id,tech_id,service_date,slot_index,reason")
    .gte("service_date", startDate)
    .lte("service_date", endDate);

  if (error) throw error;
  return data || [];
}

// ---------- insert OFF ----------
async function insertSlotOff(tech_id, dateISO, slot_index, reason) {
  const slot = SLOT_TEMPLATES.find((s) => Number(s.slot_index) === Number(slot_index));
  const startTime = slot?.start_time || "08:00:00";
  const endTime = slot ? `${String(slot.end_h).padStart(2, "0")}:${String(slot.end_m).padStart(2, "0")}:00` : "10:00:00";

  const attempts = [
    // schema with service_date/slot_index
    {
      tech_id,
      service_date: dateISO,
      slot_index,
      type: "slot",
      reason,
    },
    // schema with starts_at/ends_at
    {
      tech_id,
      slot_index,
      type: "slot",
      reason,
      starts_at: `${dateISO}T${startTime}`,
      ends_at: `${dateISO}T${endTime}`,
    },
    // schema with start_at/end_at
    {
      tech_id,
      slot_index,
      type: "slot",
      reason,
      start_at: `${dateISO}T${startTime}`,
      end_at: `${dateISO}T${endTime}`,
    },
  ];

  let lastErr = null;
  for (const payload of attempts) {
    const { error } = await supabase.from("tech_time_off").insert(payload);
    if (!error) return;
    lastErr = error;

    const msg = String(error?.message || "").toLowerCase();
    const schemaMismatch =
      msg.includes("could not find") ||
      msg.includes("non-default value") ||
      msg.includes("schema cache") ||
      msg.includes("column");

    if (!schemaMismatch) break;
  }

  throw lastErr || new Error("Could not insert time off");
}

addOffBtn?.addEventListener("click", async () => {
  try {
    show(topError, false);

    if (focusTechId === "all") {
      setText(topError, "Pick a tech first.");
      show(topError, true);
      return;
    }

    const dateISO = offDate.value;
    const block = offBlock.value;
    const slotIndex = Number(offSlot.value || 1);
    const reason = offReason.value || null;

    if (!dateISO) throw new Error("Select date");

    if (block === "all_day") {
      for (let i = 1; i <= 8; i++) await insertSlotOff(focusTechId, dateISO, i, reason);
    } else if (block === "am") {
      for (let i = 1; i <= 4; i++) await insertSlotOff(focusTechId, dateISO, i, reason);
    } else if (block === "pm") {
      for (let i = 5; i <= 8; i++) await insertSlotOff(focusTechId, dateISO, i, reason);
    } else {
      await insertSlotOff(focusTechId, dateISO, slotIndex, reason);
    }

    await render();
  } catch (e) {
    setText(topError, e.message);
    show(topError, true);
  }
});

// ---------- slot population (120-day horizon) ----------
async function populateSlotsToHorizon(targetDays = 120) {
  // Prefer server-side service-role path (avoids RLS 403 for admin UI writes)
  try {
    const resp = await fetch("/api/admin-populate-slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: targetDays })
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data?.ok) {
      return { inserted: Number(data.inserted || 0), mode: "api" };
    }
    throw new Error(data?.message || data?.error || `admin-populate-slots failed (${resp.status})`);
  } catch (apiErr) {
    // only fallback to client path when API route is unavailable in this environment
    const m = String(apiErr?.message || "").toLowerCase();
    const canFallback = m.includes("failed to fetch") || m.includes("network") || m.includes("404") || m.includes("method not allowed");
    if (!canFallback) throw apiErr;
  }

  // Fallback to direct client upsert (kept for local/backward compatibility)
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + targetDays);

  const upserts = [];
  for (const tech of techRows) {
    for (const d = new Date(today); d < end; d.setDate(d.getDate() + 1)) {
      if (!isBusinessDay(d)) continue;
      const slot_date = toISODate(d);
      for (const slot of SLOT_TEMPLATES) {
        upserts.push({
          tech_id: tech.id,
          slot_date,
          slot_index: slot.slot_index,
          start_time: slot.start_time,
          daypart: slot.daypart,
          zone: zoneByTechId.get(String(tech.id)) || null,
          status: "open"
        });
      }
    }
  }

  if (!upserts.length) return { inserted: 0, mode: "client" };

  const { error } = await supabase
    .from("slots")
    .upsert(upserts, { onConflict: "tech_id,slot_date,slot_index" });

  if (error) throw error;
  return { inserted: upserts.length, mode: "client" };
}

populateSlotsBtn?.addEventListener("click", async () => {
  populateSlotsBtn.disabled = true;
  setText(sysNote, "Populating slots...");
  try {
    const result = await populateSlotsToHorizon(120);
    setText(sysNote, `✅ Slots ensured for next 120 days. Checked ${result.inserted} slot rows.`);
    await render();
  } catch (e) {
    setText(sysNote, `❌ Could not populate slots: ${e.message}`);
  } finally {
    populateSlotsBtn.disabled = false;
  }
});

function slotCard({ type, techName, techColor, status, title, meta }) {
  const d = document.createElement("div");
  d.className = `slot ${type} tech`;
  d.style.setProperty("--tech-color", techColor || "#94a3b8");
  d.innerHTML = `
    <div>
      <span class="badge techname">${techName || "Unassigned"}</span>
      <span class="badge gray">${status}</span>
    </div>
    <div class="slot-title">${title || ""}</div>
    <div class="slot-meta">${meta || ""}</div>
  `;
  return d;
}

function renderGrid(days, slots, bookings, timeOffRows) {
  const selectedIds = new Set(getSelectedTechIds());
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.innerHTML = `<th class="timecol">Slot</th>${days.map((d) => `<th>${fmtDay(d)}</th>`).join("")}`;
  thead.appendChild(hr);
  table.appendChild(thead);

  const bookingBySlotId = new Map();
  for (const b of bookings) {
    if (b.slot_id) bookingBySlotId.set(String(b.slot_id), b);
  }

  const tbody = document.createElement("tbody");
  for (const slot of SLOT_TEMPLATES) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.textContent = `${slot.label} • ${fmtTimeLabel(slot.start_h, slot.start_m, slot.end_h, slot.end_m)}`;
    tr.appendChild(tdTime);

    for (const d of days) {
      const td = document.createElement("td");
      const dateISO = toISODate(d);

      const cellSlots = slots
        .filter((s) => s.slot_date === dateISO && Number(s.slot_index) === slot.slot_index && selectedIds.has(String(s.tech_id)))
        .sort((a, b) => (techById.get(String(a.tech_id))?.name || "").localeCompare(techById.get(String(b.tech_id))?.name || ""));

      const cellOff = timeOffRows.filter((o) => o.service_date === dateISO && Number(o.slot_index) === slot.slot_index && selectedIds.has(String(o.tech_id)));

      if (!cellSlots.length && !cellOff.length) {
        td.appendChild(slotCard({ type: "open", status: "open", title: "No slot record", meta: "Run slot population.", techName: "—", techColor: "#64748b" }));
      }

      for (const s of cellSlots) {
        const tech = techById.get(String(s.tech_id));
        const off = cellOff.find((o) => String(o.tech_id) === String(s.tech_id));
        if (off) {
          td.appendChild(slotCard({ type: "off", techName: tech?.name, techColor: tech?.color, status: "OFF", title: "Time off", meta: off.reason || "" }));
          continue;
        }

        const booking = bookingBySlotId.get(String(s.id));
        if (booking) {
          td.appendChild(slotCard({
            type: "booked",
            techName: tech?.name,
            techColor: tech?.color,
            status: statusLabel(booking.status),
            title: booking.booking_requests?.name || booking.job_ref || "Booked",
            meta: booking.booking_requests?.address || ""
          }));
        } else {
          td.appendChild(slotCard({ type: "open", techName: tech?.name, techColor: tech?.color, status: "open", title: "Not booked", meta: s.zone ? `Zone: ${s.zone}` : "" }));
        }
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
}

async function render() {
  try {
    show(topError, false);
    syncViewButtons();

    const { start, end } = getRangeForView(anchorDate, viewMode);
    const days = getViewDays(start, end, viewMode);

    rangeLabel.textContent = `${fmtDate(start)} → ${fmtDate(new Date(end.getTime() - 1))} (${viewMode})`;

    const [slots, bookings, timeOffRows] = await Promise.all([
      loadSlots(start, end),
      loadBookings(start, end),
      loadTimeOff(start, end)
    ]);

    renderGrid(days, slots, bookings, timeOffRows);

    offList.textContent = !timeOffRows.length
      ? "No time off in range."
      : timeOffRows
        .map((o) => `• ${o.service_date} slot ${o.slot_index} (${techById.get(String(o.tech_id))?.name || "Unknown tech"})`)
        .join("\n");
  } catch (e) {
    setText(topError, e.message || "Failed to render admin calendar.");
    show(topError, true);
  }
}

focusTech?.addEventListener("change", async (e) => {
  focusTechId = e.target.value;
  if (focusTechId !== "all") overlayAll = false;
  await render();
});

overlayAllBtn?.addEventListener("click", async () => {
  overlayAll = true;
  focusTechId = "all";
  if (focusTech) focusTech.value = "all";
  await render();
});

clearOverlayBtn?.addEventListener("click", async () => {
  overlayAll = false;
  if (focusTechId === "all" && techRows[0]) {
    focusTechId = String(techRows[0].id);
    if (focusTech) focusTech.value = focusTechId;
  }
  await render();
});

dayBtn?.addEventListener("click", async () => { viewMode = "day"; await render(); });
weekBtn?.addEventListener("click", async () => { viewMode = "week"; await render(); });
monthBtn?.addEventListener("click", async () => { viewMode = "month"; await render(); });

prevBtn?.addEventListener("click", async () => { shiftAnchor(-1); await render(); });
nextBtn?.addEventListener("click", async () => { shiftAnchor(1); await render(); });
todayBtn?.addEventListener("click", async () => { anchorDate = new Date(); await render(); });

// ---------- init ----------
async function main() {
  const session = await requireAdmin();
  if (!session) return;
  await loadTechs();
  await loadZoneAssignments();

  try {
    setText(sysNote, "Ensuring slots are populated 120 days ahead...");
    await populateSlotsToHorizon(120);
    setText(sysNote, "Slots checked and kept 120 days ahead.");
  } catch (e) {
    setText(sysNote, `Auto-populate skipped: ${e.message}`);
  }

  await render();
}

main();
