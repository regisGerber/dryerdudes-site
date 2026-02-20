import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and window.__SUPABASE_ANON_KEY__ in admin.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---- MUST MATCH YOUR DB CONSTRAINT ----
const ALLOWED_TYPES = ["all_day", "am", "pm", "slot"];

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

const offDate = document.getElementById("offDate");
const offBlock = document.getElementById("offBlock");
const offSlot = document.getElementById("offSlot");
const offReason = document.getElementById("offReason");
const addOffBtn = document.getElementById("addOffBtn");
const offList = document.getElementById("offList");

const detailHint = document.getElementById("detailHint");
const detailBox = document.getElementById("detailBox");
const markOffFromDetailBtn = document.getElementById("markOffFromDetailBtn");
const deleteOffFromDetailBtn = document.getElementById("deleteOffFromDetailBtn");

const jobsList = document.getElementById("jobsList");

const genOffersStubBtn = document.getElementById("genOffersStubBtn");
const sysNote = document.getElementById("sysNote");

// Search UI (new)
const jobSearchInput = document.getElementById("jobSearchInput");
const jobSearchBtn = document.getElementById("jobSearchBtn");
const jobSearchClearBtn = document.getElementById("jobSearchClearBtn");
const jobSearchResults = document.getElementById("jobSearchResults");

// ---------- helpers ----------
function show(el, on = true) { if (el) el.style.display = on ? "" : "none"; }
function setText(el, t) { if (el) el.textContent = t ?? ""; }

function fmtDay(d) {
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(d) {
  return new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtTimeLabel(h1, m1, h2, m2) {
  const pad = n => String(n).padStart(2, "0");
  return `${h1}:${pad(m1)}–${h2}:${pad(m2)}`;
}
function toISODate(d){ return d.toISOString().slice(0,10); }

function tzNameSafe() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
  catch { return ""; }
}

function overlaps(aStart, aEnd, bStart, bEnd){
  return aStart < bEnd && bStart < aEnd;
}

function statusLabel(s){
  const v = String(s || "").toLowerCase();
  return v || "scheduled";
}

// Same 8 slots
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
let anchorDate = new Date();

let techRows = []; // {id,name,active,territory_notes,user_id}

// selected cell info for detail panel
let selectedCell = null; // { dayDate, slot, bookings[], offRows[] }
let selectedSlotEl = null;

// ---------- load techs ----------
async function loadTechs() {
  const { data, error } = await supabase
    .from("techs")
    .select("id,name,active,territory_notes,user_id")
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
    o.textContent = t.name;
    focusTech.appendChild(o);
  }

  if (techRows.length === 1) {
    focusTechId = techRows[0].id;
    focusTech.value = techRows[0].id;
  } else {
    focusTech.value = "all";
  }
}

focusTech?.addEventListener("change", () => {
  focusTechId = focusTech.value || "all";
  clearSelectedCell();
  render();
});

overlayAllBtn?.addEventListener("click", () => {
  overlayAll = true;
  clearSelectedCell();
  render();
});
clearOverlayBtn?.addEventListener("click", () => {
  overlayAll = false;
  clearSelectedCell();
  render();
});

// ---------- range logic ----------
function startOfWeekMon(d){
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
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
  const mon = startOfWeekMon(anchorDate);
  const end = new Date(mon); end.setDate(end.getDate() + 7);
  const fri = new Date(mon); fri.setDate(fri.getDate() + 4);
  return { start: mon, end, label: `${fmtDay(mon)} – ${fmtDay(fri)} • ${tz}` };
}

function setViewMode(m){
  viewMode = m;
  clearSelectedCell();
  render();
}
dayBtn?.addEventListener("click", () => setViewMode("day"));
weekBtn?.addEventListener("click", () => setViewMode("week"));
monthBtn?.addEventListener("click", () => setViewMode("month"));

prevBtn?.addEventListener("click", () => {
  if (viewMode === "day") anchorDate.setDate(anchorDate.getDate() - 1);
  else if (viewMode === "week") anchorDate.setDate(anchorDate.getDate() - 7);
  else anchorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() - 1, 1);
  clearSelectedCell();
  render();
});

