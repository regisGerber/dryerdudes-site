import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey || String(supabaseAnonKey).includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtdXByd2J1aGN1cHhma2xteXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNzMzMTksImV4cCI6MjA4NDg0OTMxOX0.qop2LBQQ8z-iFhTWyj4dA-pIURfBCx6OtEmEfHYWAgY")) {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and window.__SUPABASE_ANON_KEY__ in admin.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---------- UI ----------
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");

const techSelect = document.getElementById("techSelect");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const todayBtn = document.getElementById("todayBtn");
const jumpDate = document.getElementById("jumpDate");
const rangeLabel = document.getElementById("rangeLabel");

const daySelect = document.getElementById("daySelect");
const reasonInput = document.getElementById("reasonInput");
const toggleDayBtn = document.getElementById("toggleDayBtn");
const toggleAmBtn = document.getElementById("toggleAmBtn");
const togglePmBtn = document.getElementById("togglePmBtn");
const slotGrid = document.getElementById("slotGrid");
const timeoffError = document.getElementById("timeoffError");
const timeoffState = document.getElementById("timeoffState");

const statCompleted = document.getElementById("statCompleted");
const statFullService = document.getElementById("statFullService");
const statCollected = document.getElementById("statCollected");

const upcomingList = document.getElementById("upcomingList");
const partsList = document.getElementById("partsList");
const completedList = document.getElementById("completedList");
const upcomingEmpty = document.getElementById("upcomingEmpty");
const partsEmpty = document.getElementById("partsEmpty");
const completedEmpty = document.getElementById("completedEmpty");
const bookingsError = document.getElementById("bookingsError");

// details
const detailEmpty = document.getElementById("detailEmpty");
const detailWrap = document.getElementById("detailWrap");
const statusBadge = document.getElementById("statusBadge");
const dTitle = document.getElementById("dTitle");
const dMeta = document.getElementById("dMeta");
const actionRow = document.getElementById("actionRow");
const techNotes = document.getElementById("techNotes");
const saveNotesBtn = document.getElementById("saveNotesBtn");
const saveState = document.getElementById("saveState");
const detailError = document.getElementById("detailError");

function show(el, on = true) { if (el) el.style.display = on ? "" : "none"; }
function setText(el, t) { if (el) el.textContent = t ?? ""; }

function tzNameSafe() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
  catch { return ""; }
}

function fmtDate(d) {
  const x = new Date(d);
  return x.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(d) {
  const x = new Date(d);
  return x.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDateTime(d) {
  const x = new Date(d);
  return x.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusLabel(s) {
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

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

// ---------- slots (same as tech.js) ----------
function buildDaySlots(dateObj) {
  const base = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0);
  function mk(h1, m1, h2, m2, label, idx) {
    return {
      slot_index: idx,
      start: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h1, m1, 0),
      end: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h2, m2, 0),
      label
    };
  }
  return [
    mk(8, 0, 10, 0, "Slot 1 • 8:00–10:00", 1),
    mk(8, 30, 10, 30, "Slot 2 • 8:30–10:30", 2),
    mk(9, 30, 11, 30, "Slot 3 • 9:30–11:30", 3),
    mk(10, 0, 12, 0, "Slot 4 • 10:00–12:00", 4),
    mk(13, 0, 15, 0, "Slot 5 • 1:00–3:00", 5),
    mk(13, 30, 15, 30, "Slot 6 • 1:30–3:30", 6),
    mk(14, 30, 16, 30, "Slot 7 • 2:30–4:30", 7),
    mk(15, 0, 17, 0, "Slot 8 • 3:00–5:00", 8),
  ];
}

function dayRangeLocal(dateObj) {
  const d0 = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0);
  const d1 = new Date(d0);
  d1.setDate(d1.getDate() + 1);
  return { start: d0, end: d1 };
}

// ---------- state ----------
let sessionUser = null;
let selectedTechId = null;
let weekAnchor = new Date(); // any date within the week being viewed
let timeOffRows = [];        // tech_time_off rows in current week
let bookingsRows = [];       // bookings for selected tech in current week

let activeBooking = null;
let activeCardEl = null;

