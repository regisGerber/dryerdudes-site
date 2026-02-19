import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and window.__SUPABASE_ANON_KEY__ in admin.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---------------- UI ----------------
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");

const viewDayBtn = document.getElementById("viewDayBtn");
const viewWeekBtn = document.getElementById("viewWeekBtn");
const viewMonthBtn = document.getElementById("viewMonthBtn");

const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const todayBtn = document.getElementById("todayBtn");
const refreshBtn = document.getElementById("refreshBtn");

const rangeLabel = document.getElementById("rangeLabel");
const calTable = document.getElementById("calTable");
const calError = document.getElementById("calError");

const focusTechSelect = document.getElementById("focusTechSelect");
const toggleAllBtn = document.getElementById("toggleAllBtn");
const clearOverlayBtn = document.getElementById("clearOverlayBtn");
const overlayHint = document.getElementById("overlayHint");

const statTotalJobs = document.getElementById("statTotalJobs");
const statCompleted = document.getElementById("statCompleted");
const statFullService = document.getElementById("statFullService");
const statCollected = document.getElementById("statCollected");
const statPartsNeeded = document.getElementById("statPartsNeeded");
const statReturnVisit = document.getElementById("statReturnVisit");
const statsHint = document.getElementById("statsHint");
const statsError = document.getElementById("statsError");

const timeOffList = document.getElementById("timeOffList");
const timeOffEmpty = document.getElementById("timeOffEmpty");
const timeOffError = document.getElementById("timeOffError");

const genOffersBtn = document.getElementById("genOffersBtn");
const offersNote = document.getElementById("offersNote");

// Modal
const modalBackdrop = document.getElementById("modalBackdrop");
const closeModalBtn = document.getElementById("closeModalBtn");
const addTimeOffBtn = document.getElementById("addTimeOffBtn");
const saveTimeOffBtn = document.getElementById("saveTimeOffBtn");
const saveTimeOffState = document.getElementById("saveTimeOffState");
const modalError = document.getElementById("modalError");
const modalTechHint = document.getElementById("modalTechHint");
const toDate = document.getElementById("toDate");
const toType = document.getElementById("toType");
const toStart = document.getElementById("toStart");
const toEnd = document.getElementById("toEnd");
const toReason = document.getElementById("toReason");
const customRow = document.getElementById("customRow");

// ---------------- State ----------------
let viewMode = "week"; // day | week | month
let cursorDate = new Date(); // "anchor" date for the view
let techs = []; // from techs table
let focusTechId = null; // techs.id (uuid)
let overlayTechIds = new Set(); // tech ids to overlay (empty = use focus)

// ---------------- Helpers ----------------
function show(el, on = true) { if (el) el.style.display = on ? "" : "none"; }
function setText(el, t) { if (el) el.textContent = t ?? ""; }

function tzNameSafe() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
  catch { return ""; }
}

function fmtShort(d) {
  return new Date(d).toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" });
}
function fmtLong(d) {
  return new Date(d).toLocaleDateString([], { weekday:"long", month:"short", day:"numeric", year:"numeric" });
}
function fmtTime(d) {
  return new Date(d).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });
}
function isoDateLocal(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth()+1).padStart(2,"0");
  const day = String(x.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function startOfDayLocal(d){
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0,0,0,0);
}
function addDays(d, n){
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeekMon(d){
  const x = startOfDayLocal(d);
  const dow = x.getDay(); // 0 Sun ... 6 Sat
  const diff = (dow === 0 ? -6 : 1 - dow); // move to Monday
  return addDays(x, diff);
}
function businessDaysMonFri(weekStartMon){
  return [0,1,2,3,4].map(i => addDays(weekStartMon, i));
}

function sumCents(rows, field){
  let s = 0;
  for (const r of rows) s += Number(r?.[field] || 0);
  return s;
}

function statusNorm(s){ return String(s||"").toLowerCase(); }

function overlaps(aStart, aEnd, bStart, bEnd){
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd).getTime();
  return as < be && bs < ae;
}