nextBtn?.addEventListener("click", () => {
  if (viewMode === "day") anchorDate.setDate(anchorDate.getDate() + 1);
  else if (viewMode === "week") anchorDate.setDate(anchorDate.getDate() + 7);
  else anchorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1);
  clearSelectedCell();
  render();
});

todayBtn?.addEventListener("click", () => {
  anchorDate = new Date();
  clearSelectedCell();
  render();
});

// ---------- data loads ----------
function selectedTechUserIds(){
  const rows = techRows.filter(t => t.user_id);
  if (overlayAll || focusTechId === "all") return rows.map(t => t.user_id);
  const t = techRows.find(x => x.id === focusTechId);
  return t?.user_id ? [t.user_id] : [];
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

  if (techUserIds.length) q = q.in("assigned_tech_id", techUserIds);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function loadTimeOff(start, end){
  const { data, error } = await supabase
    .from("tech_time_off")
    .select("id,tech_id,start_ts,end_ts,reason,type,created_at")
    .gte("end_ts", start.toISOString())
    .lte("start_ts", end.toISOString())
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

// ---------- details panel ----------
function clearSelectedCell(){
  selectedCell = null;
  if (selectedSlotEl) selectedSlotEl.classList.remove("selected");
  selectedSlotEl = null;

  show(detailBox, false);
  show(markOffFromDetailBtn, false);
  show(deleteOffFromDetailBtn, false);
  setText(detailHint, "Click any slot to see details here.");
}

function selectCell(dayDate, slot, bookingsForCell, offRowsForCell, slotEl){
  if (selectedSlotEl) selectedSlotEl.classList.remove("selected");
  selectedSlotEl = slotEl;
  selectedSlotEl?.classList.add("selected");

  selectedCell = { dayDate, slot, bookings: bookingsForCell, offRows: offRowsForCell };

  const dateStr = fmtDay(dayDate);
  const timeStr = fmtTimeLabel(slot.start_h, slot.start_m, slot.end_h, slot.end_m);

  // Booked?
  if (bookingsForCell.length) {
    const b = bookingsForCell[0];
    const req = b.booking_requests || {};
    const z = b.route_zone_code || b.zone_code || "";
    const lines = [
      `${dateStr} • Slot ${slot.label} (${timeStr})`,
      ``,
      `Customer: ${req.name || "—"}`,
      req.address ? `Address: ${req.address}` : "",
      req.phone ? `Phone: ${req.phone}` : "",
      b.job_ref ? `Job ref: ${b.job_ref}` : "",
      z ? `Zone: ${z}` : "",
      `Status: ${statusLabel(b.status)}`,
      b.appointment_type ? `Type: ${b.appointment_type}` : "",
      req.notes ? `Notes: ${req.notes}` : "",
    ].filter(Boolean);

    setText(detailBox, lines.join("\n"));
    show(detailBox, true);
    setText(detailHint, "");
    show(markOffFromDetailBtn, false);
    show(deleteOffFromDetailBtn, false);
    return;
  }

  // OFF?
  if (offRowsForCell.length) {
    const o = offRowsForCell[0];
    const techName = techRows.find(t => t.id === o.tech_id)?.name || "Tech";
    const lines = [
      `${dateStr} • Slot ${slot.label} (${timeStr})`,
      ``,
      `OFF: ${techName}`,
      o.reason ? `Reason: ${o.reason}` : "",
      `Type: ${o.type || "—"}`
    ].filter(Boolean);

    setText(detailBox, lines.join("\n"));
    show(detailBox, true);
    setText(detailHint, "");

    show(markOffFromDetailBtn, false);
    show(deleteOffFromDetailBtn, true);
    return;
  }

  // Open
  const lines = [
    `${dateStr} • Slot ${slot.label} (${timeStr})`,
    ``,
    `Open / Not booked`
  ];
  setText(detailBox, lines.join("\n"));
  show(detailBox, true);
  setText(detailHint, "");

  show(markOffFromDetailBtn, true);
  show(deleteOffFromDetailBtn, false);
}

markOffFromDetailBtn?.addEventListener("click", () => {
  if (!selectedCell) return;
  const d = selectedCell.dayDate;
  const slot = selectedCell.slot;

  if (offDate) offDate.value = toISODate(d);
  if (offBlock) offBlock.value = "slot";
  if (offSlot) offSlot.value = String(slot.slot_index);
});

// -------- offer syncing helpers (new) --------
async function syncOffersForTimeOffRow({ tech_id, start_ts, end_ts, type, slot_index, service_date, is_active }) {
  // slot -> exact slot only (no overlap)
  if (type === "slot" && service_date && slot_index) {
    const { error } = await supabase.rpc("set_offers_active_for_slot", {
      p_tech_id: tech_id,
      p_service_date: service_date,     // YYYY-MM-DD
      p_slot_index: Number(slot_index), // int
      p_is_active: is_active,
    });
    if (error) throw error;
    return;
  }

  // am/pm/all_day -> range overlap is fine
  const { error } = await supabase.rpc("apply_time_off_to_offers", {
    p_tech_id: tech_id,
    p_start_ts: start_ts,
    p_end_ts: end_ts,
    p_is_active: is_active,
  });
  if (error) throw error;
}

// Re-apply any remaining time off rows for safety after a deletion (prevents “reactivate a slot that’s still covered”)
async function reapplyTimeOffForWindow({ tech_id, start_ts, end_ts }) {
  const { data, error } = await supabase
    .from("tech_time_off")
    .select("id,tech_id,start_ts,end_ts,type")
    .eq("tech_id", tech_id)
    .gte("end_ts", start_ts)
    .lte("start_ts", end_ts);

  if (error) throw error;

  for (const row of (data || [])) {
    // Only exact slot rows need slot_index/service_date, but in table we don’t store those.
    // So we reapply by overlap for safety on remaining rows:
    const { error: e2 } = await supabase.rpc("apply_time_off_to_offers", {
      p_tech_id: tech_id,
      p_start_ts: row.start_ts,
      p_end_ts: row.end_ts,
      p_is_active: false,
    });
    if (e2) throw e2;
  }
}

deleteOffFromDetailBtn?.addEventListener("click", async () => {
  try {
    if (!selectedCell?.offRows?.length) return;
    const row = selectedCell.offRows[0];
    show(topError, false); setText(topError, "");

    // 1) Delete time off row
    const { error } = await supabase.from("tech_time_off").delete().eq("id", row.id);
    if (error) throw error;

    // 2) Reactivate offers in that window (then reapply any remaining OFF rows that still cover it)
    await syncOffersForTimeOffRow({
      tech_id: row.tech_id,
      start_ts: row.start_ts,
      end_ts: row.end_ts,
      type: row.type,
      is_active: true,
      // slot-only exact info not stored in tech_time_off; so slot deletions will “reactivate by overlap” here.
      // That’s why we immediately reapply remaining OFF rows below.
    });

    await reapplyTimeOffForWindow({ tech_id: row.tech_id, start_ts: row.start_ts, end_ts: row.end_ts });

    clearSelectedCell();
    await render();
  } catch (e) {
    console.error(e);
    show(topError, true);
    setText(topError, `Remove OFF failed: ${e?.message || e}`);
  }
});

// ---------- time off form insert ----------
function getFocusedTechIdOrThrow(){
  const t = techRows.find(x => x.id === focusTechId);
  if (!t) throw new Error("Pick a tech first.");
  return t.id; // tech_time_off.tech_id uses techs.id (uuid)
}

function buildOffWindow(dateISO, block, slotIndex){
  const d = new Date(`${dateISO}T00:00:00`);
  const slots = buildDaySlots(d);

  if (block === "all_day") {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0);
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59);
    return { start, end };
  }

  if (block === "am") {
    const s = slots[0].start;
    const e = slots[3].end;
    return { start: s, end: e };
  }

  if (block === "pm") {
    const s = slots[4].start;
    const e = slots[7].end;
    return { start: s, end: e };
  }

  // slot (exact)
  const chosen = slots.find(x => x.slot_index === Number(slotIndex)) || slots[0];
  return { start: chosen.start, end: chosen.end };
}

