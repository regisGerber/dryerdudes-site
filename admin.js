import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey || String(supabaseAnonKey).includes("PASTE_YOUR_ANON_KEY_HERE")) {
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
const refreshBtn = document.getElementById("refreshBtn");

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

// Job list
const jobList = document.getElementById("jobList");
const jobListTitle = document.getElementById("jobListTitle");
const jobListEmpty = document.getElementById("jobListEmpty");

// Job modal
const jobModal = document.getElementById("jobModal");
const jmTitle = document.getElementById("jmTitle");
const jmMeta = document.getElementById("jmMeta");
const jmActions = document.getElementById("jmActions");
const jmCloseBtn = document.getElementById("jmCloseBtn");
const jmError = document.getElementById("jmError");

// Off modal
const offModal = document.getElementById("offModal");
const offCloseBtn = document.getElementById("offCloseBtn");
const offSaveBtn = document.getElementById("offSaveBtn");
const offDeleteBtn = document.getElementById("offDeleteBtn");
const offModalMeta = document.getElementById("offModalMeta");
const offModalHint = document.getElementById("offModalHint");
const offModalError = document.getElementById("offModalError");
const offDate = document.getElementById("offDate");
const offPreset = document.getElementById("offPreset");
const offStart = document.getElementById("offStart");
const offEnd = document.getElementById("offEnd");
const offReasonModal = document.getElementById("offReasonModal");

// ---------- helpers ----------
function show(el, on = true) { if (el) el.style.display = on ? "" : "none"; }
function setText(el, t) { if (el) el.textContent = t ?? ""; }

function tzNameSafe() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
  catch { return ""; }
}

function fmtDay(d) {
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function fmtTime(d) {
  return new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtDateTime(d) {
  return new Date(d).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtTimeLabel(h1, m1, h2, m2) {
  const pad = n => String(n).padStart(2, "0");
  return `${h1}:${pad(m1)}–${h2}:${pad(m2)}`;
}

function toISODate(d){ return d.toISOString().slice(0,10); }

function overlaps(aStart, aEnd, bStart, bEnd){
  return aStart < bEnd && bStart < aEnd;
}

function statusLabel(s){
  const v = String(s || "").toLowerCase();
  return v || "scheduled";
}

function cleanPhone(p) {
  if (!p) return "";
  return String(p).replace(/[^\d+]/g, "");
}

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || "")}`;
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

function startOfWeekMon(d){
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay(); // 0 Sun..6 Sat
  const diff = (day === 0 ? -6 : 1) - day; // move to Monday
  x.setDate(x.getDate() + diff);
  return x;
}

function parseZoneLogic(territory_notes){
  const out = {};
  const s = String(territory_notes || "");
  const re = /\b(Mon|Tue|Wed|Thu|Fri)\s*=\s*([A-Z]|ignore)\b/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function slotDiv({ kind, title, meta, badgeText }) {
  const d = document.createElement("div");
  d.className = `slot ${kind}`;

  const bwrap = document.createElement("div");
  if (badgeText) {
    const b = document.createElement("span");
    b.className = `badge ${kind === "open" ? "gray" : ""}`;
    b.textContent = badgeText;
    bwrap.appendChild(b);
  }

  const t = document.createElement("div");
  t.className = "slot-title";
  t.textContent = title;

  const m = document.createElement("div");
  m.className = "slot-meta";
  m.textContent = meta || "";

  d.appendChild(bwrap);
  d.appendChild(t);
  d.appendChild(m);
  return d;
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
let viewMode = "week"; // day | week | month
let overlayAll = true;
let focusTechId = "all"; // techs.id, or "all"
let anchorDate = new Date(); // the date we’re “on”
let techRows = []; // {id,name,active,territory_notes,user_id}
let lastBookings = [];
let lastTimeOff = [];
let lastRange = null;

// Off modal state
let offModalSelectedExisting = null; // if opened for deletion

// ---------- load techs ----------
async function loadTechs() {
  const { data, error } = await supabase
    .from("techs")
    .select("id,name,active,territory_notes,user_id,created_at")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) throw error;
  techRows = data || [];

  focusTech.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "All techs";
  focusTech.appendChild(optAll);

  for (const t of techRows) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.name || t.id;
    focusTech.appendChild(o);
  }

  // Default: All techs + Overlay All
  focusTechId = "all";
  focusTech.value = "all";
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

refreshBtn?.addEventListener("click", () => render(true));

// ---------- data loads ----------
function selectedTechRows(){
  if (overlayAll || focusTechId === "all") return techRows;
  const t = techRows.find(x => x.id === focusTechId);
  return t ? [t] : [];
}

function selectedTechUserIds(){
  // bookings.assigned_tech_id stores auth user id
  const rows = selectedTechRows().filter(t => t.user_id);
  return rows.map(t => t.user_id);
}

async function loadBookings(start, end){
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
      job_ref,
      booking_requests:request_id ( id, name, address, phone, email, notes )
    `)
    .gte("window_start", start.toISOString())
    .lt("window_start", end.toISOString())
    .order("window_start", { ascending: true });

  // If user_id mapping exists, filter. Otherwise load all (so it doesn't look empty).
  if (techUserIds.length) q = q.in("assigned_tech_id", techUserIds);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function loadTimeOff(start, end){
  // overlap: end_ts > start AND start_ts < end
  const { data, error } = await supabase
    .from("tech_time_off")
    .select("id,tech_id,start_ts,end_ts,reason,type,created_at")
    .gt("end_ts", start.toISOString())
    .lt("start_ts", end.toISOString())
    .order("start_ts", { ascending: true });

  if (error) throw error;
  return data || [];
}