// ---------- auth / role ----------
async function requireAdmin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { window.location.href = "/login.html"; return null; }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", session.user.id)
    .single();

  if (error) throw error;
  if (!profile || profile.role !== "admin") {
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

// ---------- tech list ----------
async function loadTechOptions() {
  // If your profiles table uses role='tech'. If not, tell me what it uses and I’ll adjust.
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, role, name, email")
    .in("role", ["tech", "admin"]) // allow admins if you sometimes assign jobs to yourself
    .order("name", { ascending: true });

  if (error) throw error;

  const rows = (data || []).filter(r => r.user_id);
  techSelect.innerHTML = "";

  for (const r of rows) {
    const opt = document.createElement("option");
    opt.value = r.user_id;
    opt.textContent = r.name || r.email || r.user_id;
    techSelect.appendChild(opt);
  }

  if (!selectedTechId && rows.length) selectedTechId = rows[0].user_id;
  techSelect.value = selectedTechId || "";
}

techSelect?.addEventListener("change", () => {
  selectedTechId = techSelect.value || null;
  clearDetails();
  refreshAll();
});

// ---------- week range ----------
function startOfWeek(dateObj) {
  // Monday start (feel free to change)
  const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0);
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const mondayDelta = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + mondayDelta);
  return d;
}

function weekRange(anchor) {
  const start = startOfWeek(anchor);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

function setWeekAnchor(d) {
  weekAnchor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
  // sync date input
  const yyyy = weekAnchor.getFullYear();
  const mm = String(weekAnchor.getMonth() + 1).padStart(2, "0");
  const dd = String(weekAnchor.getDate()).padStart(2, "0");
  if (jumpDate) jumpDate.value = `${yyyy}-${mm}-${dd}`;
}

prevBtn?.addEventListener("click", () => { const d = new Date(weekAnchor); d.setDate(d.getDate() - 7); setWeekAnchor(d); refreshAll(); });
nextBtn?.addEventListener("click", () => { const d = new Date(weekAnchor); d.setDate(d.getDate() + 7); setWeekAnchor(d); refreshAll(); });
todayBtn?.addEventListener("click", () => { setWeekAnchor(new Date()); refreshAll(); });
jumpDate?.addEventListener("change", () => {
  if (!jumpDate.value) return;
  const [y,m,dd] = jumpDate.value.split("-").map(Number);
  setWeekAnchor(new Date(y, m-1, dd));
  refreshAll();
});

// ---------- time off ----------
async function loadTimeOff(start, end) {
  if (!selectedTechId) return [];
  const { data, error } = await supabase
    .from("tech_time_off")
    .select("id, tech_id, start_ts, end_ts, reason, type")
    .eq("tech_id", selectedTechId)
    .lt("start_ts", end.toISOString())
    .gt("end_ts", start.toISOString())
    .order("start_ts", { ascending: true });

  if (error) throw error;
  return data || [];
}

function fillDaySelect(start) {
  daySelect.innerHTML = "";
  for (let i=0;i<7;i++){
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const opt = document.createElement("option");
    opt.value = d.toISOString();
    opt.textContent = d.toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" });
    daySelect.appendChild(opt);
  }
  // default: today if in range, else first day
  const today = new Date();
  const { start: wStart, end: wEnd } = weekRange(weekAnchor);
  const isInWeek = today >= wStart && today < wEnd;
  daySelect.selectedIndex = isInWeek ? (Math.floor((new Date(today.getFullYear(),today.getMonth(),today.getDate()) - wStart)/86400000)) : 0;
}

function getSelectedDay() {
  const iso = daySelect.value;
  const d = iso ? new Date(iso) : new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
}

function findExactTimeOffBlock(startTs, endTs, toleranceMs=60_000) {
  const s = startTs.getTime();
  const e = endTs.getTime();
  return timeOffRows.find(r => {
    const rs = new Date(r.start_ts).getTime();
    const re = new Date(r.end_ts).getTime();
    return Math.abs(rs - s) <= toleranceMs && Math.abs(re - e) <= toleranceMs;
  }) || null;
}

async function toggleTimeOffBlock(startTs, endTs, typeLabel) {
  show(timeoffError, false);
  setText(timeoffError, "");
  setText(timeoffState, "");

  if (!selectedTechId) return;

  const existing = findExactTimeOffBlock(startTs, endTs);
  const reason = (reasonInput?.value || "").trim() || null;

  try {
    setText(timeoffState, existing ? "Removing block…" : "Adding block…");

    if (existing) {
      const { error } = await supabase.from("tech_time_off").delete().eq("id", existing.id);
      if (error) throw error;
    } else {
      const payload = {
        tech_id: selectedTechId,
        start_ts: startTs.toISOString(),
        end_ts: endTs.toISOString(),
        reason,
        type: typeLabel || "custom"
      };
      const { error } = await supabase.from("tech_time_off").insert(payload);
      if (error) throw error;
    }

    // reload week time off and re-render
    const { start, end } = weekRange(weekAnchor);
    timeOffRows = await loadTimeOff(start, end);
    renderTimeOffUI();
    setText(timeoffState, existing ? "Block removed." : "Block added.");
    setTimeout(() => setText(timeoffState, ""), 1500);
  } catch (e) {
    console.error(e);
    show(timeoffError, true);
    setText(timeoffError, `Time off update failed: ${e?.message || e}`);
    setText(timeoffState, "");
  }
}

function renderTimeOffUI() {
  slotGrid.innerHTML = "";

  const day = getSelectedDay();
  const slots = buildDaySlots(day);

  // Define common ranges
  const dayOffStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0, 0);
  const dayOffEnd   = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 17, 0, 0);

  const amStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0, 0);
  const amEnd   = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0);

  const pmStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 13, 0, 0);
  const pmEnd   = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 17, 0, 0);

  // highlight if exact blocks exist
  const dayOffOn = !!findExactTimeOffBlock(dayOffStart, dayOffEnd);
  const amOn = !!findExactTimeOffBlock(amStart, amEnd);
  const pmOn = !!findExactTimeOffBlock(pmStart, pmEnd);

  toggleDayBtn.classList.toggle("on", dayOffOn);
  toggleAmBtn.classList.toggle("on", amOn);
  togglePmBtn.classList.toggle("on", pmOn);

  // slot buttons show “blocked” if any time-off row overlaps that slot
  for (const s of slots) {
    const blockedByOverlap = timeOffRows.some(r => overlap(
      new Date(r.start_ts), new Date(r.end_ts),
      s.start, s.end
    ));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slotbtn" + (blockedByOverlap ? " on" : "");
    btn.textContent = s.label + (blockedByOverlap ? " • BLOCKED" : " • available");

    btn.addEventListener("click", () => toggleTimeOffBlock(s.start, s.end, "slot"));
    slotGrid.appendChild(btn);
  }
}

