import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const jobsListEl = document.getElementById("jobsList");
const jobDetailsEl = document.getElementById("jobDetails");
const jobActionsEl = document.getElementById("jobActions");
const techNotesEl = document.getElementById("techNotes");
const btnSaveNotes = document.getElementById("btnSaveNotes");

const btnEnRoute = document.getElementById("btnEnRoute");
const btnStart = document.getElementById("btnStart");
const btnComplete = document.getElementById("btnComplete");
const btnReschedule = document.getElementById("btnReschedule");

const logoutBtn = document.getElementById("logoutBtn");
logoutBtn.addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.href = "/login.html";
});

let selectedBooking = null;

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function todayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function requireSession() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) window.location.href = "/login.html";
  return data.session;
}

async function loadToday() {
  const session = await requireSession();
  const uid = session.user.id;
  const { start, end } = todayRange();

  jobsListEl.textContent = "Loading…";
  jobDetailsEl.textContent = "Select a job.";
  jobActionsEl.style.display = "none";
  btnSaveNotes.style.display = "none";
  selectedBooking = null;

  // NOTE: this join works if bookings.request_id -> booking_requests.id is a real FK
  const { data, error } = await supabase
    .from("bookings")
    .select(`
      id,
      window_start,
      window_end,
      status,
      tech_notes,
      request_id,
      booking_requests:request_id (
        name,
        phone,
        email,
        address,
        notes,
        appointment_type
      )
    `)
    .eq("assigned_tech_id", uid)
    .gte("window_start", start)
    .lt("window_start", end)
    .order("window_start", { ascending: true });

  if (error) {
    jobsListEl.textContent = "Error loading jobs: " + error.message;
    return;
  }

  if (!data || data.length === 0) {
    jobsListEl.textContent = "No assigned jobs today.";
    return;
  }

  jobsListEl.innerHTML = "";
  data.forEach((b) => {
    const r = b.booking_requests || {};
    const div = document.createElement("div");
    div.style.padding = "10px 0";
    div.style.borderBottom = "1px solid rgba(255,255,255,0.10)";
    div.style.cursor = "pointer";
    div.innerHTML = `
      <div style="font-weight:900;">${fmtTime(b.window_start)}–${fmtTime(b.window_end)} • ${r.name || "Customer"}</div>
      <div style="opacity:.8;">${r.address || ""}</div>
      <div style="opacity:.8;">Status: <b>${b.status || "scheduled"}</b></div>
    `;
    div.addEventListener("click", () => selectBooking(b));
    jobsListEl.appendChild(div);
  });
}

function selectBooking(b) {
  selectedBooking = b;
  const r = b.booking_requests || {};

  jobDetailsEl.innerHTML = `
    <div style="font-weight:900; font-size:14px; margin-bottom:6px;">
      ${fmtTime(b.window_start)}–${fmtTime(b.window_end)} • ${r.name || ""}
    </div>
    <div><b>Phone:</b> ${r.phone || ""}</div>
    <div><b>Address:</b> ${r.address || ""}</div>
    <div><b>Type:</b> ${r.appointment_type || ""}</div>
    <div style="margin-top:8px; opacity:.85;"><b>Customer notes:</b><br/>${(r.notes || "").replaceAll("\n","<br/>")}</div>
    <div style="margin-top:8px;"><b>Status:</b> ${b.status || "scheduled"}</div>
  `;

  techNotesEl.value = b.tech_notes || "";
  jobActionsEl.style.display = "block";
  btnSaveNotes.style.display = "block";
}

async function setStatus(newStatus) {
  if (!selectedBooking) return;

  const patch = { status: newStatus };
  const nowIso = new Date().toISOString();

  if (newStatus === "in_progress" && !selectedBooking.started_at) patch.started_at = nowIso;
  if (newStatus === "completed") patch.completed_at = nowIso;

  const { error } = await supabase
    .from("bookings")
    .update(patch)
    .eq("id", selectedBooking.id);

  if (error) {
    alert("Failed to update status: " + error.message);
    return;
  }

  await loadToday();
}

btnEnRoute.addEventListener("click", () => setStatus("en_route"));
btnStart.addEventListener("click", () => setStatus("in_progress"));
btnComplete.addEventListener("click", () => setStatus("completed"));
btnReschedule.addEventListener("click", () => setStatus("needs_reschedule"));

btnSaveNotes.addEventListener("click", async () => {
  if (!selectedBooking) return;
  const { error } = await supabase
    .from("bookings")
    .update({ tech_notes: techNotesEl.value })
    .eq("id", selectedBooking.id);

  if (error) return alert("Failed to save notes: " + error.message);
  alert("Saved.");
});

loadToday();