addOffBtn?.addEventListener("click", async () => {
  try {
    show(topError, false); setText(topError, "");

    if (focusTechId === "all") {
      show(topError, true);
      setText(topError, "Pick a specific tech before adding time off.");
      return;
    }

    const dateISO = offDate?.value;
    if (!dateISO) {
      show(topError, true);
      setText(topError, "Select a date for time off.");
      return;
    }

    const block = offBlock?.value || "all_day";
    const slotIndex = offSlot?.value || "1";

    if (!ALLOWED_TYPES.includes(block)) {
      throw new Error(`Time off type "${block}" not allowed by DB constraint. Update ALLOWED_TYPES or the constraint.`);
    }

    const tech_id = getFocusedTechIdOrThrow();
    const { start, end } = buildOffWindow(dateISO, block, slotIndex);
    const reason = (offReason?.value || "").trim() || null;

    // Insert time off row
    const payload = {
      tech_id,
      start_ts: start.toISOString(),
      end_ts: end.toISOString(),
      reason,
      type: block
    };

    const { error } = await supabase.from("tech_time_off").insert(payload);
    if (error) throw error;

    // Flip offers inactive:
    // - slot => exact match by service_date + slot_index (no overlap blocking)
    // - others => overlap window
    if (block === "slot") {
      await syncOffersForTimeOffRow({
        tech_id,
        type: "slot",
        service_date: dateISO,
        slot_index: Number(slotIndex),
        is_active: false,
      });
    } else {
      await syncOffersForTimeOffRow({
        tech_id,
        start_ts: start.toISOString(),
        end_ts: end.toISOString(),
        type: block,
        is_active: false,
      });
    }

    await render();
  } catch (e) {
    console.error(e);
    show(topError, true);
    setText(topError, `Time off update failed: ${e?.message || e}`);
  }
});

