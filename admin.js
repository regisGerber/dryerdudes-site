import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and window.__SUPABASE_ANON_KEY__ in admin.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

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

const kTotal = document.getElementById("kTotal");
const kCompleted = document.getElementById("kCompleted");
const kFullService = document.getElementById("kFullService");
const kCollected = document.getElementById("kCollected");
const kReturn = document.getElementById("kReturn");
const kParts = document.getElementById("kParts");

const offReason = document.getElementById("offReason");
const addOffBtn = document.getElementById("addOffBtn");
const offList = document.getElementById("offList");

const genOffersStubBtn = document.getElementById("genOffersStubBtn");
const sysNote = document.getElementById("sysNote");

// ---------- helpers ----------
function show(el, on = true) { if (el) el.style.display = on ? "" : "none"; }
function setText(el, t) { if (el) el.textContent = t ?? ""; }
function fmtDay(d) {
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function fmtTimeLabel(h1, m1, h2, m2) {
  const pad = n => String(n).padStart(2, "0");
  const a = `${h1}:${pad(m1)}`;
  const b = `${h2}:${pad(m2)}`;
  return `${a}–${b}`;
}
function toISODate(d){ return d.toISOString().slice(0,10); }

function tzNameSafe() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
  catch { return ""; }
}

// Same 8 slots you use everywhere
function buildDaySlots(dateObj) {
  const base = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0);
  function mk(h1,m1,h2,m2, label, idx){
    return {
      slot_index: idx,
      label,
      start: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h1, m1, 0),
      end: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h2, m2, 0),
      start_h: h1, start_m: m1, end_h: h2, end_m: m2
    };
  }
  return [
    mk(8,0,10,0,  "A", 1),
    mk(8,30,10,30,"B", 2),
    mk(9,30,11,30,"C", 3),
    mk(10,0,12,0, "D", 4),
    mk(13,0,15,0, "E", 5),
    mk(13,30,15,30,"F", 6),
    mk(14,30,16,30,"G", 7),
    mk(15,0,17,0, "H", 8),
  ];
}

function overlaps(aStart, aEnd, bStart, bEnd){
  return aStart < bEnd && bStart < aEnd;
}

// ---------- auth ----------
async function requireAdmin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "/login.html";
    return null;
  }

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
  setText(whoami, session.user.email || "Signed in");
  return session;
}

logoutBtn?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.href = "/login.html";
});

// ---------- state ----------
let viewMode = "week"; // day | week | month (month is placeholder v1)
let overlayAll = true;
let focusTechId = "all"; // techs.id, or "all"
let anchorDate = new Date(); // the date we’re “on”

let techRows = []; // {id,name,active,territory_notes,user_id}

// ---------- load techs ----------
async function loadTechs() {
  const { data, error } = await supabase
    .from("techs")
    .select("id,name,active,territory_notes,user_id")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) throw error;
  techRows = data || [];

  // dropdown
  focusTech.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "Focus tech: (All)";
  focusTech.appendChild(optAll);

  for (const t of techRows) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = `Focus tech: ${t.name}`;
    focusTech.appendChild(o);
  }

  // if only 1 tech, default focus = that tech but keep overlayAll true
  if (techRows.length === 1) {
    focusTechId = techRows[0].id;
    focusTech.value = techRows[0].id;
  } else {
    focusTech.value = "all";
  }
}

focusTech?.addEventListener("change", () => {
  focusTechId = focusTech.value || "all";
  render();
});

overlayAllBtn?.addEventListener("click", () => {
  overlayAll = true;
  render();
});
clearOverlayBtn?.addEventListener("click", () => {
  overlayAll = false;
  render();
});

// ---------- range logic ----------
function startOfWeekMon(d){
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay(); // 0 Sun..6 Sat
  const diff = (day === 0 ? -6 : 1) - day; // move to Monday
  x.setDate(x.getDate() + diff);
  return x;
}

function getRangeForView(){
  const tz = tzNameSafe();
  if (viewMode === "day") {
    const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(), 0,0,0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { start, end, label: `${fmtDay(start)} • ${tz}` };
  }
  if (viewMode === "month") {
    const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1, 0,0,0);
    const end = new Date(anchorDate.getFullYear(), anchorDate.getMonth()+1, 1, 0,0,0);
    return { start, end, label: `${start.toLocaleDateString([], { month:"long", year:"numeric" })} • ${tz}` };
  }
  // week (Mon-Fri display but range includes Mon..Sat for queries)
  const mon = startOfWeekMon(anchorDate);
  const end = new Date(mon); end.setDate(end.getDate() + 7);
  const fri = new Date(mon); fri.setDate(fri.getDate() + 4);
  return { start: mon, end, label: `${fmtDay(mon)} – ${fmtDay(fri)} • ${tz}` };
}