// ---------- stats ----------
function computeStats(bookings){
  const total = bookings.length;
  const completed = bookings.filter(b => String(b.status||"").toLowerCase() === "completed").length;
  const fullService = bookings.filter(b => String(b.appointment_type||"").toLowerCase() === "full_service").length;
  const collected = bookings.reduce((sum,b) => sum + (Number(b.collected_cents)||0), 0);

  const parts = bookings.filter(b => String(b.status||"").toLowerCase() === "parts_needed").length;
  const ret = bookings.filter(b => String(b.status||"").toLowerCase() === "return_visit").length;

  setText(kTotal, total);
  setText(kCompleted, completed);
  setText(kFullService, fullService);
  setText(kCollected, collected);
  setText(kParts, parts);
  setText(kReturn, ret);
}

// ---------- job modal ----------
function closeJobModal(){ show(jobModal, false); }
jmCloseBtn?.addEventListener("click", closeJobModal);
jobModal?.addEventListener("click", (e) => { if (e.target === jobModal) closeJobModal(); });

function openJobModal(booking, labelPrefix = ""){
  show(jmError, false); setText(jmError, "");
  const req = booking.booking_requests || {};
  const z = booking.route_zone_code || booking.zone_code || "";

  const title = `${req.name || "Customer"} — ${fmtDateTime(booking.window_start)}–${fmtTime(booking.window_end)}`;
  setText(jmTitle, labelPrefix ? `${labelPrefix} ${title}` : title);

  const lines = [];
  if (req.address) lines.push(`Address: ${req.address}`);
  if (req.phone) lines.push(`Phone: ${req.phone}`);
  if (req.email) lines.push(`Email: ${req.email}`);
  if (z) lines.push(`Zone: ${z}`);
  if (booking.appointment_type) lines.push(`Type: ${booking.appointment_type}`);
  if (booking.status) lines.push(`Status: ${booking.status}`);
  if (booking.job_ref) lines.push(`Job ref: ${booking.job_ref}`);
  if (req.notes) lines.push(`Notes: ${req.notes}`);
  setText(jmMeta, lines.join("\n"));

  jmActions.innerHTML = "";

  // status buttons (admin convenience)
  const statuses = [
    ["scheduled", "Scheduled"],
    ["en_route", "En Route"],
    ["on_site", "On Site"],
    ["completed", "Completed"],
  ];
  for (const [key, label] of statuses){
    const b = document.createElement("button");
    b.className = "btn secondary";
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", async () => {
      try {
        const { error } = await supabase.from("bookings").update({ status: key }).eq("id", booking.id);
        if (error) throw error;
        booking.status = key;
        openJobModal(booking, labelPrefix);
        await render(true);
      } catch (e) {
        show(jmError, true);
        setText(jmError, `Status update failed: ${e?.message || e}`);
      }
    });
    jmActions.appendChild(b);
  }

  const phone = cleanPhone(req.phone);
  if (phone) {
    const call = document.createElement("a");
    call.className = "btn secondary";
    call.textContent = "Call";
    call.href = `tel:${phone}`;
    call.target = "_blank";
    jmActions.appendChild(call);

    const sms = document.createElement("a");
    sms.className = "btn secondary";
    sms.textContent = "Text";
    sms.href = `sms:${phone}`;
    sms.target = "_blank";
    jmActions.appendChild(sms);
  }

  if (req.address) {
    const m = document.createElement("a");
    m.className = "btn secondary";
    m.textContent = "Open in Maps";
    m.href = mapsUrl(req.address);
    m.target = "_blank";
    jmActions.appendChild(m);
  }

  show(jobModal, true);
}