// ---------- time off list ----------
function renderTimeOffList(rows){
  if (!rows.length) {
    offList.textContent = "No time off in this range.";
    return;
  }
  const lines = rows.map(r => {
    const s = new Date(r.start_ts).toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
    const e = new Date(r.end_ts).toLocaleString([], { hour:"numeric", minute:"2-digit" });
    const techName = techRows.find(t => t.id === r.tech_id)?.name || r.tech_id;
    return `• ${techName}: ${s}–${e}${r.type ? ` • ${r.type}` : ""}${r.reason ? ` • ${r.reason}` : ""}`;
  });
  offList.textContent = lines.join("\n");
}

// ---------- jobs list ----------
function renderJobsList(bookings){
  if (!bookings.length) {
    jobsList.textContent = "No bookings in this view.";
    return;
  }
  const lines = bookings.slice(0, 60).map(b => {
    const req = b.booking_requests || {};
    const z = b.route_zone_code || b.zone_code || "";
    return `• ${fmtDay(new Date(b.window_start))} ${fmtTime(b.window_start)}–${fmtTime(b.window_end)} — ${req.name || "Customer"}${z ? ` (Zone ${z})` : ""} • ${statusLabel(b.status)}`;
  });
  const extra = bookings.length > 60 ? `\n…plus ${bookings.length - 60} more` : "";
  jobsList.textContent = lines.join("\n") + extra;
}

// ---------- Job Search (new) ----------
function formatSearchRow(b) {
  const req = b.booking_requests || {};
  const z = b.route_zone_code || b.zone_code || "";
  const when = `${fmtDay(new Date(b.window_start))} ${fmtTime(b.window_start)}–${fmtTime(b.window_end)}`;
  const name = req.name || "Customer";
  const ref = b.job_ref ? `Ref: ${b.job_ref}` : "Ref: —";
  const addr = req.address ? `Addr: ${req.address}` : "";
  return `• ${when} — ${name} ${z ? `(Zone ${z})` : ""} • ${ref} • ${statusLabel(b.status)}${addr ? `\n  ${addr}` : ""}`;
}