function setViewMode(m){
  viewMode = m;
  render();
}
dayBtn?.addEventListener("click", () => setViewMode("day"));
weekBtn?.addEventListener("click", () => setViewMode("week"));
monthBtn?.addEventListener("click", () => setViewMode("month"));

prevBtn?.addEventListener("click", () => {
  if (viewMode === "day") anchorDate.setDate(anchorDate.getDate() - 1);
  else if (viewMode === "week") anchorDate.setDate(anchorDate.getDate() - 7);
  else anchorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() - 1, 1);
  render();
});

nextBtn?.addEventListener("click", () => {
  if (viewMode === "day") anchorDate.setDate(anchorDate.getDate() + 1);
  else if (viewMode === "week") anchorDate.setDate(anchorDate.getDate() + 7);
  else anchorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1);
  render();
});

todayBtn?.addEventListener("click", () => {
  anchorDate = new Date();
  render();
});

// ---------- data loads ----------
function selectedTechUserIds(){
  // If overlayAll => all tech user_ids
  // If focusTechId != all => that tech's user_id
  // Note: bookings.assigned_tech_id stores auth user id, per your tech.js.
  const rows = techRows.filter(t => t.user_id);
  if (overlayAll || focusTechId === "all") return rows.map(t => t.user_id);
  const t = techRows.find(x => x.id === focusTechId);
  return t?.user_id ? [t.user_id] : [];
}

