import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey || String(supabaseAnonKey).includes("PASTE_YOUR_ANON_KEY_HERE")) {
  console.error("Missing Supabase config on window.__SUPABASE_URL__ / __SUPABASE_ANON_KEY__");
  alert("Missing Supabase config. Open tech.html and paste your anon key.");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// UI refs
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");

const unassignedPill = document.getElementById("unassignedPill");
const rangeLabel = document.getElementById("rangeLabel");
const jobsList = document.getElementById("jobsList");
const jobsEmpty = document.getElementById("jobsEmpty");
const jobsError = document.getElementById("jobsError");

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

let activeBooking = null;
let activeCardEl = null;

// Helpers
function show(el, on = true) { el.style.display = on ? "" : "none"; }
function setText(el, txt) { el.textContent = txt ?? ""; }

function fmtDateTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return String(ts); }
}

function cleanPhone(p) {
  if (!p) return "";
  return String(p).replace(/[^\d+]/g, "");
}

function mapsUrl(address) {
  const q = encodeURIComponent(address || "");
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function statusLabel(s) {
  const v = (s || "").toLowerCase();
  if (!v) return "scheduled";
  return v;
}

// Date window: today → next 7 days (inclusive-ish)
function getRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "/login.html";
    return null;
  }
  return session;
}

async function loadMe(session) {
  const email = session.user?.email || "Signed in";
  setText(whoami, email);
}

async function logout() {
  await supabase.auth.signOut();
  window.location.href = "/login.html";
}

logoutBtn?.addEventListener("click", logout);

async function loadUnassignedCount({ start, end }) {
  // IMPORTANT: techs can see only the count. This still depends on RLS.
  // If RLS blocks this, admin can create a view/RPC later. For now: we try.
  try {
    // We count "unassigned within time window"
    const { count, error } = await supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .is("assigned_tech_id", null)
      .gte("window_start", start.toISOString())
      .lt("window_start", end.toISOString());

    if (error) throw error;
    setText(unassignedPill, `Unassigned this week: ${count ?? 0}`);
  } catch (e) {
    console.warn("Unassigned count failed (likely RLS).", e);
    setText(unassignedPill, "Unassigned this week: —");
  }
}

function clearDetails() {
  activeBooking = null;
  if (activeCardEl) activeCardEl.classList.remove("active");
  activeCardEl = null;

  show(detailEmpty, true);
  show(detailWrap, false);
  show(statusBadge, false);
  setText(detailError, "");
  show(detailError, false);
  setText(saveState, "");
  techNotes.value = "";
  actionRow.innerHTML = "";
}

function renderActions(req) {
  actionRow.innerHTML = "";

  const phoneRaw = req?.phone || "";
  const phone = cleanPhone(phoneRaw);
  const address = req?.address || "";

  // Call
  if (phone) {
    const a = document.createElement("a");
    a.className = "action-link";
    a.href = `tel:${phone}`;
    a.textContent = "Call";
    a.target = "_blank";
    actionRow.appendChild(a);

    // Text (optional)
    const s = document.createElement("a");
    s.className = "action-link";
    s.href = `sms:${phone}`;
    s.textContent = "Text";
    s.target = "_blank";
    actionRow.appendChild(s);
  }

  // Maps
  if (address) {
    const m = document.createElement("a");
    m.className = "action-link";
    m.href = mapsUrl(address);
    m.textContent = "Open in Maps";
    m.target = "_blank";
    actionRow.appendChild(m);
  }

  // Email
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
  const time = `${fmtDateTime(b.window_start)} – ${fmtDateTime(b.window_end)}`;

  setText(dTitle, `${req.name || "Customer"} — ${time}`);
  setText(dMeta, [
    req.address ? `Address: ${req.address}` : null,
    req.phone ? `Phone: ${req.phone}` : null,
    req.email ? `Email: ${req.email}` : null,
    req.notes ? `Notes: ${req.notes}` : null,
    b.appointment_type ? `Type: ${b.appointment_type}` : null,
    b.job_ref ? `Job ref: ${b.job_ref}` : null,
  ].filter(Boolean).join("\n"));

  // status badge
  setText(statusBadge, statusLabel(b.status));
  show(statusBadge, true);

  // notes
  techNotes.value = b.tech_notes || "";

  // actions
  renderActions(req);

  setText(saveState, "");
  show(detailError, false);
  setText(detailError, "");
}

function renderJobs(rows) {
  jobsList.innerHTML = "";
  clearDetails();

  if (!rows || rows.length === 0) {
    show(jobsEmpty, true);
    return;
  }
  show(jobsEmpty, false);

  for (const b of rows) {
    const req = b.booking_requests || {};
    const card = document.createElement("div");
    card.className = "job-card";

    const title = document.createElement("div");
    title.className = "job-title";
    title.textContent = `${fmtDateTime(b.window_start)} — ${req.name || "Customer"}`;

    const meta = document.createElement("div");
    meta.className = "job-meta";
    meta.textContent = [
      req.address || "",
      req.phone ? `📞 ${req.phone}` : "",
      b.appointment_type ? `• ${b.appointment_type}` : "",
      b.status ? `• ${b.status}` : "",
    ].filter(Boolean).join(" ");

    const top = document.createElement("div");
    top.className = "job-top";

    const left = document.createElement("div");
    left.appendChild(title);
    left.appendChild(meta);

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = statusLabel(b.status);

    top.appendChild(left);
    top.appendChild(badge);

    card.appendChild(top);

    card.addEventListener("click", () => selectBooking(b, card));

    jobsList.appendChild(card);
  }
}

async function loadAssigned({ start, end }) {
  show(jobsError, false);
  setText(jobsError, "");

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
      assigned_tech_id,
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

  // RLS should already restrict to "assigned_tech_id = auth.uid()" for techs
  return data || [];
}

async function saveNotes() {
  if (!activeBooking) return;

  setText(saveState, "Saving…");
  show(detailError, false);
  setText(detailError, "");

  try {
    const newNotes = techNotes.value || "";

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
    setText(detailError, "Could not save notes. (Permissions / RLS?)");
  }
}

saveNotesBtn?.addEventListener("click", saveNotes);

async function main() {
  const session = await requireAuth();
  if (!session) return;

  await loadMe(session);

  const { start, end } = getRange();
  setText(rangeLabel, `${start.toLocaleDateString()} → ${end.toLocaleDateString()}`);

  // count unassigned (best effort)
  loadUnassignedCount({ start, end });

  // load assigned jobs
  try {
    const rows = await loadAssigned({ start, end });
    renderJobs(rows);
  } catch (e) {
    console.error(e);
    show(jobsError, true);
    setText(jobsError, "Could not load jobs (permissions / RLS / network).");
  }
}

main();