async function searchJobs(termRaw) {
  const term = String(termRaw || "").trim();
  if (!term) return [];

  // Query A: job_ref
  const q1 = supabase
    .from("bookings")
    .select(`
      id,
      window_start,
      window_end,
      status,
      appointment_type,
      zone_code,
      route_zone_code,
      job_ref,
      booking_requests:request_id ( id, name, address, phone, email, notes )
    `)
    .ilike("job_ref", `%${term}%`)
    .order("window_start", { ascending: false })
    .limit(25);

  // Query B: customer name (join)
  const q2 = supabase
    .from("bookings")
    .select(`
      id,
      window_start,
      window_end,
      status,
      appointment_type,
      zone_code,
      route_zone_code,
      job_ref,
      booking_requests:request_id!inner ( id, name, address, phone, email, notes )
    `)
    .ilike("booking_requests.name", `%${term}%`)
    .order("window_start", { ascending: false })
    .limit(25);

  const [r1, r2] = await Promise.all([q1, q2]);

  if (r1.error) throw r1.error;
  if (r2.error) throw r2.error;

  // Dedup by booking id
  const map = new Map();
  for (const b of (r1.data || [])) map.set(b.id, b);
  for (const b of (r2.data || [])) map.set(b.id, b);

  return Array.from(map.values())
    .sort((a, b) => new Date(b.window_start) - new Date(a.window_start))
    .slice(0, 40);
}

jobSearchBtn?.addEventListener("click", async () => {
  try {
    show(topError, false); setText(topError, "");
    if (!jobSearchResults) return;

    const term = jobSearchInput?.value || "";
    setText(jobSearchResults, "Searching…");

    const rows = await searchJobs(term);
    if (!rows.length) {
      setText(jobSearchResults, "No matching jobs found.");
      return;
    }

    setText(jobSearchResults, rows.map(formatSearchRow).join("\n\n"));
  } catch (e) {
    console.error(e);
    show(topError, true);
    setText(topError, `Search failed: ${e?.message || e}`);
    setText(jobSearchResults, "");
  }
});

jobSearchClearBtn?.addEventListener("click", () => {
  if (jobSearchInput) jobSearchInput.value = "";
  setText(jobSearchResults, "");
});

// ---------- render calendar ----------
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

      const cellBookings = bookings.filter(b => matchesSlot(sameIdx, b));

      const onlyTech = (!overlayAll && focusTechId !== "all") ? focusTechId : null;
      const cellOff = timeOffRows.filter(o => {
        if (onlyTech && o.tech_id !== onlyTech) return false;
        const os = new Date(o.start_ts).getTime();
        const oe = new Date(o.end_ts).getTime();
        return overlaps(sameIdx.start.getTime(), sameIdx.end.getTime(), os, oe);
      });

      let div;
      if (cellOff.length) {
        div = slotDiv({
          kind: "off",
          badgeText: "OFF",
          title: "Time off",
          meta: cellOff[0]?.reason ? `Reason: ${cellOff[0].reason}` : ""
        });
      } else if (cellBookings.length) {
        const b = cellBookings[0];
        const req = b.booking_requests || {};
        const z = b.route_zone_code || b.zone_code || "";
        div = slotDiv({
          kind: "booked",
          badgeText: statusLabel(b.status),
          title: `${req.name || "Customer"}${z ? ` • Zone ${z}` : ""}`,
          meta: req.address || ""
        });
      } else {
        div = slotDiv({
          kind: "open",
          badgeText: "Open",
          title: "Not booked",
          meta: ""
        });
      }

      div.addEventListener("click", () => selectCell(d, sameIdx, cellBookings, cellOff, div));
      td.appendChild(div);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
}