async function loadBookings(start, end){
  // bookings + customer
  // If there are no mapped tech user_ids yet, we still load ALL bookings in range,
  // because otherwise the admin page looks empty and confusing.
  const techUserIds = selectedTechUserIds();

  let q = supabase
    .from("bookings")
    .select(`
      id,
      window_start,
      window_end,
      status,
      appointment_type,
      zone_code,
      route_zone_code,
      collected_cents,
      full_service_cents,
      assigned_tech_id,
      booking_requests:request_id ( id, name, address, phone )
    `)
    .gte("window_start", start.toISOString())
    .lt("window_start", end.toISOString())
    .order("window_start", { ascending: true });

  if (techUserIds.length) q = q.in("assigned_tech_id", techUserIds);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function loadTimeOff(start, end){
  // tech_time_off: id bigint, tech_id uuid, start_ts, end_ts, reason, type, created_at
  // filter by range overlap
  const { data, error } = await supabase
    .from("tech_time_off")
    .select("id,tech_id,start_ts,end_ts,reason,type,created_at")
    .gte("end_ts", start.toISOString())
    .lte("start_ts", end.toISOString())
    .order("start_ts", { ascending: true });

  // If your tech_time_off table is empty, this still works.
  if (error) throw error;
  return data || [];
}

// ---------- render ----------
function slotDiv({ kind, title, meta, badgeText }) {
  const d = document.createElement("div");
  d.className = `slot ${kind}`;

  const t = document.createElement("div");
  t.className = "slot-title";
  t.textContent = title;

  const m = document.createElement("div");
  m.className = "slot-meta";
  m.textContent = meta || "";

  const bwrap = document.createElement("div");
  if (badgeText) {
    const b = document.createElement("span");
    b.className = `badge ${kind === "open" ? "gray" : ""}`;
    b.textContent = badgeText;
    bwrap.appendChild(b);
  }
  d.appendChild(bwrap);
  d.appendChild(t);
  d.appendChild(m);
  return d;
}

function statusLabel(s){
  const v = String(s || "").toLowerCase();
  return v || "scheduled";
}

function computeStats(bookings){
  const total = bookings.length;
  const completed = bookings.filter(b => String(b.status||"").toLowerCase() === "completed").length;
  const fullService = bookings.filter(b => String(b.appointment_type||"").toLowerCase() === "full_service").length;

  const collected = bookings.reduce((sum,b) => sum + (Number(b.collected_cents)||0), 0);

  // placeholders for future statuses
  const parts = bookings.filter(b => String(b.status||"").toLowerCase() === "parts_needed").length;
  const ret = bookings.filter(b => String(b.status||"").toLowerCase() === "return_visit").length;

  setText(kTotal, total);
  setText(kCompleted, completed);
  setText(kFullService, fullService);
  setText(kCollected, collected);
  setText(kParts, parts);
  setText(kReturn, ret);
}

function renderWeekGrid(monDate, bookings, timeOffRows){
  const days = [];
  for (let i=0; i<5; i++){
    const d = new Date(monDate);
    d.setDate(d.getDate() + i);
    days.push(d);
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");

  const th0 = document.createElement("th");
  th0.className = "timecol";
  th0.textContent = "Slots";
  hr.appendChild(th0);

  for (const d of days){
    const th = document.createElement("th");
    th.textContent = fmtDay(d);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const slots = buildDaySlots(monDate);

  // index bookings by date+slot exact match (within 1min tolerance)
  function matchesSlot(slot, b){
    const s = slot.start.getTime(), e = slot.end.getTime();
    const bs = new Date(b.window_start).getTime();
    const be = new Date(b.window_end).getTime();
    return Math.abs(bs - s) <= 60_000 && Math.abs(be - e) <= 60_000;
  }

  for (const slot of slots){
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.className = "timecol";
    tdTime.textContent = `${slot.label} • ${fmtTimeLabel(slot.start_h,slot.start_m,slot.end_h,slot.end_m)}`;
    tr.appendChild(tdTime);

    for (const d of days){
      const td = document.createElement("td");
      const slotsForDay = buildDaySlots(d);
      const sameIdx = slotsForDay.find(s => s.slot_index === slot.slot_index);

      const dayBookings = bookings.filter(b => matchesSlot(sameIdx, b));
      const dayOff = timeOffRows.filter(o => {
        if (!o.start_ts || !o.end_ts) return false;
        // If focused on one tech (and not overlayAll) we only show that tech's time off.
        // Otherwise show any tech off as “OFF exists” (still useful).
        const focusTech = techRows.find(x => x.id === focusTechId);
        const onlyTech = (!overlayAll && focusTechId !== "all" && focusTech) ? focusTech.id : null;

        if (onlyTech && o.tech_id !== onlyTech) return false;

        const os = new Date(o.start_ts).getTime();
        const oe = new Date(o.end_ts).getTime();
        return overlaps(sameIdx.start.getTime(), sameIdx.end.getTime(), os, oe);
      });

      if (dayOff.length) {
        const reason = dayOff[0]?.reason ? `Reason: ${dayOff[0].reason}` : "";
        const div = slotDiv({
          kind: "off",
          badgeText: "OFF",
          title: "Time off",
          meta: reason
        });
        td.appendChild(div);

        // click to toggle off (v1: remove first matching row)
        td.style.cursor = "pointer";
        td.addEventListener("click", () => toggleOffForSlot(d, sameIdx, dayOff[0]));
      } else if (dayBookings.length) {
        // if overlayAll, show count; if focus, show details
        if (overlayAll || focusTechId === "all") {
          const div = slotDiv({
            kind: "booked",
            badgeText: `${dayBookings.length} booked`,
            title: "Booked",
            meta: dayBookings.map(b => {
              const name = b.booking_requests?.name || "Customer";
              const z = b.route_zone_code || b.zone_code || "";
              return `${name}${z ? ` • Zone ${z}` : ""} • ${statusLabel(b.status)}`;
            }).join("\n")
          });
          td.appendChild(div);
        } else {
          const b = dayBookings[0];
          const name = b.booking_requests?.name || "Customer";
          const addr = b.booking_requests?.address || "";
          const z = b.route_zone_code || b.zone_code || "";
          const div = slotDiv({
            kind: "booked",
            badgeText: statusLabel(b.status),
            title: `${name}${z ? ` • Zone ${z}` : ""}`,
            meta: addr
          });
          td.appendChild(div);
        }
      } else {
        const div = slotDiv({
          kind: "open",
          badgeText: "Open",
          title: "Not booked",
          meta: ""
        });
        td.appendChild(div);

        td.style.cursor = "pointer";
        td.addEventListener("click", () => toggleOffForSlot(d, sameIdx, null));
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
}

function renderDayGrid(dayDate, bookings, timeOffRows){
  // Day view: just render week grid but with 1 day column
  const mon = startOfWeekMon(dayDate);
  // reuse week renderer but anchor only that day by temporarily building a 1-day week
  // simplest: render week and let you use day view later; v1 keep it as week with highlight
  renderWeekGrid(mon, bookings, timeOffRows);
}

function renderMonthStub(){
  calWrap.innerHTML = "";
  const d = document.createElement("div");
  d.className = "tiny";
  d.style.padding = "16px";
  d.textContent = "Month view placeholder (v1). Week + Day are the real operational views. We can add month grid after week/day feel right.";
  calWrap.appendChild(d);
}

// ---------- time off toggle (v1) ----------
async function toggleOffForSlot(dayDate, slot, existingRow){
  try {
    show(topError, false); setText(topError, "");

    const focusTech = techRows.find(x => x.id === focusTechId);

    if (overlayAll || focusTechId === "all" || !focusTech) {
      show(topError, true);
      setText(topError, "To edit time off, pick a single tech (Focus tech dropdown) and Clear overlay.");
      return;
    }

    if (!focusTech.id) throw new Error("Missing tech id");

    if (existingRow?.id) {
      // remove
      const { error } = await supabase.from("tech_time_off").delete().eq("id", existingRow.id);
      if (error) throw error;
    } else {
      // insert new off block for this slot
      const reason = (offReason?.value || "").trim() || null;
      const payload = {
        tech_id: focusTech.id,
        start_ts: slot.start.toISOString(),
        end_ts: slot.end.toISOString(),
        reason,
        type: "slot" // optional label
      };
      const { error } = await supabase.from("tech_time_off").insert(payload);
      if (error) throw error;
    }

    await render(); // reload everything
  } catch (e) {
    console.error(e);
    show(topError, true);
    setText(topError, `Time off update failed: ${e?.message || e}`);
  }
}

addOffBtn?.addEventListener("click", async () => {
  // v1: button just instructs user; slot-click is the action
  setText(offList, "Tip: Click a slot cell to toggle OFF for that slot. (Focus a single tech + Clear overlay first.)");
});

// ---------- time off list ----------
function renderTimeOffList(rows, start, end){
  if (!rows.length) {
    offList.textContent = "No time off in this range.";
    return;
  }

  const lines = rows.map(r => {
    const s = new Date(r.start_ts).toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
    const e = new Date(r.end_ts).toLocaleString([], { hour:"numeric", minute:"2-digit" });
    const techName = techRows.find(t => t.id === r.tech_id)?.name || r.tech_id;
    return `• ${techName}: ${s}–${e}${r.reason ? ` • ${r.reason}` : ""}`;
  });

  offList.textContent = lines.join("\n");
}

// ---------- stub system tool ----------
genOffersStubBtn?.addEventListener("click", () => {
  setText(sysNote, "Stub only. We’ll wire this after we find what currently populates booking_request_offers.");
});

// ---------- main render ----------
async function render(){
  show(topError, false); setText(topError, "");
  const { start, end, label } = getRangeForView();
  setText(rangeLabel, label);

  // Visual indicator for buttons
  const setOp = (btn, on) => { if (btn) btn.style.opacity = on ? "1" : "0.75"; };
  setOp(dayBtn, viewMode === "day");
  setOp(weekBtn, viewMode === "week");
  setOp(monthBtn, viewMode === "month");

  setOp(overlayAllBtn, overlayAll);
  setOp(clearOverlayBtn, !overlayAll);

  try {
    const [bookings, timeOffRows] = await Promise.all([
      loadBookings(start, end),
      loadTimeOff(start, end)
    ]);

    computeStats(bookings);
    renderTimeOffList(timeOffRows, start, end);

    if (viewMode === "month") {
      renderMonthStub();
    } else if (viewMode === "day") {
      renderDayGrid(anchorDate, bookings, timeOffRows);
    } else {
      const mon = startOfWeekMon(anchorDate);
      renderWeekGrid(mon, bookings, timeOffRows);
    }
  } catch (e) {
    console.error(e);
    show(topError, true);
    setText(topError, `Load failed: ${e?.message || e}`);
  }
}

// ---------- init ----------
async function main(){
  const session = await requireAdmin();
  if (!session) return;

  await loadTechs();

  // Default view = week
  viewMode = "week";
  overlayAll = true;

  await render();
}

main();