// ---------- time off modal ----------
function requireSingleTechForOff(){
  const t = techRows.find(x => x.id === focusTechId);
  if (overlayAll || focusTechId === "all" || !t) {
    show(topError, true);
    setText(topError, "To edit time off, pick a single tech (Focus tech) and click Clear overlay.");
    return null;
  }
  return t;
}

function openOffModal({ day = null, slot = null, existingRow = null } = {}){
  show(offModalError, false); setText(offModalError, "");
  offModalSelectedExisting = existingRow || null;

  const t = requireSingleTechForOff();
  if (!t) return;

  // defaults
  const useDay = day ? new Date(day) : new Date(anchorDate);
  offDate.value = toISODate(useDay);

  // reason defaults
  const baseReason = (offReason?.value || "").trim();
  offReasonModal.value = existingRow?.reason || baseReason || "";

  // preset defaults
  offPreset.value = "";
  offStart.value = "08:00";
  offEnd.value = "10:00";

  if (slot) {
    offPreset.value = slot.label;
    offStart.value = `${String(slot.start_h).padStart(2,"0")}:${String(slot.start_m).padStart(2,"0")}`;
    offEnd.value = `${String(slot.end_h).padStart(2,"0")}:${String(slot.end_m).padStart(2,"0")}`;
  }

  if (existingRow?.start_ts && existingRow?.end_ts) {
    const s = new Date(existingRow.start_ts);
    const e = new Date(existingRow.end_ts);
    offDate.value = toISODate(s);
    offStart.value = `${String(s.getHours()).padStart(2,"0")}:${String(s.getMinutes()).padStart(2,"0")}`;
    offEnd.value = `${String(e.getHours()).padStart(2,"0")}:${String(e.getMinutes()).padStart(2,"0")}`;
  }

  setText(offModalMeta, `Tech: ${t.name || t.id}`);
  setText(offModalHint, existingRow ? "Editing/deleting existing time off." : "Adding new time off.");

  show(offDeleteBtn, !!existingRow);
  show(offModal, true);
}

function closeOffModal(){
  show(offModal, false);
  offModalSelectedExisting = null;
}
offCloseBtn?.addEventListener("click", closeOffModal);
offModal?.addEventListener("click", (e) => { if (e.target === offModal) closeOffModal(); });