function renderDayView(dayDate, bookings, timeOffRows){
  const d = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");

  const th0 = document.createElement("th");
  th0.className = "timecol";
  th0.textContent = "Slots";
  hr.appendChild(th0);

  const th = document.createElement("th");
  th.textContent = fmtDay(d);
  hr.appendChild(th);

  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const slots = buildDaySlots(d);

  function matchesSlot(slot, b){
    const s = slot.start.getTime(), e = slot.end.getTime();
    const bs = new Date(b.window_start).getTime();
    const be = new Date(b.window_end).getTime();
    return Math.abs(bs - s) <= 60_000 && Math.abs(be - e) <= 60_000;
  }

  const onlyTech = (!overlayAll && focusTechId !== "all") ? focusTechId : null;

  for (const slot of slots){
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.className = "timecol";
    tdTime.textContent = `${slot.label} • ${fmtTimeLabel(slot.start_h,slot.start_m,slot.end_h,slot.end_m)}`;
    tr.appendChild(tdTime);

    const td = document.createElement("td");
    const cellBookings = bookings.filter(b => matchesSlot(slot, b));
    const cellOff = timeOffRows.filter(o => {
      if (onlyTech && o.tech_id !== onlyTech) return false;
      const os = new Date(o.start_ts).getTime();
      const oe = new Date(o.end_ts).getTime();
      return overlaps(slot.start.getTime(), slot.end.getTime(), os, oe);
    });

    let div;
    if (cellOff.length) {
      div = slotDiv({ kind:"off", badgeText:"OFF", title:"Time off", meta: cellOff[0]?.reason ? `Reason: ${cellOff[0].reason}` : "" });
    } else if (cellBookings.length) {
      const b = cellBookings[0];
      const req = b.booking_requests || {};
      const z = b.route_zone_code || b.zone_code || "";
      div = slotDiv({ kind:"booked", badgeText: statusLabel(b.status), title:`${req.name || "Customer"}${z ? ` • Zone ${z}` : ""}`, meta: req.address || "" });
    } else {
      div = slotDiv({ kind:"open", badgeText:"Open", title:"Not booked", meta:"" });
    }

    div.addEventListener("click", () => selectCell(d, slot, cellBookings, cellOff, div));
    td.appendChild(div);

    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
}

function renderMonthCompact(anchor, bookings, timeOffRows){
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);

  const startDow = first.getDay();
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startDow);

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(x => {
    const th = document.createElement("th");
    th.textContent = x;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  const onlyTech = (!overlayAll && focusTechId !== "all") ? focusTechId : null;
  const byDayBooked = new Map();
  for (const b of bookings) {
    const key = toISODate(new Date(b.window_start));
    byDayBooked.set(key, (byDayBooked.get(key) || 0) + 1);
  }
  const byDayOff = new Map();
  for (const o of timeOffRows) {
    if (onlyTech && o.tech_id !== onlyTech) continue;
    const key = toISODate(new Date(o.start_ts));
    byDayOff.set(key, (byDayOff.get(key) || 0) + 1);
  }

  let cursor = new Date(gridStart);
  for (let week=0; week<6; week++){
    const tr = document.createElement("tr");
    for (let day=0; day<7; day++){
      const td = document.createElement("td");
      const iso = toISODate(cursor);
      const inMonth = cursor.getMonth() === month;

      const booked = byDayBooked.get(iso) || 0;
      const off = byDayOff.get(iso) || 0;

      td.style.opacity = inMonth ? "1" : "0.4";
      td.style.verticalAlign = "top";
      td.style.height = "92px";

      td.innerHTML = `
        <div style="font-weight:900; margin-bottom:6px;">${cursor.getDate()}</div>
        <div class="tiny">Booked: ${booked}</div>
        <div class="tiny">Off: ${off}</div>
      `;

      td.addEventListener("click", () => {
        anchorDate = new Date(cursor);
        setViewMode("day");
      });

      tr.appendChild(td);
      cursor.setDate(cursor.getDate() + 1);
    }
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
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

  const setOp = (btn, on) => { if (btn) btn.style.opacity = on ? "1" : "0.75"; };
  setOp(dayBtn, viewMode === "day");
  setOp(weekBtn, viewMode === "week");
  setOp(monthBtn, viewMode === "month");
  setOp(overlayAllBtn, overlayAll);
  setOp(clearOverlayBtn, !overlayAll);

  if (offDate && !offDate.value) offDate.value = toISODate(anchorDate);

  try {
    const [bookings, timeOffRows] = await Promise.all([
      loadBookings(start, end),
      loadTimeOff(start, end)
    ]);

    computeStats(bookings);
    renderTimeOffList(timeOffRows);
    renderJobsList(bookings);

    if (viewMode === "month") {
      renderMonthCompact(anchorDate, bookings, timeOffRows);
    } else if (viewMode === "day") {
      renderDayView(anchorDate, bookings, timeOffRows);
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

  clearSelectedCell();
  await render();
}

main();