// Slot template (Mon–Fri, same as tech.js)
function buildDaySlots(dateObj) {
  const base = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0);

  function mk(h1, m1, h2, m2, label) {
    return {
      start: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h1, m1, 0),
      end: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h2, m2, 0),
      label
    };
  }

  return [
    mk(8, 0, 10, 0, "8:00–10:00"),     // A
    mk(8, 30, 10, 30, "8:30–10:30"),   // B
    mk(9, 30, 11, 30, "9:30–11:30"),   // C
    mk(10, 0, 12, 0, "10:00–12:00"),   // D
    mk(13, 0, 15, 0, "1:00–3:00"),     // E
    mk(13, 30, 15, 30, "1:30–3:30"),   // F
    mk(14, 30, 16, 30, "2:30–4:30"),   // G
    mk(15, 0, 17, 0, "3:00–5:00"),     // H
  ];
}

// ---------------- Auth / Admin gate ----------------
async function requireAdmin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "/login.html";
    return null;
  }

  setText(whoami, session.user?.email || "Signed in");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", session.user.id)
    .single();

  if (error) throw error;

  if (profile?.role !== "admin") {
    window.location.href = "/tech.html";
    return null;
  }

  return session;
}

async function logout() {
  await supabase.auth.signOut();
  window.location.href = "/login.html";
}
logoutBtn?.addEventListener("click", logout);

// ---------------- Data loading ----------------
async function loadTechs() {
  // Tech roster comes from techs table
  const { data, error } = await supabase
    .from("techs")
    .select("id,name,active,territory_notes,created_at")
    .order("created_at", { ascending: true });

  if (error) throw error;

  techs = (data || []).filter(t => t.active);
  if (!techs.length) throw new Error("No active techs found in techs table.");

  // default focus tech
  if (!focusTechId) focusTechId = techs[0].id;

  // populate focus dropdown
  focusTechSelect.innerHTML = "";
  for (const t of techs) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name || t.id;
    focusTechSelect.appendChild(opt);
  }
  focusTechSelect.value = focusTechId;
}

function selectedTechIdsForQuery() {
  // If overlay selected, use those; otherwise use focus tech only.
  const ids = overlayTechIds.size ? Array.from(overlayTechIds) : [focusTechId];
  // safety: never return empty
  return ids.filter(Boolean);
}

function getRangeForView() {
  const tz = tzNameSafe();

  if (viewMode === "day") {
    const start = startOfDayLocal(cursorDate);
    const end = addDays(start, 1);
    return { start, end, label: `${fmtLong(start)} • ${tz}` };
  }

  if (viewMode === "month") {
    // Month label; range query is entire month (but render Mon–Fri only)
    const d = new Date(cursorDate);
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 0,0,0,0);
    const end = new Date(d.getFullYear(), d.getMonth()+1, 1, 0,0,0,0);
    const label = `${start.toLocaleDateString([], { month:"long", year:"numeric" })} • ${tz}`;
    return { start, end, label };
  }

  // week
  const weekStart = startOfWeekMon(cursorDate);
  const start = weekStart;
  const end = addDays(weekStart, 7);
  const days = businessDaysMonFri(weekStart);
  const label = `${fmtLong(days[0])} – ${fmtShort(days[4])} • ${tz}`;
  return { start, end, label };
}