daySelect?.addEventListener("change", renderTimeOffUI);

toggleDayBtn?.addEventListener("click", () => {
  const day = getSelectedDay();
  const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0, 0);
  const e = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 17, 0, 0);
  toggleTimeOffBlock(s, e, "day");
});

toggleAmBtn?.addEventListener("click", () => {
  const day = getSelectedDay();
  const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0, 0);
  const e = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0);
  toggleTimeOffBlock(s, e, "am");
});

togglePmBtn?.addEventListener("click", () => {
  const day = getSelectedDay();
  const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 13, 0, 0);
  const e = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 17, 0, 0);
  toggleTimeOffBlock(s, e, "pm");
});

// ---------- bookings ----------
async function loadBookings(start, end) {
  if (!selectedTechId) return [];

  const { data, error } = await supabase
    .from("bookings")
    .select(`
      id,
      assigned_tech_id,
      window_start,
      window_end,
      status,
      appointment_type,
      job_ref,
      request_id,
      tech_notes,
      full_service_cents,
      collected_cents,
      booking_requests:request_id (
        id,
        name,
        phone,
        email,
        address,
        notes
      )
    `)
    .eq("assigned_tech_id", selectedTechId)
    .gte("window_start", start.toISOString())
    .lt("window_start", end.toISOString())
    .order("window_start", { ascending: true });

  if (error) throw error;
  return data || [];
}

function clearDetails() {
  activeBooking = null;
  if (activeCardEl) activeCardEl.classList.remove("active");
  activeCardEl = null;

  show(detailEmpty, true);
  show(detailWrap, false);
  show(statusBadge, false);

  show(detailError, false);
  setText(detailError, "");
  setText(saveState, "");
  if (actionRow) actionRow.innerHTML = "";
  if (techNotes) techNotes.value = "";
}

