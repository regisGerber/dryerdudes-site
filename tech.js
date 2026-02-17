import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/**
 * TECH PORTAL (calendar-like)
 * - Shows assigned bookings (details + actions)
 * - Shows OPEN SLOT placeholders (no DB query)
 * - Toggle: Today vs Next 7 Days
 * - Basic status buttons
 */

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and __SUPABASE_ANON_KEY__ in tech.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ------- UI (these ids must exist in tech.html) -------
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");

const viewTodayBtn = document.getElementById("viewTodayBtn");
const viewWeekBtn = document.getElementById("viewWeekBtn");

const rangeLabel = document.getElementById("rangeLabel");

const jobsList = document.getElementById("jobsList");
const jobsEmpty = document.getElementById("jobsEmpty");
const jobsError = document.getElementById("jobsError");

// Details panel ids
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

// ------- state -------
let mode = "today"; // "today" | "week"
let activeBooking = null;
let activeCardEl = null;

// ------- helpers -------
function show(el, on = true) { if (el) el.style.display = on ? "" : "none"; }
function setText(el, t) { if (el) el.textContent = t ?? ""; }

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

function overlaps(slot, booking) {
  const s = slot.start.getTime();
  const e = slot.end.getTime();
  const bs = new Date(booking.window_start).getTime();
  const be = new Date(booking.window_end).getTime();
  return bs < e && be > s;
}

// ------- slots (EDIT THIS if you want different windows) -------
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
    mk(10, 0, 12, 0, "10:00–12:00"),
    mk(12, 0, 14, 0, "12:00–2:00"),
    mk(14, 0, 16, 0, "2:00–4:00"),
  ];
}

// ------- auth -------
async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "/login.html";
    return null;
  }
  return session;
}

async function logout() {
  await supabase.auth.signOut();
  window.location.href = "/login.html";
}

logoutBtn?.addEventListener("click", logout);

// ------- data -------
function getRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start);

  if (mode === "today") end.setDate(end.getDate() + 1);
  else end.setDate(end.getDate() + 7);

  return { start, end };
}