async function loadBookingsInRange(start, end, techIds) {
  // bookings.assigned_tech_id references techs.id in your current setup
  // (tech_time_off.tech_id also matches techs.id, so this aligns)
  let q = supabase
    .from("bookings")
    .select(`
      id,
      assigned_tech_id,
      window_start,
      window_end,
      status,
      appointment_type,
      collected_cents,
      full_service_cents,
      job_ref,
      request_id,
      booking_requests:request_id (
        id,
        name,
        phone,
        email,
        address,
        notes
      )
    `)
    .gte("window_start", start.toISOString())
    .lt("window_start", end.toISOString())
    .order("window_start", { ascending: true });

  if (techIds?.length) q = q.in("assigned_tech_id", techIds);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function loadTimeOffInRange(start, end, techIds) {
  let q = supabase
    .from("tech_time_off")
    .select("id,tech_id,start_ts,end_ts,reason,type,created_at")
    .gte("start_ts", addDays(start, -1).toISOString())
    .lt("end_ts", addDays(end, 1).toISOString())
    .order("start_ts", { ascending: true });

  if (techIds?.length) q = q.in("tech_id", techIds);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ---------------- Rendering ----------------
function setViewButtons() {
  const map = { day: viewDayBtn, week: viewWeekBtn, month: viewMonthBtn };
  for (const k of Object.keys(map)) {
    if (!map[k]) continue;
    map[k].style.opacity = (viewMode === k) ? "1" : "0.75";
  }
}

function renderOverlayHint() {
  const overlay = overlayTechIds.size ? `Overlay ON (${overlayTechIds.size} techs)` : "Overlay OFF (focused tech only)";
  const focusName = techs.find(t => t.id === focusTechId)?.name || focusTechId;
  setText(overlayHint, `${overlay}. Focus: ${focusName}`);
}

function renderStats(rows, rangeLabelText) {
  show(statsError, false);
  setText(statsError, "");

  const totalJobs = rows.length;
  const completed = rows.filter(r => statusNorm(r.status) === "completed").length;

  // Your bookings.appointment_type has "full_service"
  const fullService = rows.filter(r => statusNorm(r.appointment_type) === "full_service").length;

  // collected_cents already exists
  const collected = sumCents(rows, "collected_cents");

  // placeholders for future workflow (you said you want these statuses)
  const partsNeeded = rows.filter(r => statusNorm(r.status) === "parts_needed").length;
  const returnVisit = rows.filter(r => statusNorm(r.status) === "return_visit").length;

  setText(statsHint, rangeLabelText);

  setText(statTotalJobs, `Total jobs: ${totalJobs}`);
  setText(statCompleted, `Completed: ${completed}`);
  setText(statFullService, `Full service: ${fullService}`);
  setText(statCollected, `Collected: ${collected}¢`);
  setText(statPartsNeeded, `Parts needed: ${partsNeeded}`);
  setText(statReturnVisit, `Return visit: ${returnVisit}`);
}

function renderTimeOffLog(timeOffRows) {
  timeOffList.innerHTML = "";
  show(timeOffError, false);
  setText(timeOffError, "");

  if (!timeOffRows.length) {
    show(timeOffEmpty, true);
    return;
  }
  show(timeOffEmpty, false);

  for (const r of timeOffRows) {
    const techName = techs.find(t => t.id === r.tech_id)?.name || r.tech_id;
    const title = `${techName} — ${fmtShort(r.start_ts)} ${fmtTime(r.start_ts)}–${fmtTime(r.end_ts)}`;
    const meta = [
      r.type ? `Type: ${r.type}` : "",
      r.reason ? `Reason: ${r.reason}` : ""
    ].filter(Boolean).join("\n");

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="item-title"></div>
      <div class="item-meta"></div>
    `;
    div.querySelector(".item-title").textContent = title;
    div.querySelector(".item-meta").textContent = meta;

    timeOffList.appendChild(div);
  }
}

function cellSummaryForDay(bookingsForTech, dayDate, timeOffForTech) {
  const dayStart = startOfDayLocal(dayDate);
  const dayEnd = addDays(dayStart, 1);

  const todays = bookingsForTech.filter(b =>
    new Date(b.window_start) >= dayStart && new Date(b.window_start) < dayEnd
  );

  const completed = todays.filter(b => statusNorm(b.status) === "completed").length;
  const parts = todays.filter(b => statusNorm(b.status) === "parts_needed").length;
  const returnVisit = todays.filter(b => statusNorm(b.status) === "return_visit").length;

  const slots = buildDaySlots(dayDate);

  // count booked slots using overlap (more robust than exact match)
  const bookedCount = slots.filter(s =>
    todays.some(b => overlaps(s.start, s.end, b.window_start, b.window_end))
  ).length;

  // time off overlap detection
  const blockedCount = slots.filter(s =>
    timeOffForTech.some(t => overlaps(s.start, s.end, t.start_ts, t.end_ts))
  ).length;

  return { total: todays.length, bookedCount, blockedCount, completed, parts, returnVisit, todays };
}

function renderWeekCalendar(bookings, timeOffRows) {
  const weekStart = startOfWeekMon(cursorDate);
  const days = businessDaysMonFri(weekStart);

  // group bookings by tech
  const byTech = new Map();
  for (const b of bookings) {
    const tid = b.assigned_tech_id || "unassigned";
    if (!byTech.has(tid)) byTech.set(tid, []);
    byTech.get(tid).push(b);
  }

  // group time off by tech
  const toByTech = new Map();
  for (const t of timeOffRows) {
    if (!toByTech.has(t.tech_id)) toByTech.set(t.tech_id, []);
    toByTech.get(t.tech_id).push(t);
  }

  // which tech rows to render?
  const techIds = selectedTechIdsForQuery();
  const visibleTechs = techs.filter(t => techIds.includes(t.id));

  // table header
  calTable.innerHTML = "";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  const th0 = document.createElement("th");
  th0.textContent = "Tech";
  trh.appendChild(th0);

  for (const d of days) {
    const th = document.createElement("th");
    th.textContent = fmtShort(d);
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  calTable.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const t of visibleTechs) {
    const tr = document.createElement("tr");

    const tdTech = document.createElement("td");
    tdTech.innerHTML = `
      <div class="tech-name"></div>
      <div class="tech-meta"></div>
      <div class="pillline" style="margin-top:8px;"></div>
    `;
    tdTech.querySelector(".tech-name").textContent = t.name || t.id;
    tdTech.querySelector(".tech-meta").textContent = (t.territory_notes || "").trim();

    const controls = tdTech.querySelector(".pillline");
    // overlay toggle per tech
    const toggle = document.createElement("span");
    toggle.className = "tag click";
    toggle.textContent = overlayTechIds.has(t.id) ? "Overlay: ON" : "Overlay: OFF";
    toggle.addEventListener("click", () => {
      if (overlayTechIds.has(t.id)) overlayTechIds.delete(t.id);
      else overlayTechIds.add(t.id);
      renderOverlayHint();
      loadAndRender();
    });
    controls.appendChild(toggle);

    // focus shortcut
    const focus = document.createElement("span");
    focus.className = "tag click";
    focus.textContent = "Focus";
    focus.addEventListener("click", () => {
      focusTechId = t.id;
      focusTechSelect.value = focusTechId;
      overlayTechIds.clear();
      renderOverlayHint();
      loadAndRender();
    });
    controls.appendChild(focus);

    tr.appendChild(tdTech);

    const bookingsForTech = byTech.get(t.id) || [];
    const timeOffForTech = toByTech.get(t.id) || [];

    for (const d of days) {
      const td = document.createElement("td");
      const cell = document.createElement("div");
      cell.className = "cell";

      const s = cellSummaryForDay(bookingsForTech, d, timeOffForTech);

      const topLine = document.createElement("div");
      topLine.className = "pillline";

      const tag1 = document.createElement("span");
      tag1.className = "tag good";
      tag1.textContent = `${s.total} jobs`;
      topLine.appendChild(tag1);

      const tag2 = document.createElement("span");
      tag2.className = "tag muted";
      tag2.textContent = `${s.bookedCount}/8 booked`;
      topLine.appendChild(tag2);

      if (s.blockedCount > 0) {
        const tag3 = document.createElement("span");
        tag3.className = "tag bad";
        tag3.textContent = `${s.blockedCount} blocked`;
        topLine.appendChild(tag3);
      }

      cell.appendChild(topLine);

      // show a short list of bookings
      const list = document.createElement("div");
      list.className = "list";
      const preview = s.todays.slice(0, 3);

      for (const b of preview) {
        const req = b.booking_requests || {};
        const it = document.createElement("div");
        it.className = "item";
        it.innerHTML = `<div class="item-title"></div><div class="item-meta"></div>`;
        it.querySelector(".item-title").textContent = `${fmtTime(b.window_start)}–${fmtTime(b.window_end)} • ${req.name || "Customer"}`;
        it.querySelector(".item-meta").textContent = [
          req.address || "",
          b.job_ref ? `Job: ${b.job_ref}` : "",
          b.status ? `Status: ${b.status}` : ""
        ].filter(Boolean).join("\n");
        list.appendChild(it);
      }

      if (s.todays.length > 3) {
        const more = document.createElement("div");
        more.className = "tiny";
        more.textContent = `+ ${s.todays.length - 3} more`;
        list.appendChild(more);
      }

      cell.appendChild(list);

      td.appendChild(cell);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  calTable.appendChild(tbody);
}

function renderDayCalendar(bookings, timeOffRows) {
  // Day view = show one day (Mon–Fri doesn’t apply, but you’ll usually look at weekdays)
  // We render a simplified list per tech selected.
  calTable.innerHTML = "";

  const day = startOfDayLocal(cursorDate);
  const slots = buildDaySlots(day);

  const techIds = selectedTechIdsForQuery();
  const visibleTechs = techs.filter(t => techIds.includes(t.id));

  const byTech = new Map();
  for (const b of bookings) {
    const tid = b.assigned_tech_id || "unassigned";
    if (!byTech.has(tid)) byTech.set(tid, []);
    byTech.get(tid).push(b);
  }
  const toByTech = new Map();
  for (const t of timeOffRows) {
    if (!toByTech.has(t.tech_id)) toByTech.set(t.tech_id, []);
    toByTech.get(t.tech_id).push(t);
  }

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  ["Tech", ...slots.map(s => s.label)].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  calTable.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const t of visibleTechs) {
    const tr = document.createElement("tr");

    const tdTech = document.createElement("td");
    tdTech.innerHTML = `<div class="tech-name"></div><div class="tech-meta"></div>`;
    tdTech.querySelector(".tech-name").textContent = t.name || t.id;
    tdTech.querySelector(".tech-meta").textContent = (t.territory_notes || "").trim();
    tr.appendChild(tdTech);

    const rows = byTech.get(t.id) || [];
    const tos = toByTech.get(t.id) || [];

    for (const slot of slots) {
      const td = document.createElement("td");
      const cell = document.createElement("div");
      cell.className = "cell";

      const blocked = tos.some(x => overlaps(slot.start, slot.end, x.start_ts, x.end_ts));
      const booked = rows.filter(b => overlaps(slot.start, slot.end, b.window_start, b.window_end));

      const line = document.createElement("div");
      line.className = "pillline";

      const t1 = document.createElement("span");
      t1.className = "tag " + (blocked ? "bad" : booked.length ? "good" : "muted");
      t1.textContent = blocked ? "BLOCKED" : booked.length ? `${booked.length} booked` : "open";
      line.appendChild(t1);

      cell.appendChild(line);

      if (booked.length) {
        const req = booked[0].booking_requests || {};
        const meta = document.createElement("div");
        meta.className = "tiny";
        meta.textContent = `${req.name || "Customer"} • ${booked[0].job_ref || ""}`.trim();
        cell.appendChild(meta);
      }

      td.appendChild(cell);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  calTable.appendChild(tbody);
}

function renderMonthCalendar(bookings, timeOffRows) {
  // Minimal month: render week rows, Mon–Fri only, with totals per day across selected tech(s).
  // (This is intentionally simple — month views can get huge fast.)
  calTable.innerHTML = "";

  const d = new Date(cursorDate);
  const first = new Date(d.getFullYear(), d.getMonth(), 1, 0,0,0,0);
  const last = new Date(d.getFullYear(), d.getMonth()+1, 0, 0,0,0,0);

  // start on Monday of the week containing the 1st
  let cur = startOfWeekMon(first);

  // Map counts by local date string
  const counts = new Map();
  for (const b of bookings) {
    const key = isoDateLocal(new Date(b.window_start));
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  const th0 = document.createElement("th");
  th0.textContent = "Week";
  trh.appendChild(th0);
  ["Mon","Tue","Wed","Thu","Fri"].forEach(x => {
    const th = document.createElement("th");
    th.textContent = x;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  calTable.appendChild(thead);

  const tbody = document.createElement("tbody");

  // go week by week until past last day
  while (cur <= addDays(last, 1)) {
    const weekRow = document.createElement("tr");

    const weekCell = document.createElement("td");
    weekCell.innerHTML = `<div class="tech-name"></div><div class="tech-meta"></div>`;
    weekCell.querySelector(".tech-name").textContent = `Week of ${fmtShort(cur)}`;
    weekCell.querySelector(".tech-meta").textContent = "";
    weekRow.appendChild(weekCell);

    const days = businessDaysMonFri(cur);
    for (const day of days) {
      const td = document.createElement("td");
      const cell = document.createElement("div");
      cell.className = "cell";

      const inMonth = (day.getMonth() === d.getMonth());
      const key = isoDateLocal(day);
      const c = counts.get(key) || 0;

      const t1 = document.createElement("span");
      t1.className = "tag " + (inMonth ? (c ? "good" : "muted") : "muted");
      t1.textContent = inMonth ? `${day.getDate()} • ${c} jobs` : `${day.getDate()}`;
      cell.appendChild(t1);

      td.appendChild(cell);
      weekRow.appendChild(td);
    }

    tbody.appendChild(weekRow);
    cur = addDays(cur, 7);
  }

  calTable.appendChild(tbody);
}

// ---------------- Time off modal ----------------
function openModal() {
  show(modalError, false);
  setText(modalError, "");

  const techName = techs.find(t => t.id === focusTechId)?.name || focusTechId;
  setText(modalTechHint, `Applies to: ${techName} (focus tech)`);

  // default date = cursor date
  toDate.value = isoDateLocal(cursorDate);
  toType.value = "day";
  show(customRow, false);
  toReason.value = "";
  setText(saveTimeOffState, "");

  modalBackdrop.style.display = "flex";
}
function closeModal() {
  modalBackdrop.style.display = "none";
}
closeModalBtn?.addEventListener("click", closeModal);
modalBackdrop?.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});
addTimeOffBtn?.addEventListener("click", () => openModal());

toType?.addEventListener("change", () => {
  show(customRow, toType.value === "custom");
});

function makeRangeForTimeOff(dateStr, type, startTime, endTime) {
  // Build local timestamps, then send as ISO (Supabase timestamptz)
  const [y,m,d] = dateStr.split("-").map(Number);
  const base = new Date(y, m-1, d, 0,0,0,0);

  if (type === "day") {
    return { start: new Date(y, m-1, d, 8,0,0), end: new Date(y, m-1, d, 17,0,0) };
  }
  if (type === "am") {
    return { start: new Date(y, m-1, d, 8,0,0), end: new Date(y, m-1, d, 12,0,0) };
  }
  if (type === "pm") {
    return { start: new Date(y, m-1, d, 13,0,0), end: new Date(y, m-1, d, 17,0,0) };
  }

  // custom
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, sm, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), eh, em, 0);
  return { start, end };
}

async function saveTimeOff() {
  show(modalError, false);
  setText(modalError, "");
  setText(saveTimeOffState, "Saving…");

  try {
    if (!focusTechId) throw new Error("No focus tech selected.");
    if (!toDate.value) throw new Error("Pick a date.");

    const type = toType.value;
    const { start, end } = makeRangeForTimeOff(toDate.value, type, toStart.value, toEnd.value);

    if (!(start < end)) throw new Error("Start must be before end.");

    const payload = {
      tech_id: focusTechId,
      start_ts: start.toISOString(),
      end_ts: end.toISOString(),
      reason: toReason.value || null,
      type: type
    };

    const { error } = await supabase.from("tech_time_off").insert(payload);
    if (error) throw error;

    setText(saveTimeOffState, "Saved.");
    setTimeout(() => setText(saveTimeOffState, ""), 1200);
    closeModal();
    await loadAndRender();
  } catch (e) {
    console.error(e);
    setText(saveTimeOffState, "");
    show(modalError, true);
    setText(modalError, e?.message || String(e));
  }
}
saveTimeOffBtn?.addEventListener("click", saveTimeOff);

// ---------------- Main render ----------------
async function loadAndRender() {
  show(calError, false);
  setText(calError, "");
  show(statsError, false);
  setText(statsError, "");
  show(timeOffError, false);
  setText(timeOffError, "");

  renderOverlayHint();

  const { start, end, label } = getRangeForView();
  setText(rangeLabel, label);

  const techIds = selectedTechIdsForQuery();

  try {
    const [bookings, timeOffRows] = await Promise.all([
      loadBookingsInRange(start, end, techIds),
      loadTimeOffInRange(start, end, techIds)
    ]);

    renderStats(bookings, label);
    renderTimeOffLog(timeOffRows);

    if (viewMode === "week") renderWeekCalendar(bookings, timeOffRows);
    else if (viewMode === "day") renderDayCalendar(bookings, timeOffRows);
    else renderMonthCalendar(bookings, timeOffRows);
  } catch (e) {
    console.error(e);
    show(calError, true);
    setText(calError, `Load failed: ${e?.message || e}`);
  }
}

// ---------------- Controls ----------------
function setView(mode) {
  viewMode = mode;
  setViewButtons();
  loadAndRender();
}
viewDayBtn?.addEventListener("click", () => setView("day"));
viewWeekBtn?.addEventListener("click", () => setView("week"));
viewMonthBtn?.addEventListener("click", () => setView("month"));

function moveCursor(delta) {
  if (viewMode === "day") cursorDate = addDays(cursorDate, delta);
  else if (viewMode === "week") cursorDate = addDays(cursorDate, delta * 7);
  else {
    const d = new Date(cursorDate);
    d.setMonth(d.getMonth() + delta);
    cursorDate = d;
  }
  loadAndRender();
}
prevBtn?.addEventListener("click", () => moveCursor(-1));
nextBtn?.addEventListener("click", () => moveCursor(1));
todayBtn?.addEventListener("click", () => { cursorDate = new Date(); loadAndRender(); });
refreshBtn?.addEventListener("click", () => loadAndRender());

focusTechSelect?.addEventListener("change", () => {
  focusTechId = focusTechSelect.value;
  overlayTechIds.clear();
  renderOverlayHint();
  loadAndRender();
});

toggleAllBtn?.addEventListener("click", () => {
  // Overlay all visible techs
  overlayTechIds = new Set(techs.map(t => t.id));
  renderOverlayHint();
  loadAndRender();
});
clearOverlayBtn?.addEventListener("click", () => {
  overlayTechIds.clear();
  renderOverlayHint();
  loadAndRender();
});

// Offers generator: UI stub (needs your booking_request_offers schema)
genOffersBtn?.addEventListener("click", async () => {
  setText(offersNote, "I need the booking_request_offers table columns to implement generation safely. See note below.");
});

// ---------------- Init ----------------
async function main() {
  try {
    await requireAdmin();
    await loadTechs();

    setViewButtons();
    renderOverlayHint();

    // default view = week
    viewMode = "week";
    setViewButtons();

    // helpful note for offers
    setText(offersNote, "Offer generation is not implemented yet in this build (schema needed).");

    await loadAndRender();
  } catch (e) {
    console.error(e);
    show(calError, true);
    setText(calError, e?.message || String(e));
  }
}

main();