function makeCard(title, meta, badgeText) {
  const card = document.createElement("div");
  card.className = "card";

  const top = document.createElement("div");
  top.className = "card-top";

  const left = document.createElement("div");

  const t = document.createElement("div");
  t.className = "title";
  t.textContent = title;

  const m = document.createElement("div");
  m.className = "meta";
  m.textContent = meta;

  left.appendChild(t);
  left.appendChild(m);

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = badgeText;

  top.appendChild(left);
  top.appendChild(badge);

  card.appendChild(top);
  return card;
}

function selectBooking(b, cardEl) {
  activeBooking = b;
  if (activeCardEl) activeCardEl.classList.remove("active");
  activeCardEl = cardEl;
  activeCardEl.classList.add("active");

  show(detailEmpty, false);
  show(detailWrap, true);

  const req = b.booking_requests || {};
  const time = `${fmtDateTime(b.window_start)} – ${fmtTime(b.window_end)}`;

  setText(dTitle, `${req.name || "Customer"} — ${time}`);

  const metaLines = [];
  if (req.address) metaLines.push(`Address: ${req.address}`);
  if (req.phone) metaLines.push(`Phone: ${req.phone}`);
  if (req.email) metaLines.push(`Email: ${req.email}`);
  if (req.notes) metaLines.push(`Notes: ${req.notes}`);
  if (b.appointment_type) metaLines.push(`Type: ${b.appointment_type}`);
  if (b.job_ref) metaLines.push(`Job ref: ${b.job_ref}`);
  setText(dMeta, metaLines.join("\n"));

  setText(statusBadge, statusLabel(b.status));
  show(statusBadge, true);

  if (techNotes) techNotes.value = b.tech_notes || "";
  setText(saveState, "");
  show(detailError, false);
  setText(detailError, "");

  renderBookingActions(req);
}

async function setJobStatus(bookingId, newStatus) {
  try {
    const { error } = await supabase
      .from("bookings")
      .update({ status: newStatus })
      .eq("id", bookingId);

    if (error) throw error;

    if (activeBooking && activeBooking.id === bookingId) {
      activeBooking.status = newStatus;
      setText(statusBadge, statusLabel(newStatus));
    }

    // refresh lists + stats (status changes move cards around)
    refreshBookingsOnly();
  } catch (e) {
    console.error(e);
    show(detailError, true);
    setText(detailError, `Could not update status: ${e?.message || e}`);
  }
}

function renderBookingActions(req) {
  if (!actionRow) return;
  actionRow.innerHTML = "";

  const buttons = [
    ["scheduled", "Scheduled"],
    ["en_route", "En Route"],
    ["on_site", "On Site"],
    ["parts_needed", "Parts Needed"],
    ["return_visit", "Return Visit"],
    ["completed", "Completed"],
  ];

  for (const [key, label] of buttons) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost";
    b.textContent = label;
    b.addEventListener("click", () => {
      if (!activeBooking) return;
      setJobStatus(activeBooking.id, key);
    });
    actionRow.appendChild(b);
  }

  const phone = cleanPhone(req?.phone);
  const address = req?.address || "";

  if (phone) {
    const call = document.createElement("a");
    call.className = "btn secondary";
    call.href = `tel:${phone}`;
    call.textContent = "Call";
    call.target = "_blank";
    actionRow.appendChild(call);

    const sms = document.createElement("a");
    sms.className = "btn secondary";
    sms.href = `sms:${phone}`;
    sms.textContent = "Text";
    sms.target = "_blank";
    actionRow.appendChild(sms);
  }

  if (address) {
    const maps = document.createElement("a");
    maps.className = "btn secondary";
    maps.href = mapsUrl(address);
    maps.textContent = "Maps";
    maps.target = "_blank";
    actionRow.appendChild(maps);
  }

  if (req?.email) {
    const em = document.createElement("a");
    em.className = "btn secondary";
    em.href = `mailto:${req.email}`;
    em.textContent = "Email";
    em.target = "_blank";
    actionRow.appendChild(em);
  }
}