offPreset?.addEventListener("change", () => {
  const v = offPreset.value;
  if (!v) return;

  const presets = {
    day: ["08:00", "17:00"],
    am:  ["08:00", "12:00"],
    pm:  ["13:00", "17:00"],
    A:   ["08:00", "10:00"],
    B:   ["08:30", "10:30"],
    C:   ["09:30", "11:30"],
    D:   ["10:00", "12:00"],
    E:   ["13:00", "15:00"],
    F:   ["13:30", "15:30"],
    G:   ["14:30", "16:30"],
    H:   ["15:00", "17:00"],
  };
  const p = presets[v];
  if (p) { offStart.value = p[0]; offEnd.value = p[1]; }
});

async function saveOffModal(){
  try{
    show(offModalError, false); setText(offModalError, "");
    const t = requireSingleTechForOff();
    if (!t) return;

    const d = offDate.value;
    const s = offStart.value;
    const e = offEnd.value;

    if (!d || !s || !e) throw new Error("Missing date/time.");
    if (e <= s) throw new Error("End time must be after start time.");

    // build timestamps in local time
    const startTs = new Date(`${d}T${s}:00`);
    const endTs = new Date(`${d}T${e}:00`);

    const reason = (offReasonModal.value || "").trim() || null;

    if (offModalSelectedExisting?.id) {
      const { error } = await supabase
        .from("tech_time_off")
        .update({
          tech_id: t.id,
          start_ts: startTs.toISOString(),
          end_ts: endTs.toISOString(),
          reason,
          type: "range"
        })
        .eq("id", offModalSelectedExisting.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("tech_time_off")
        .insert({
          tech_id: t.id,
          start_ts: startTs.toISOString(),
          end_ts: endTs.toISOString(),
          reason,
          type: "range"
        });
      if (error) throw error;
    }

    closeOffModal();
    await render(true);
  } catch(e){
    console.error(e);
    show(offModalError, true);
    setText(offModalError, `Save failed: ${e?.message || e}`);
  }
}

async function deleteOffModal(){
  try{
    show(offModalError, false); setText(offModalError, "");
    if (!offModalSelectedExisting?.id) return;

    const { error } = await supabase.from("tech_time_off").delete().eq("id", offModalSelectedExisting.id);
    if (error) throw error;

    closeOffModal();
    await render(true);
  } catch(e){
    console.error(e);
    show(offModalError, true);
    setText(offModalError, `Delete failed: ${e?.message || e}`);
  }
}

offSaveBtn?.addEventListener("click", saveOffModal);
offDeleteBtn?.addEventListener("click", deleteOffModal);

// Add time off button opens modal
addOffBtn?.addEventListener("click", () => {
  openOffModal({ day: anchorDate });
});

// ---------- fast toggle OFF by slot click ----------
async function toggleOffForSlot(dayDate, slot, existingRow){
  const t = requireSingleTechForOff();
  if (!t) return;

  // If there’s already an off row, open modal for edit/delete
  if (existingRow?.id) {
    openOffModal({ existingRow });
    return;
  }

  // Otherwise create a slot-sized block quickly
  try {
    show(topError, false); setText(topError, "");
    const reason = (offReason?.value || "").trim() || null;
    const payload = {
      tech_id: t.id,
      start_ts: slot.start.toISOString(),
      end_ts: slot.end.toISOString(),
      reason,
      type: "slot"
    };
    const { error } = await supabase.from("tech_time_off").insert(payload);
    if (error) throw error;
    await render(true);
  } catch (e) {
    console.error(e);
    show(topError, true);
    setText(topError, `Time off update failed: ${e?.message || e}`);
  }
}

// ---------- time off list ----------
function renderTimeOffList(rows){
  if (!rows.length) {
    offList.textContent = "No time off in this range.";
    return;
  }

  const lines = rows.map(r => {
    const s = new Date(r.start_ts).toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
    const e = new Date(r.end_ts).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });
    const techName = techRows.find(t => t.id === r.tech_id)?.name || r.tech_id;
    return `• ${techName}: ${s}–${e}${r.reason ? ` • ${r.reason}` : ""}`;
  });

  offList.textContent = lines.join("\n");
}