async function loadAssigned(start, end) {
  // Assumes RLS restricts techs to only their assigned bookings.
  const { data, error } = await supabase
    .from("bookings")
    .select(`
      id,
      window_start,
      window_end,
      status,
      appointment_type,
      job_ref,
      tech_notes,
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

  if (error) throw error;
  return data || [];
}

// ------- details -------
function clearDetails() {
  activeBooking = null;
  if (activeCardEl) activeCardEl.classList.remove("active");
  activeCardEl = null;

  show(detailEmpty, true);
  show(detailWrap, false);
  show(statusBadge, false);

  setText(detailError, "");
  show(detailError, false);

  if (techNotes) techNotes.value = "";
  setText(saveState, "");
  if (actionRow) actionRow.innerHTML = "";
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
  } catch (e) {
    console.error(e);
    show(detailError, true);
    setText(detailError, "Could not update status (RLS/permissions?).");
  }
}

function renderActions(req) {
  if (!actionRow) return;
  actionRow.innerHTML = "";

  // status buttons
  const buttons = [
    ["scheduled", "Scheduled"],
    ["en_route", "En Route"],
    ["on_site", "On Site"],
    ["completed", "Completed"],
  ];

  for (const [key, label] of buttons) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "action-link";
    b.textContent = label;
    b.addEventListener("click", () => {
      if (!activeBooking) return;
      setJobStatus(activeBooking.id, key);
    });
    actionRow.appendChild(b);
  }

  // quick links
  const phone = cleanPhone(req?.phone);
  const address = req?.address || "";

  if (phone) {
    const a = document.createElement("a");
    a.className = "action-link";
    a.href = `tel:${phone}`;
    a.textContent = "Call";
    a.target = "_blank";
    actionRow.appendChild(a);

    const s = document.createElement("a");
    s.className = "action-link";
    s.href = `sms:${phone}`;
    s.textContent = "Text";
    s.target = "_blank";
    actionRow.appendChild(s);
  }

  if (address) {
    const m = document.createElement("a");
    m.className = "action-link";
    m.href = mapsUrl(address);
    m.textContent = "Open in Maps";
    m.target = "_blank";
    actionRow.appendChild(m);
  }

  if (req?.email) {
    const e = document.createElement("a");
    e.className = "action-link";
    e.href = `mailto:${req.email}`;
    e.textContent = "Email";
    e.target = "_blank";
    actionRow.appendChild(e);
  }
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

  // NOTE: this relies on CSS to show newlines nicely; if yours doesn’t,
  // we’ll fix with a small CSS tweak (white-space: pre-line).
  setText(dMeta, metaLines.join("\n"));

  setText(statusBadge, statusLabel(b.status));
  show(statusBadge, true);

  if (techNotes) techNotes.value = b.tech_notes || "";
  setText(saveState, "");
  show(detailError, false);
  setText(detailError, "");

  renderActions(req);
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
    setText(detailError, "Could not save notes (RLS/permissions?).");
  }
}

saveNotesBtn?.addEventListener("click", saveNotes);

// ------- card rendering -------
function makeCard(title, meta, badgeText, clickable = true) {
  const card = document.createElement("div");
  card.className = "job-card";
  if (!clickable) card.style.cursor = "default";

  const top = document.createElement("div");
  top.className = "job-top";

  const left = document.createElement("div");

  const t = document.createElement("div");
  t.className = "job-title";
  t.textContent = title;

  const m = document.createElement("div");
  m.className = "job-meta";
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

function renderToday(bookings) {
  if (jobsList) jobsList.innerHTML = "";
  clearDetails();

  // Today mode always shows placeholders, so we normally don't show "empty"
  show(jobsEmpty, false);

  const today = new Date();
  const slots = buildDaySlots(today);

  for (const slot of slots) {
    const inSlot = bookings.filter(b => overlaps(slot, b));

    if (inSlot.length === 0) {
      const c = makeCard(`${slot.label} — Open`, "Not booked", "open", false);
      jobsList?.appendChild(c);
      continue;
    }

    for (const b of inSlot) {
      const req = b.booking_requests || {};
      const meta = [
        req.address || "",
        req.phone ? `📞 ${req.phone}` : "",
        b.appointment_type ? `• ${b.appointment_type}` : ""
      ].filter(Boolean).join(" ");

      const c = makeCard(`${slot.label} — ${req.name || "Customer"}`, meta, statusLabel(b.status), true);
      c.addEventListener("click", () => selectBooking(b, c));
      jobsList?.appendChild(c);
    }
  }
}

function renderWeek(bookings) {
  if (jobsList) jobsList.innerHTML = "";
  clearDetails();

  if (!bookings.length) {
    show(jobsEmpty, true);
    return;
  }
  show(jobsEmpty, false);

  let currentDay = "";
  for (const b of bookings) {
    const day = fmtDate(b.window_start);
    if (day !== currentDay) {
      currentDay = day;
      const header = document.createElement("div");
      header.className = "tiny";
      header.style.marginTop = "8px";
      header.style.opacity = "0.9";
      header.textContent = day;
      jobsList?.appendChild(header);
    }

    const req = b.booking_requests || {};
    const meta = [
      req.address || "",
      req.phone ? `📞 ${req.phone}` : "",
      b.appointment_type ? `• ${b.appointment_type}` : ""
    ].filter(Boolean).join(" ");

    const title = `${fmtTime(b.window_start)} – ${fmtTime(b.window_end)} — ${req.name || "Customer"}`;
    const c = makeCard(title, meta, statusLabel(b.status), true);
    c.addEventListener("click", () => selectBooking(b, c));
    jobsList?.appendChild(c);
  }
}

// ------- main load -------
async function loadAndRender() {
  show(jobsError, false);
  setText(jobsError, "");
  show(jobsEmpty, false);

  const { start, end } = getRange();
  setText(rangeLabel, `${start.toLocaleDateString()} → ${end.toLocaleDateString()}`);

  try {
    const rows = await loadAssigned(start, end);
    if (mode === "today") renderToday(rows);
    else renderWeek(rows);
  } catch (e) {
    console.error(e);
    show(jobsError, true);
    setText(jobsError, "Failed to load bookings (RLS/permissions/network).");
  }
}

function setMode(newMode) {
  mode = newMode;

  if (viewTodayBtn) viewTodayBtn.style.opacity = mode === "today" ? "1" : "0.75";
  if (viewWeekBtn) viewWeekBtn.style.opacity = mode === "week" ? "1" : "0.75";

  loadAndRender();
}

viewTodayBtn?.addEventListener("click", () => setMode("today"));
viewWeekBtn?.addEventListener("click", () => setMode("week"));

async function main() {
  const session = await requireAuth();
  if (!session) return;

  setText(whoami, session.user?.email || "Signed in");

  setMode("today");
}

main();