async function saveNotes() {
  if (!activeBooking) return;

  setText(saveState, "Saving…");
  show(detailError, false);
  setText(detailError, "");

  try {
    const newNotes = techNotes?.value || "";
    const { error } = await supabase
      .from("bookings")
      .update({ tech_notes: newNotes })
      .eq("id", activeBooking.id);

    if (error) throw error;

    activeBooking.tech_notes = newNotes;
    setText(saveState, "Saved.");
    setTimeout(() => setText(saveState, ""), 1500);
  } catch (e) {
    console.error(e);
    setText(saveState, "");
    show(detailError, true);
    setText(detailError, `Could not save notes: ${e?.message || e}`);
  }
}
saveNotesBtn?.addEventListener("click", saveNotes);

function renderBookingsLists() {
  upcomingList.innerHTML = "";
  partsList.innerHTML = "";
  completedList.innerHTML = "";
  clearDetails();

  const now = new Date();

  const upcoming = [];
  const parts = [];
  const completed = [];

  for (const b of bookingsRows) {
    const st = statusLabel(b.status);

    if (st === "completed") completed.push(b);
    else if (st === "parts_needed" || st === "return_visit") parts.push(b);
    else {
      // treat scheduled-ish things as upcoming (even if in the past, admin is reviewing range)
      upcoming.push(b);
    }
  }

  show(upcomingEmpty, upcoming.length === 0);
  show(partsEmpty, parts.length === 0);
  show(completedEmpty, completed.length === 0);

  const renderGroup = (arr, targetEl) => {
    for (const b of arr) {
      const req = b.booking_requests || {};
      const title = `${fmtDate(b.window_start)} • ${fmtTime(b.window_start)}–${fmtTime(b.window_end)} — ${req.name || "Customer"}`;
      const meta = [
        req.address || "",
        req.phone ? `📞 ${req.phone}` : "",
        b.job_ref ? `• ${b.job_ref}` : "",
        b.appointment_type ? `• ${b.appointment_type}` : ""
      ].filter(Boolean).join(" ");

      const c = makeCard(title, meta, statusLabel(b.status));
      c.addEventListener("click", () => selectBooking(b, c));
      targetEl.appendChild(c);
    }
  };

  renderGroup(upcoming, upcomingList);
  renderGroup(parts, partsList);
  renderGroup(completed, completedList);

  // stats
  const completedCount = completed.length;
  const fullServiceCount = bookingsRows.filter(b => (Number(b.full_service_cents) || 0) > 0).length;
  const collectedSum = bookingsRows.reduce((acc, b) => acc + (Number(b.collected_cents) || 0), 0);

  setText(statCompleted, String(completedCount));
  setText(statFullService, String(fullServiceCount));
  setText(statCollected, String(collectedSum));
}

async function refreshBookingsOnly() {
  show(bookingsError, false);
  setText(bookingsError, "");

  try {
    const { start, end } = weekRange(weekAnchor);
    bookingsRows = await loadBookings(start, end);
    renderBookingsLists();
  } catch (e) {
    console.error(e);
    show(bookingsError, true);
    setText(bookingsError, `Failed to load bookings: ${e?.message || e}`);
  }
}

// ---------- master refresh ----------
async function refreshAll() {
  setText(rangeLabel, "Loading…");
  show(bookingsError, false);
  setText(bookingsError, "");
  show(timeoffError, false);
  setText(timeoffError, "");

  const { start, end } = weekRange(weekAnchor);

  const dayStr = start.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const endMinus1 = new Date(end); endMinus1.setDate(endMinus1.getDate() - 1);
  const endStr = endMinus1.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  setText(rangeLabel, `${dayStr} – ${endStr} • ${tzNameSafe()}`);

  fillDaySelect(start);

  // load time off + bookings in parallel
  try {
    const [tRows, bRows] = await Promise.all([
      loadTimeOff(start, end),
      loadBookings(start, end)
    ]);
    timeOffRows = tRows;
    bookingsRows = bRows;

    renderTimeOffUI();
    renderBookingsLists();
  } catch (e) {
    console.error(e);
    // show the most useful error
    show(bookingsError, true);
    setText(bookingsError, `Failed to load data: ${e?.message || e}`);
  }
}

// ---------- main ----------
async function main() {
  const sess = await requireAdmin();
  if (!sess) return;

  sessionUser = sess.user;
  setText(whoami, sessionUser?.email || "Signed in");

  setWeekAnchor(new Date());
  await loadTechOptions();
  await refreshAll();
}

main();