// ---------- job list ----------
function renderJobList(bookings){
  jobList.innerHTML = "";
  show(jobListEmpty, bookings.length === 0);

  // label
  if (viewMode === "day") setText(jobListTitle, "Day view");
  else if (viewMode === "week") setText(jobListTitle, "Week view");
  else setText(jobListTitle, "Month view (all jobs in month)");

  let currentGroup = "";
  for (const b of bookings){
    const dayKey = new Date(b.window_start).toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" });
    if (viewMode !== "day" && dayKey !== currentGroup) {
      currentGroup = dayKey;
      const h = document.createElement("div");
      h.className = "tiny";
      h.style.margin = "8px 0 6px";
      h.style.opacity = "0.9";
      h.textContent = dayKey;
      jobList.appendChild(h);
    }

    const req = b.booking_requests || {};
    const z = b.route_zone_code || b.zone_code || "";
    const item = document.createElement("div");
    item.className = "jobitem";

    const t = document.createElement("div");
    t.className = "jobtitle";
    t.textContent = `${fmtTime(b.window_start)}–${fmtTime(b.window_end)} • ${req.name || "Customer"}`;

    const m = document.createElement("div");
    m.className = "jobmeta";
    m.textContent = [
      req.address || "",
      req.phone ? `📞 ${req.phone}` : "",
      z ? `Zone ${z}` : "",
      b.status ? `Status: ${statusLabel(b.status)}` : "",
      b.appointment_type ? `Type: ${b.appointment_type}` : "",
    ].filter(Boolean).join("\n");

    item.appendChild(t);
    item.appendChild(m);
    item.addEventListener("click", () => openJobModal(b));
    jobList.appendChild(item);
  }
}

// ---------- view renderers ----------
function matchesSlot(slot, b){
  const s = slot.start.getTime(), e = slot.end.getTime();
  const bs = new Date(b.window_start).getTime();
  const be = new Date(b.window_end).getTime();
  return Math.abs(bs - s) <= 60_000 && Math.abs(be - e) <= 60_000;
}

function findOffForSlot(timeOffRows, slot, onlyTechId = null){
  const s = slot.start.getTime();
  const e = slot.end.getTime();
  for (const o of timeOffRows){
    if (onlyTechId && o.tech_id !== onlyTechId) continue;
    if (!o.start_ts || !o.end_ts) continue;
    const os = new Date(o.start_ts).getTime();
    const oe = new Date(o.end_ts).getTime();
    if (overlaps(s, e, os, oe)) return o;
  }
  return null;
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

  // Zone header only when focused single tech (and not overlay)
  const focusRow = (!overlayAll && focusTechId !== "all") ? techRows.find(t => t.id === focusTechId) : null;
  const zoneMap = focusRow ? parseZoneLogic(focusRow.territory_notes) : null;

  for (const d of days){
    const th = document.createElement("th");
    const dow = d.toLocaleDateString([], { weekday:"short" }); // Mon/Tue/...
    const z = zoneMap ? zoneMap[dow] : null;
    th.textContent = (z && z !== "ignore") ? `${fmtDay(d)} • Zone ${z}` : fmtDay(d);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const slots = buildDaySlots(monDate);

  for (const slot of slots){
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.className = "timecol";
    tdTime.textContent = `${slot.label} • ${fmtTimeLabel(slot.start_h,slot.start_m,slot.end_h,slot.end_m)}`;
    tr.appendChild(tdTime);

    for (const d of days){
      const td = document.createElement("td");
      const daySlots = buildDaySlots(d);
      const sameIdx = daySlots.find(s => s.slot_index === slot.slot_index);

      // bookings in this slot
      const dayBookings = bookings.filter(b => matchesSlot(sameIdx, b));

      // time off: if single tech focus, show that tech’s off. if overlay, show “any off exists”
      const onlyTech = (!overlayAll && focusTechId !== "all") ? focusTechId : null;
      const offHit = findOffForSlot(timeOffRows, sameIdx, onlyTech);

      if (offHit) {
        const reason = offHit.reason ? `Reason: ${offHit.reason}` : "";
        const div = slotDiv({ kind:"off", badgeText:"OFF", title:"Time off", meta: reason });
        td.appendChild(div);

        td.style.cursor = "pointer";
        td.addEventListener("click", () => toggleOffForSlot(d, sameIdx, offHit));
      }
      else if (dayBookings.length) {
        if (overlayAll || focusTechId === "all") {
          const div = slotDiv({
            kind:"booked",
            badgeText: `${dayBookings.length} booked`,
            title: "Booked",
            meta: dayBookings.slice(0,4).map(b => {
              const name = b.booking_requests?.name || "Customer";
              const z = b.route_zone_code || b.zone_code || "";
              return `${name}${z ? ` • Zone ${z}` : ""} • ${statusLabel(b.status)}`;
            }).join("\n") + (dayBookings.length > 4 ? `\n+${dayBookings.length - 4} more…` : "")
          });
          td.appendChild(div);

          td.style.cursor = "pointer";
          td.addEventListener("click", () => openJobModal(dayBookings[0], `[${dayBookings.length} booked]`));
        } else {
          const b = dayBookings[0];
          const req = b.booking_requests || {};
          const z = b.route_zone_code || b.zone_code || "";
          const div = slotDiv({
            kind:"booked",
            badgeText: statusLabel(b.status),
            title: `${req.name || "Customer"}${z ? ` • Zone ${z}` : ""}`,
            meta: req.address || ""
          });
          td.appendChild(div);

          td.style.cursor = "pointer";
          td.addEventListener("click", () => openJobModal(b));
        }
      } else {
        const div = slotDiv({ kind:"open", badgeText:"Open", title:"Not booked", meta:"" });
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
  const day = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 0,0,0);
  const slots = buildDaySlots(day);

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");

  const th0 = document.createElement("th");
  th0.className = "timecol";
  th0.textContent = "Slots";
  hr.appendChild(th0);

  const th1 = document.createElement("th");
  th1.textContent = fmtDay(day);
  hr.appendChild(th1);

  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  const onlyTech = (!overlayAll && focusTechId !== "all") ? focusTechId : null;

  for (const slot of slots){
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.className = "timecol";
    tdTime.textContent = `${slot.label} • ${fmtTimeLabel(slot.start_h,slot.start_m,slot.end_h,slot.end_m)}`;
    tr.appendChild(tdTime);

    const td = document.createElement("td");

    const offHit = findOffForSlot(timeOffRows, slot, onlyTech);
    const inSlot = bookings.filter(b => matchesSlot(slot, b));

    if (offHit) {
      const div = slotDiv({
        kind:"off",
        badgeText:"OFF",
        title:"Time off",
        meta: offHit.reason ? `Reason: ${offHit.reason}` : ""
      });
      td.appendChild(div);
      td.style.cursor = "pointer";
      td.addEventListener("click", () => toggleOffForSlot(day, slot, offHit));
    }
    else if (inSlot.length) {
      // Day view shows first booking; click opens details
      const b = inSlot[0];
      const req = b.booking_requests || {};
      const z = b.route_zone_code || b.zone_code || "";
      const div = slotDiv({
        kind:"booked",
        badgeText: statusLabel(b.status),
        title: `${req.name || "Customer"}${z ? ` • Zone ${z}` : ""}`,
        meta: `${req.address || ""}${req.phone ? `\n📞 ${req.phone}` : ""}`
      });
      td.appendChild(div);
      td.style.cursor = "pointer";
      td.addEventListener("click", () => openJobModal(b));
    }
    else {
      const div = slotDiv({ kind:"open", badgeText:"Open", title:"Not booked", meta:"" });
      td.appendChild(div);
      td.style.cursor = "pointer";
      td.addEventListener("click", () => toggleOffForSlot(day, slot, null));
    }

    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
}

function renderMonthCompact(anchor, bookings, timeOffRows){
  const y = anchor.getFullYear();
  const m = anchor.getMonth();

  // Build list of all weekdays (Mon-Fri) in month
  const first = new Date(y, m, 1);
  const last = new Date(y, m+1, 0);

  // Determine the Monday before (or equal to) the first weekday we show
  const start = startOfWeekMon(first);
  const end = new Date(last); end.setDate(end.getDate() + 7);

  const techCount = selectedTechRows().length || 1; // for open-slot math

  // helper to get bookings for a date
  function sameISO(a,b){ return toISODate(a) === toISODate(b); }

  // We'll render rows of weeks, columns Mon-Fri only
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");

  const th0 = document.createElement("th");
  th0.className = "timecol";
  th0.textContent = "Week";
  hr.appendChild(th0);

  const cols = ["Mon","Tue","Wed","Thu","Fri"];
  for (const c of cols){
    const th = document.createElement("th");
    th.textContent = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  // walk weeks
  let cursor = new Date(start);
  while (cursor < end){
    // if week is entirely outside month (Mon-Fri), skip
    const weekDays = [];
    for (let i=0;i<5;i++){
      const d = new Date(cursor);
      d.setDate(d.getDate()+i);
      weekDays.push(d);
    }

    const anyInMonth = weekDays.some(d => d.getMonth() === m);
    if (!anyInMonth) { cursor.setDate(cursor.getDate()+7); continue; }

    const tr = document.createElement("tr");

    const tdW = document.createElement("td");
    tdW.className = "timecol";
    tdW.textContent = `${fmtDay(cursor)} wk`;
    tr.appendChild(tdW);

    for (const d of weekDays){
      const td = document.createElement("td");

      if (d.getMonth() !== m) {
        td.style.opacity = "0.35";
        td.textContent = "";
        tr.appendChild(td);
        continue;
      }

      const slots = buildDaySlots(d);

      // bookings count per day
      const booked = bookings.filter(b => toISODate(new Date(b.window_start)) === toISODate(d)).length;

      // off slots count: count how many slots overlap time_off (focused tech only if single focus)
      const onlyTech = (!overlayAll && focusTechId !== "all") ? focusTechId : null;
      let offSlots = 0;
      for (const s of slots){
        if (findOffForSlot(timeOffRows, s, onlyTech)) offSlots++;
      }

      const totalSlots = slots.length * techCount;

      // open math: totalSlots - booked - offSlots*(techCount?).
      // offSlots is per-slot indicator; treat as "slot blocked for focused tech". For overlay, it’s approximate (still useful).
      const open = Math.max(0, totalSlots - booked - (onlyTech ? offSlots : offSlots));

      const div = document.createElement("div");
      div.className = "slot open";
      div.style.minHeight = "68px";

      const title = document.createElement("div");
      title.className = "slot-title";
      title.textContent = `${d.getDate()}`;

      const meta = document.createElement("div");
      meta.className = "slot-meta";
      meta.textContent = `Booked: ${booked}\nOpen: ${open}\nOff: ${offSlots}`;

      div.appendChild(title);
      div.appendChild(meta);

      // click day -> go to Day view for that date
      div.style.cursor = "pointer";
      div.addEventListener("click", () => {
        anchorDate = new Date(d);
        viewMode = "day";
        render();
      });

      td.appendChild(div);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
    cursor.setDate(cursor.getDate()+7);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
}

// ---------- system tool stub ----------
genOffersStubBtn?.addEventListener("click", () => {
  setText(sysNote, "Stub only. We’ll wire this after we find what currently populates booking_request_offers.");
});

// ---------- main render ----------
async function render(force = false){
  show(topError, false); setText(topError, "");
  const { start, end, label } = getRangeForView();
  lastRange = { start, end, label };
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

    lastBookings = bookings;
    lastTimeOff = timeOffRows;

    computeStats(bookings);
    renderTimeOffList(timeOffRows);
    renderJobList(bookings);

    if (viewMode === "month") {
      renderMonthCompact(anchorDate, bookings, timeOffRows);
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

  viewMode = "week";
  overlayAll = true;
  focusTechId = "all";

  await render(true);
}

main();
