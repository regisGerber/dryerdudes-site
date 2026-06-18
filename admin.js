import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and window.__SUPABASE_ANON_KEY__ in admin.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

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

const refreshPmRequestsBtn = document.getElementById("refreshPmRequestsBtn");
const pmRequestsList = document.getElementById("pmRequestsList");
const pmRequestsEmpty = document.getElementById("pmRequestsEmpty");
const pmRequestsError = document.getElementById("pmRequestsError");

const refreshJobHelpRequestsBtn = document.getElementById("refreshJobHelpRequestsBtn");
const jobHelpRequestsList = document.getElementById("jobHelpRequestsList");
const jobHelpRequestsEmpty = document.getElementById("jobHelpRequestsEmpty");
const jobHelpRequestsError = document.getElementById("jobHelpRequestsError");

const refreshBookingFailuresBtn = document.getElementById("refreshBookingFailuresBtn");
const bookingFailuresList = document.getElementById("bookingFailuresList");
const bookingFailuresEmpty = document.getElementById("bookingFailuresEmpty");
const bookingFailuresError = document.getElementById("bookingFailuresError");

const refreshPartsOnOrderBtn = document.getElementById("refreshPartsOnOrderBtn");
const partsOnOrderList = document.getElementById("partsOnOrderList");
const partsOnOrderEmpty = document.getElementById("partsOnOrderEmpty");
const partsOnOrderError = document.getElementById("partsOnOrderError");

const jobSearchInput = document.getElementById("jobSearchInput");
const jobSearchBtn = document.getElementById("jobSearchBtn");
const jobSearchClearBtn = document.getElementById("jobSearchClearBtn");
const jobSearchResults = document.getElementById("jobSearchResults");

// ---------- State ----------
let currentAdminSession = null;
let viewMode = "week";
let overlayAll = true;
let focusTechId = "all";
let anchorDate = new Date();
let techRows = [];
let selectedCell = null;
let selectedSlotEl = null;

// ---------- Helpers ----------
function show(el, on = true) {
  if (el) el.style.display = on ? "" : "none";
}

function setText(el, text) {
  if (el) el.textContent = text ?? "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtMoneyCents(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(0)}`;
}

function fmtMoneyCentsExact(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function fmtDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDay(date) {
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtTimeLabel(h1, m1, h2, m2) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${h1}:${pad(m1)}–${h2}:${pad(m2)}`;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function tzNameSafe() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "en_route") return "en route";
  if (s === "on_site") return "on site";
  if (s === "billing_pending") return "ready to complete";
  if (s === "awaiting_payment") return "awaiting payment";
  if (s === "parts_approval_needed") return "approval needed";
  if (s === "parts_on_order") return "parts on order";
  if (s === "return_visit_needed") return "return visit";
  if (s === "no_show") return "no show";
  return s || "scheduled";
}

function topicLabel(topic) {
  const t = String(topic || "").toLowerCase();
  const labels = {
    reschedule: "Rescheduling",
    cancel: "Cancellation",
    payment: "Payment",
    arrival_window: "Arrival window",
    preparation: "Preparation",
    service_scope: "Service scope",
    property_manager: "Property manager / tenant",
    warranty: "Warranty review",
    other: "Other",
  };
  return labels[t] || t || "Other";
}

function partsStatusLabel(value) {
  const v = String(value || "").toLowerCase();
  if (v === "awaiting_payment") return "awaiting payment";
  if (v === "tech_receiving") return "ordered to tech";
  if (v === "customer_receiving") return "ordered to customer";
  if (v === "tech_has_part") return "tech has part";
  if (v === "customer_has_part") return "customer has part";
  if (v === "return_visit_ready") return "return visit booked";
  return v || "parts on order";
}

function isReturnVisitBooked(booking) {
  return (
    booking?._return_visit_booked === true ||
    String(booking?._part_status || "").toLowerCase() === "return_visit_ready"
  );
}

function scheduleStatusLabel(booking) {
  if (isReturnVisitBooked(booking)) return "return visit booked";
  return statusLabel(booking?.status);
}

function isAttentionStatus(booking) {
  if (isReturnVisitBooked(booking)) return false;

  const s = String(booking?.status || "").toLowerCase();
  return [
    "awaiting_payment",
    "billing_pending",
    "parts_approval_needed",
    "parts_on_order",
    "return_visit_needed",
    "escalated",
  ].includes(s);
}

function scheduleCardNeedsWarning(booking) {
  return !isReturnVisitBooked(booking) && isAttentionStatus(booking);
}

function attachReturnVisitFlags(bookings, partsRows) {
  const map = new Map();

  for (const row of Array.isArray(partsRows) ? partsRows : []) {
    if (String(row.part_status || "").toLowerCase() === "return_visit_ready" && row.booking_id) {
      map.set(String(row.booking_id), row);
    }
  }

  return (Array.isArray(bookings) ? bookings : []).map((booking) => {
    const partsRow = map.get(String(booking.id));
    if (!partsRow) return booking;
    return {
      ...booking,
      _return_visit_booked: true,
      _part_status: partsRow.part_status,
      _part_delivery_destination: partsRow.part_delivery_destination || null,
      _parts_workflow: partsRow,
    };
  });
}

function buildDaySlots(dateObj) {
  const base = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0);

  function mk(h1, m1, h2, m2, label, idx) {
    return {
      slot_index: idx,
      label,
      start: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h1, m1, 0),
      end: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h2, m2, 0),
      start_h: h1,
      start_m: m1,
      end_h: h2,
      end_m: m2,
    };
  }

  return [
    mk(8, 0, 10, 0, "A", 1),
    mk(8, 30, 10, 30, "B", 2),
    mk(9, 30, 11, 30, "C", 3),
    mk(10, 0, 12, 0, "D", 4),
    mk(13, 0, 15, 0, "E", 5),
    mk(13, 30, 15, 30, "F", 6),
    mk(14, 30, 16, 30, "G", 7),
    mk(15, 0, 17, 0, "H", 8),
  ];
}

function startOfWeekMon(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function getRangeForView() {
  const tz = tzNameSafe();

  if (viewMode === "day") {
    const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(), 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end, label: `${fmtDay(start)} • ${tz}` };
  }

  if (viewMode === "month") {
    const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1, 0, 0, 0);
    const end = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1, 0, 0, 0);
    return {
      start,
      end,
      label: `${start.toLocaleDateString([], { month: "long", year: "numeric" })} • ${tz}`,
    };
  }

  const mon = startOfWeekMon(anchorDate);
  const end = new Date(mon);
  end.setDate(end.getDate() + 7);
  const fri = new Date(mon);
  fri.setDate(fri.getDate() + 4);
  return { start: mon, end, label: `${fmtDay(mon)} – ${fmtDay(fri)} • ${tz}` };
}

function selectedTechUserIds() {
  const rows = techRows.filter((t) => t.user_id);

  if (overlayAll || focusTechId === "all") {
    return rows.map((t) => t.user_id);
  }

  const tech = techRows.find((t) => t.id === focusTechId);
  return tech?.user_id ? [tech.user_id] : [];
}

function filterPartsRowsForSelection(rows) {
  const userIds = selectedTechUserIds().map(String);
  if (overlayAll || focusTechId === "all" || !userIds.length) return Array.isArray(rows) ? rows : [];
  const allowed = new Set(userIds);
  return (Array.isArray(rows) ? rows : []).filter((row) => allowed.has(String(row.assigned_tech_id || "")));
}

async function readJsonSafe(resp) {
  const text = await resp.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function setError(el, err, fallback) {
  console.error(err);
  show(el, true);
  setText(el, err?.message || fallback || "Something went wrong.");
}
// ---------- Auth ----------
async function getAdminAccessToken({ forceRefresh = false } = {}) {
  let session = currentAdminSession;

  if (!forceRefresh && !session?.access_token) {
    const { data } = await supabase.auth.getSession();
    session = data?.session || null;
  }

  const expiresAtMs = session?.expires_at ? session.expires_at * 1000 : 0;
  const expiresSoon = expiresAtMs && expiresAtMs - Date.now() < 2 * 60 * 1000;

  if (!session?.access_token || forceRefresh || expiresSoon) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data?.session?.access_token) session = data.session;
  }

  if (!session?.access_token) {
    currentAdminSession = null;
    await supabase.auth.signOut().catch(() => {});
    window.location.href = "/login.html";
    throw new Error("Admin session expired. Please log in again.");
  }

  currentAdminSession = session;
  if (session.user?.email) setText(whoami, session.user.email);
  return session.access_token;
}

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

  currentAdminSession = session;
  setText(whoami, session.user.email || "Signed in");
  return session;
}

supabase.auth.onAuthStateChange((_event, session) => {
  currentAdminSession = session || null;
  if (session?.user?.email) setText(whoami, session.user.email);
});

logoutBtn?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.href = "/login.html";
});

async function getAuthedJson(url, retry = true) {
  const token = await getAdminAccessToken();
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await readJsonSafe(resp);

  if (resp.status === 401 && retry) {
    await getAdminAccessToken({ forceRefresh: true });
    return getAuthedJson(url, false);
  }

  if (!resp.ok || json?.ok === false) {
    throw new Error(json?.message || json?.error || `Request failed (${resp.status}).`);
  }

  return json;
}

async function postAuthedJson(url, payload, retry = true) {
  const token = await getAdminAccessToken();
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload || {}),
  });
  const json = await readJsonSafe(resp);

  if (resp.status === 401 && retry) {
    await getAdminAccessToken({ forceRefresh: true });
    return postAuthedJson(url, payload, false);
  }

  if (!resp.ok || json?.ok === false) {
    throw new Error(json?.message || json?.error || `Request failed (${resp.status}).`);
  }

  return json;
}

// ---------- Loads ----------
async function loadTechs() {
  const { data, error } = await supabase
    .from("techs")
    .select("id,name,active,territory_notes,user_id")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) throw error;

  techRows = data || [];
  if (!focusTech) return;

  focusTech.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "All techs";
  focusTech.appendChild(optAll);

  for (const tech of techRows) {
    const opt = document.createElement("option");
    opt.value = tech.id;
    opt.textContent = tech.name || tech.id;
    focusTech.appendChild(opt);
  }

  if (techRows.length === 1) {
    focusTechId = techRows[0].id;
    focusTech.value = focusTechId;
  } else {
    focusTechId = "all";
    focusTech.value = "all";
  }
}

async function loadBookings(start, end) {
  const techUserIds = selectedTechUserIds();

  let q = supabase
    .from("bookings")
    .select(`
      id,
      request_id,
      window_start,
      window_end,
      status,
      appointment_type,
      zone_code,
      route_zone_code,
      collected_cents,
      base_fee_cents,
      full_service_cents,
      assigned_tech_id,
      job_ref,
      payment_status,
      invoice_status,
      request_source,
      property_manager_id,
      paid_by_property_manager,
      completed_at,
      booking_requests:request_id (
        id,
        name,
        address,
        phone,
        email,
        notes,
        authorized_entry,
        request_source,
        property_manager_id
      )
    `)
    .gte("window_start", start.toISOString())
    .lt("window_start", end.toISOString())
    .order("window_start", { ascending: true });

  if (techUserIds.length) q = q.in("assigned_tech_id", techUserIds);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function loadTimeOff(start, end) {
  const { data, error } = await supabase
    .from("tech_time_off")
    .select("id,tech_id,start_ts,end_ts,reason,type,service_date,slot_index,created_at")
    .gte("end_ts", start.toISOString())
    .lte("start_ts", end.toISOString())
    .order("start_ts", { ascending: true });

  if (error) throw error;

  return data || [];
}

async function loadPartsOnOrder() {
  if (!partsOnOrderList) return [];

  try {
    show(partsOnOrderError, false);
    setText(partsOnOrderError, "");
    const json = await getAuthedJson("/api/tech-list-parts-on-order");
    return Array.isArray(json.parts_jobs) ? json.parts_jobs : [];
  } catch (err) {
    setError(partsOnOrderError, err, "Could not load parts on order.");
    return [];
  }
}

// ---------- Parts panel ----------
function renderPartsOnOrder(rowsRaw) {
  if (!partsOnOrderList) return;

  const rows = filterPartsRowsForSelection(rowsRaw);
  partsOnOrderList.innerHTML = "";

  if (!rows.length) {
    show(partsOnOrderEmpty, true);
    return;
  }

  show(partsOnOrderEmpty, false);

  for (const row of rows) {
    const isReturnBooked = String(row.part_status || "").toLowerCase() === "return_visit_ready";
    const card = document.createElement("div");
    card.className = isReturnBooked ? "job-card" : "job-card warn";

    const destination = String(row.part_delivery_destination || "").toLowerCase() === "customer"
      ? "Customer delivery"
      : "Tech delivery";

    const metaLines = [
      row.job_ref ? `Job ref: ${row.job_ref}` : "",
      row.customer_name ? `Customer: ${row.customer_name}` : "",
      row.address ? `Address: ${row.address}` : "",
      `Part status: ${partsStatusLabel(row.part_status)}`,
      `Destination: ${destination}`,
      `Parts cost: ${fmtMoneyCentsExact(row.parts_cost_cents)}`,
      row.part_paid_at ? `Paid: ${fmtDateTime(row.part_paid_at)}` : "",
      row.part_ordered_at ? `Ordered: ${fmtDateTime(row.part_ordered_at)}` : "",
      row.return_visit_scheduled_at ? `Return visit booked: ${fmtDateTime(row.return_visit_scheduled_at)}` : "",
      row.part_tracking_notes ? `Notes: ${row.part_tracking_notes}` : "",
    ].filter(Boolean);

    const partStatus = String(row.part_status || "").toLowerCase();
    const canMarkOnHand =
      String(row.part_delivery_destination || "tech").toLowerCase() !== "customer" &&
      String(row.payment_status || "").toLowerCase() === "paid" &&
      ["tech_receiving", "ordered", "parts_on_order", ""].includes(partStatus);

    card.innerHTML = `
      <div class="job-top">
        <div>
          <div class="job-title">${escapeHtml(row.job_ref || "Parts job")} — ${escapeHtml(row.customer_name || "Customer")}</div>
          <div class="job-meta">${escapeHtml(metaLines.join("\n"))}</div>
        </div>
        <span class="badge ${isReturnBooked ? "" : "warn"}">${escapeHtml(partsStatusLabel(row.part_status))}</span>
      </div>
      <div class="actions">
        ${canMarkOnHand ? `<button class="action-link" type="button" data-action="part-on-hand">Mark part on hand</button>` : ""}
      </div>
    `;

    const btn = card.querySelector('[data-action="part-on-hand"]');
    btn?.addEventListener("click", async () => {
      const ok = confirm(`Mark part on hand for ${row.job_ref || "this job"}?\n\nThis will notify the customer that the part is ready and send the return visit scheduling link.`);
      if (!ok) return;

      try {
        btn.disabled = true;
        btn.textContent = "Sending…";
        await postAuthedJson("/api/tech-mark-part-on-hand", { booking_id: row.booking_id });
        await render();
      } catch (err) {
        alert(err?.message || "Could not mark part on hand.");
        btn.disabled = false;
        btn.textContent = "Mark part on hand";
      }
    });

    partsOnOrderList.appendChild(card);
  }
}
// ---------- Property manager requests ----------
function renderPmRequestCard(row) {
  const card = document.createElement("div");
  card.className = "job-card";

  const billing = [row.billing_address_line_1, row.billing_address_line_2, row.billing_city, row.billing_state, row.billing_zip]
    .filter(Boolean)
    .join(", ");

  card.innerHTML = `
    <div class="job-top">
      <div>
        <div class="job-title">${escapeHtml(row.company_name || "Property manager request")}</div>
        <div class="job-meta">${escapeHtml([
          row.contact_name || "",
          row.email ? `${row.email}${row.phone ? ` • ${row.phone}` : ""}` : (row.phone || ""),
          row.service_area ? `Service area: ${row.service_area}` : "",
          row.units ? `Units: ${row.units}` : "",
          row.default_job_approval_limit_cents != null ? `Approval limit: ${fmtMoneyCents(row.default_job_approval_limit_cents)}` : "",
          billing ? `Billing: ${billing}` : "",
          row.created_at ? `Submitted: ${fmtDateTime(row.created_at)}` : "",
        ].filter(Boolean).join("\n"))}</div>
      </div>
      <span class="badge">pending</span>
    </div>
    <div class="actions">
      <button class="action-link" type="button" data-action="approve">Approve</button>
      <button class="action-link" type="button" data-action="reject">Reject</button>
    </div>
  `;

  card.querySelector('[data-action="approve"]')?.addEventListener("click", () => handlePmRequest(row.id, "approve"));
  card.querySelector('[data-action="reject"]')?.addEventListener("click", () => handlePmRequest(row.id, "reject"));
  return card;
}

async function loadPmRequests() {
  if (!pmRequestsList) return;
  pmRequestsList.innerHTML = "";
  show(pmRequestsEmpty, false);
  show(pmRequestsError, false);

  try {
    const token = await getAdminAccessToken();
    const resp = await fetch("/api/admin-list-property-manager-requests", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await readJsonSafe(resp);
    if (!resp.ok || json?.ok === false) throw new Error(json?.message || json?.error || "Could not load property manager requests.");

    const rows = Array.isArray(json.requests) ? json.requests : [];
    if (!rows.length) {
      show(pmRequestsEmpty, true);
      return;
    }

    for (const row of rows) pmRequestsList.appendChild(renderPmRequestCard(row));
  } catch (err) {
    setError(pmRequestsError, err, "Could not load property manager requests.");
  }
}

async function handlePmRequest(requestId, action) {
  try {
    const token = await getAdminAccessToken();
    const resp = await fetch("/api/admin-handle-property-manager-request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ request_id: requestId, action }),
    });
    const json = await readJsonSafe(resp);
    if (!resp.ok || json?.ok === false) throw new Error(json?.message || json?.error || `Could not ${action} request.`);
    await loadPmRequests();
  } catch (err) {
    setError(pmRequestsError, err, `Could not ${action} request.`);
  }
}

// ---------- Job help requests ----------
function renderJobHelpCard(row) {
  const card = document.createElement("div");
  card.className = "job-card";

  const booking = row.bookings || {};
  const req = row.booking_requests || {};
  const isWarranty = String(row.predicted_answer_key || "").toLowerCase() === "warranty" || String(row.question || "").toUpperCase().includes("WARRANTY REVIEW REQUEST");

  if (isWarranty) card.classList.add("warn");

  const when = booking.window_start && booking.window_end
    ? `${fmtDateTime(booking.window_start)} – ${fmtTime(booking.window_end)}`
    : "No appointment time found";

  const lines = [
    `Job: ${row.job_ref || booking.job_ref || "—"}`,
    `Type: ${isWarranty ? "Warranty review" : topicLabel(row.topic)}`,
    `Status: ${row.status || "new"}`,
    `Customer: ${row.customer_name || req.name || "—"}`,
    `Email: ${row.customer_email || req.email || "—"}`,
    req.phone ? `Phone: ${req.phone}` : "",
    req.address ? `Address: ${req.address}` : "",
    `Appointment: ${when}`,
    row.predicted_answer_key ? `Answer viewed: ${row.predicted_answer_key}` : "",
    isWarranty ? "Admin note: Review original repair before scheduling warranty service." : "",
    row.created_at ? `Submitted: ${fmtDateTime(row.created_at)}` : "",
  ].filter(Boolean);

  card.innerHTML = `
    <div class="job-top">
      <div>
        <div class="job-title">${escapeHtml(isWarranty ? `Warranty review — ${row.job_ref || booking.job_ref || "Job"}` : (row.job_ref || booking.job_ref || "Job help request"))}</div>
        <div class="job-meta">${escapeHtml(lines.join("\n"))}</div>
      </div>
      <span class="badge ${isWarranty ? "warn" : ""}">${escapeHtml(isWarranty ? "warranty" : (row.status || "new"))}</span>
    </div>
    <div class="jobcard">${escapeHtml(row.question || "No question text")}</div>
    <div class="actions">
      <button class="action-link" type="button" data-action="in_review">In review</button>
      <button class="action-link" type="button" data-action="responded">Mark responded</button>
      <button class="action-link" type="button" data-action="resolved">Resolve</button>
      <button class="action-link" type="button" data-action="closed">Close</button>
    </div>
  `;

  card.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleJobHelpRequest(row.id, btn.dataset.action));
  });

  return card;
}

async function loadJobHelpRequests() {
  if (!jobHelpRequestsList) return;
  jobHelpRequestsList.innerHTML = "";
  show(jobHelpRequestsEmpty, false);
  show(jobHelpRequestsError, false);

  try {
    const json = await getAuthedJson("/api/admin-list-job-help-requests");
    const rows = Array.isArray(json.requests) ? json.requests : [];
    if (!rows.length) {
      show(jobHelpRequestsEmpty, true);
      return;
    }
    for (const row of rows) jobHelpRequestsList.appendChild(renderJobHelpCard(row));
  } catch (err) {
    setError(jobHelpRequestsError, err, "Could not load job help requests.");
  }
}

async function handleJobHelpRequest(id, action) {
  try {
    await postAuthedJson("/api/admin-handle-job-help-request", { id, action });
    await loadJobHelpRequests();
  } catch (err) {
    setError(jobHelpRequestsError, err, "Could not update job help request.");
  }
}

// ---------- Booking failures ----------
function refundText(row) {
  if (row.refund_issued) return `Refund issued${row.refund_id ? ` (${row.refund_id})` : ""}`;
  if (row.refund_attempted && row.refund_error) return `Refund attempted, error: ${row.refund_error}`;
  if (row.refund_attempted) return "Refund attempted";
  return "No refund recorded";
}

function failureBadgeClass(status) {
  const s = String(status || "new").toLowerCase();
  if (["new", "in_review"].includes(s)) return "badge danger-badge";
  if (s === "reviewed") return "badge warn";
  return "badge";
}

function renderBookingFailureCard(row) {
  const card = document.createElement("div");
  card.className = "job-card failure-card";

  const lines = [
    `Status: ${row.status || "new"}`,
    row.customer_name ? `Customer: ${row.customer_name}` : "",
    row.customer_email ? `Email: ${row.customer_email}` : "",
    row.job_ref ? `Job ref: ${row.job_ref}` : "",
    row.stripe_checkout_session_id ? `Stripe session: ${row.stripe_checkout_session_id}` : "",
    row.stripe_payment_intent_id ? `Payment intent: ${row.stripe_payment_intent_id}` : "",
    row.amount_cents != null ? `Amount: ${fmtMoneyCentsExact(row.amount_cents)}` : "",
    `Refund: ${refundText(row)}`,
    row.created_at ? `Created: ${fmtDateTime(row.created_at)}` : "",
  ].filter(Boolean);

  const errorText = row.finalize_error || row.error_message || row.error || "No error text recorded.";

  card.innerHTML = `
    <div class="job-top">
      <div>
        <div class="job-title">${escapeHtml(row.job_ref || row.stripe_checkout_session_id || "Booking finalization alert")}</div>
        <div class="job-meta">${escapeHtml(lines.join("\n"))}</div>
      </div>
      <span class="${failureBadgeClass(row.status)}">${escapeHtml(row.status || "new")}</span>
    </div>
    <div class="jobcard">${escapeHtml(errorText)}</div>
    ${row.admin_notes ? `<div class="jobcard">Admin notes:\n${escapeHtml(row.admin_notes)}</div>` : ""}
    <div class="actions">
      <button class="action-link" type="button" data-action="in_review">In review</button>
      <button class="action-link" type="button" data-action="reviewed">Reviewed</button>
      <button class="action-link" type="button" data-action="resolved">Resolved</button>
      <button class="action-link" type="button" data-action="closed">Close</button>
    </div>
  `;

  card.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleBookingFailure(row.id, btn.dataset.action));
  });

  return card;
}

async function loadBookingFailures() {
  if (!bookingFailuresList) return;
  bookingFailuresList.innerHTML = "";
  show(bookingFailuresEmpty, false);
  show(bookingFailuresError, false);

  try {
    const json = await getAuthedJson("/api/admin-list-booking-failures");
    const rows = Array.isArray(json.events) ? json.events : [];
    if (!rows.length) {
      show(bookingFailuresEmpty, true);
      return;
    }
    for (const row of rows) bookingFailuresList.appendChild(renderBookingFailureCard(row));
  } catch (err) {
    setError(bookingFailuresError, err, "Could not load booking finalization alerts.");
  }
}

async function handleBookingFailure(id, action) {
  try {
    await postAuthedJson("/api/admin-handle-booking-failure", { id, action });
    await loadBookingFailures();
  } catch (err) {
    setError(bookingFailuresError, err, "Could not update booking alert.");
  }
}
// ---------- Calendar details ----------
function clearSelectedCell() {
  selectedCell = null;
  if (selectedSlotEl) selectedSlotEl.classList.remove("selected");
  selectedSlotEl = null;

  show(detailBox, false);
  show(markOffFromDetailBtn, false);
  show(deleteOffFromDetailBtn, false);
  setText(detailHint, "Click any slot to see details here.");
}

function selectCell(dayDate, slot, bookingsForCell, offRowsForCell, slotEl) {
  if (selectedSlotEl) selectedSlotEl.classList.remove("selected");
  selectedSlotEl = slotEl;
  selectedSlotEl?.classList.add("selected");
  selectedCell = { dayDate, slot, bookings: bookingsForCell, offRows: offRowsForCell };

  const dateStr = fmtDay(dayDate);
  const timeStr = fmtTimeLabel(slot.start_h, slot.start_m, slot.end_h, slot.end_m);

  if (bookingsForCell.length) {
    const booking = bookingsForCell[0];
    const req = booking.booking_requests || {};
    const zone = booking.route_zone_code || booking.zone_code || "";

    const lines = [
      `${dateStr} • Slot ${slot.label} (${timeStr})`,
      "",
      `Customer: ${req.name || "—"}`,
      req.address ? `Address: ${req.address}` : "",
      req.phone ? `Phone: ${req.phone}` : "",
      req.email ? `Email: ${req.email}` : "",
      booking.job_ref ? `Job ref: ${booking.job_ref}` : "",
      zone ? `Zone: ${zone}` : "",
      `Status: ${scheduleStatusLabel(booking)}`,
      booking.appointment_type ? `Type: ${booking.appointment_type}` : "",
      booking.payment_status ? `Payment: ${booking.payment_status}` : "",
      booking.invoice_status ? `Invoice: ${booking.invoice_status}` : "",
      isReturnVisitBooked(booking) ? "Parts workflow: return visit booked" : "",
      req.notes ? `Customer / access details:\n${req.notes}` : "",
    ].filter(Boolean);

    setText(detailBox, lines.join("\n"));
    show(detailBox, true);
    setText(detailHint, "");
    show(markOffFromDetailBtn, false);
    show(deleteOffFromDetailBtn, false);
    return;
  }

  if (offRowsForCell.length) {
    const off = offRowsForCell[0];
    const techName = techRows.find((t) => t.id === off.tech_id)?.name || "Tech";
    setText(detailBox, [
      `${dateStr} • Slot ${slot.label} (${timeStr})`,
      "",
      `OFF: ${techName}`,
      off.reason ? `Reason: ${off.reason}` : "",
      `Type: ${off.type || "—"}`,
    ].filter(Boolean).join("\n"));
    show(detailBox, true);
    setText(detailHint, "");
    show(markOffFromDetailBtn, false);
    show(deleteOffFromDetailBtn, true);
    return;
  }

  setText(detailBox, [`${dateStr} • Slot ${slot.label} (${timeStr})`, "", "Open / Not booked"].join("\n"));
  show(detailBox, true);
  setText(detailHint, "");
  show(markOffFromDetailBtn, true);
  show(deleteOffFromDetailBtn, false);
}

function matchesSlot(slot, booking) {
  const s = slot.start.getTime();
  const e = slot.end.getTime();
  const bs = new Date(booking.window_start).getTime();
  const be = new Date(booking.window_end).getTime();
  return Math.abs(bs - s) <= 60_000 && Math.abs(be - e) <= 60_000;
}

function slotDiv({ kind, title, meta, badgeText, badgeClass = "" }) {
  const div = document.createElement("div");
  div.className = `slot ${kind}`;

  if (badgeText) {
    const badge = document.createElement("span");
    badge.className = `badge ${kind === "open" ? "gray" : ""} ${badgeClass || ""}`.trim();
    badge.textContent = badgeText;
    div.appendChild(badge);
  }

  const titleEl = document.createElement("div");
  titleEl.className = "slot-title";
  titleEl.textContent = title;
  div.appendChild(titleEl);

  const metaEl = document.createElement("div");
  metaEl.className = "slot-meta";
  metaEl.textContent = meta || "";
  div.appendChild(metaEl);

  return div;
}

function buildCellDiv(slot, cellBookings, cellOff) {
  if (cellOff.length) {
    return slotDiv({
      kind: "off",
      badgeText: "OFF",
      title: "Time off",
      meta: cellOff[0]?.reason ? `Reason: ${cellOff[0].reason}` : "",
    });
  }

  if (cellBookings.length) {
    const booking = cellBookings[0];
    const req = booking.booking_requests || {};
    const zone = booking.route_zone_code || booking.zone_code || "";
    return slotDiv({
      kind: "booked",
      badgeText: scheduleStatusLabel(booking),
      badgeClass: scheduleCardNeedsWarning(booking) ? "warn" : "",
      title: `${req.name || "Customer"}${zone ? ` • Zone ${zone}` : ""}`,
      meta: [req.address || "", isReturnVisitBooked(booking) ? "Return visit for ordered part" : ""].filter(Boolean).join("\n"),
    });
  }

  return slotDiv({
    kind: "open",
    badgeText: "Open",
    title: "Not booked",
    meta: "",
  });
}

function renderWeekGrid(monDate, bookings, timeOffRows) {
  const days = [];
  for (let i = 0; i < 5; i++) {
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

  for (const day of days) {
    const th = document.createElement("th");
    th.textContent = fmtDay(day);
    hr.appendChild(th);
  }

  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  const templateSlots = buildDaySlots(monDate);
  const onlyTech = !overlayAll && focusTechId !== "all" ? focusTechId : null;

  for (const slotTemplate of templateSlots) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.className = "timecol";
    tdTime.textContent = `${slotTemplate.label} • ${fmtTimeLabel(slotTemplate.start_h, slotTemplate.start_m, slotTemplate.end_h, slotTemplate.end_m)}`;
    tr.appendChild(tdTime);

    for (const day of days) {
      const td = document.createElement("td");
      const daySlot = buildDaySlots(day).find((s) => s.slot_index === slotTemplate.slot_index);
      const cellBookings = bookings.filter((b) => matchesSlot(daySlot, b));
      const cellOff = timeOffRows.filter((off) => {
        if (onlyTech && off.tech_id !== onlyTech) return false;
        return overlaps(daySlot.start.getTime(), daySlot.end.getTime(), new Date(off.start_ts).getTime(), new Date(off.end_ts).getTime());
      });

      const div = buildCellDiv(daySlot, cellBookings, cellOff);
      div.addEventListener("click", () => selectCell(day, daySlot, cellBookings, cellOff, div));
      td.appendChild(div);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
}

function renderDayView(dayDate, bookings, timeOffRows) {
  const day = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");

  const th0 = document.createElement("th");
  th0.className = "timecol";
  th0.textContent = "Slots";
  hr.appendChild(th0);

  const th = document.createElement("th");
  th.textContent = fmtDay(day);
  hr.appendChild(th);

  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  const onlyTech = !overlayAll && focusTechId !== "all" ? focusTechId : null;

  for (const slot of buildDaySlots(day)) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.className = "timecol";
    tdTime.textContent = `${slot.label} • ${fmtTimeLabel(slot.start_h, slot.start_m, slot.end_h, slot.end_m)}`;
    tr.appendChild(tdTime);

    const td = document.createElement("td");
    const cellBookings = bookings.filter((b) => matchesSlot(slot, b));
    const cellOff = timeOffRows.filter((off) => {
      if (onlyTech && off.tech_id !== onlyTech) return false;
      return overlaps(slot.start.getTime(), slot.end.getTime(), new Date(off.start_ts).getTime(), new Date(off.end_ts).getTime());
    });

    const div = buildCellDiv(slot, cellBookings, cellOff);
    div.addEventListener("click", () => selectCell(day, slot, cellBookings, cellOff, div));
    td.appendChild(div);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML = "";
  calWrap.appendChild(table);
}
function renderMonthCompact(anchor, bookings, timeOffRows) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");

  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    hr.appendChild(th);
  });

  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  const bookedByDay = new Map();
  for (const booking of bookings) {
    const key = toISODate(new Date(booking.window_start));
    bookedByDay.set(key, (bookedByDay.get(key) || 0) + 1);
  }

  const offByDay = new Map();
  const onlyTech = !overlayAll && focusTechId !== "all" ? focusTechId : null;
  for (const off of timeOffRows) {
    if (onlyTech && off.tech_id !== onlyTech) continue;
    const key = toISODate(new Date(off.start_ts));
    offByDay.set(key, (offByDay.get(key) || 0) + 1);
  }

  let cursor = new Date(gridStart);
  for (let week = 0; week < 6; week++) {
    const tr = document.createElement("tr");
    for (let i = 0; i < 7; i++) {
      const td = document.createElement("td");
      const iso = toISODate(cursor);
      td.style.opacity = cursor.getMonth() === month ? "1" : "0.4";
      td.style.verticalAlign = "top";
      td.style.height = "92px";
      td.innerHTML = `
        <div style="font-weight:900; margin-bottom:6px;">${cursor.getDate()}</div>
        <div class="tiny">Booked: ${bookedByDay.get(iso) || 0}</div>
        <div class="tiny">Off: ${offByDay.get(iso) || 0}</div>
      `;

      const clicked = new Date(cursor);
      td.addEventListener("click", () => {
        anchorDate = clicked;
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

// ---------- Time off ----------
function getFocusedTechIdOrThrow() {
  const tech = techRows.find((t) => t.id === focusTechId);
  if (!tech) throw new Error("Pick a tech first.");
  return tech.id;
}

function buildOffWindow(dateISO, block, slotIndex) {
  const day = new Date(`${dateISO}T00:00:00`);
  const slots = buildDaySlots(day);

  if (block === "all_day") {
    return {
      start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0),
      end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59),
    };
  }

  if (block === "am") return { start: slots[0].start, end: slots[3].end };
  if (block === "pm") return { start: slots[4].start, end: slots[7].end };

  const chosen = slots.find((s) => s.slot_index === Number(slotIndex)) || slots[0];
  return { start: chosen.start, end: chosen.end };
}

async function syncOffersForTimeOffRow({ tech_id, start_ts, end_ts, type, slot_index, service_date, is_active }) {
  if (type === "slot" && service_date && slot_index) {
    const { error } = await supabase.rpc("set_offers_active_for_slot", {
      p_tech_id: tech_id,
      p_service_date: service_date,
      p_slot_index: Number(slot_index),
      p_is_active: is_active,
    });
    if (error) throw error;
    return;
  }

  const { error } = await supabase.rpc("apply_time_off_to_offers", {
    p_tech_id: tech_id,
    p_start_ts: start_ts,
    p_end_ts: end_ts,
    p_is_active: is_active,
  });
  if (error) throw error;
}

async function reapplyTimeOffForWindow({ tech_id, start_ts, end_ts }) {
  const { data, error } = await supabase
    .from("tech_time_off")
    .select("id,tech_id,start_ts,end_ts,type,service_date,slot_index")
    .eq("tech_id", tech_id)
    .gte("end_ts", start_ts)
    .lte("start_ts", end_ts);

  if (error) throw error;

  for (const row of data || []) {
    if (
      String(row.type || "").toLowerCase() === "slot" &&
      row.service_date &&
      row.slot_index
    ) {
      await syncOffersForTimeOffRow({
        tech_id: row.tech_id,
        type: "slot",
        service_date: row.service_date,
        slot_index: Number(row.slot_index),
        is_active: false,
      });
    } else {
      await syncOffersForTimeOffRow({
        tech_id: row.tech_id,
        start_ts: row.start_ts,
        end_ts: row.end_ts,
        type: row.type,
        is_active: false,
      });
    }
  }
}

function renderTimeOffList(rows) {
  if (!offList) return;

  if (!rows.length) {
    offList.textContent = "No time off in this range.";
    return;
  }

  offList.textContent = rows.map((row) => {
    const s = new Date(row.start_ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const e = new Date(row.end_ts).toLocaleString([], { hour: "numeric", minute: "2-digit" });
    const techName = techRows.find((t) => t.id === row.tech_id)?.name || row.tech_id;
    return `• ${techName}: ${s}–${e}${row.type ? ` • ${row.type}` : ""}${row.reason ? ` • ${row.reason}` : ""}`;
  }).join("\n");
}

addOffBtn?.addEventListener("click", async () => {
  try {
    show(topError, false);
    setText(topError, "");

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
    const slotIndex = Number(offSlot?.value || "1");

    if (!ALLOWED_TYPES.includes(block)) {
      throw new Error(`Time off type "${block}" is not allowed.`);
    }

    const tech_id = getFocusedTechIdOrThrow();
    const { start, end } = buildOffWindow(dateISO, block, slotIndex);
    const reason = String(offReason?.value || "").trim() || null;

    const { data: existingOverlap, error: overlapError } = await supabase
      .from("tech_time_off")
      .select("id,start_ts,end_ts,type,reason,service_date,slot_index")
      .eq("tech_id", tech_id)
      .lt("start_ts", end.toISOString())
      .gt("end_ts", start.toISOString())
      .order("start_ts", { ascending: true })
      .limit(5);

    if (overlapError) {
      throw overlapError;
    }

    if (Array.isArray(existingOverlap) && existingOverlap.length > 0) {
      const first = existingOverlap[0];

      const existingStart = new Date(first.start_ts).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

      const existingEnd = new Date(first.end_ts).toLocaleString([], {
        hour: "numeric",
        minute: "2-digit",
      });

      throw new Error(
        `That time overlaps existing time off: ${existingStart}–${existingEnd}` +
        `${first.type ? ` (${first.type})` : ""}` +
        `${first.reason ? ` — ${first.reason}` : ""}. ` +
        `Remove the existing time off first if you want to replace it.`
      );
    }

    const payload = {
      tech_id,
      start_ts: start.toISOString(),
      end_ts: end.toISOString(),
      reason,
      type: block,
      service_date: block === "slot" ? dateISO : null,
      slot_index: block === "slot" ? slotIndex : null,
    };

    const { error } = await supabase
      .from("tech_time_off")
      .insert(payload);

    if (error) {
      if (
        error.code === "23514" &&
        String(error.message || "").includes("tech_time_off_slot_requires_fields")
      ) {
        throw new Error(
          "Specific slot time off requires a service date and slot number. Refresh the admin page and try again."
        );
      }

      if (
        error.code === "23P01" ||
        String(error.message || "").includes("tech_time_off_no_overlap")
      ) {
        throw new Error(
          "That time overlaps existing time off for this tech. Remove the existing time off first if you want to replace it."
        );
      }

      throw error;
    }

    if (block === "slot") {
      await syncOffersForTimeOffRow({
        tech_id,
        type: "slot",
        service_date: dateISO,
        slot_index: slotIndex,
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

    if (offReason) {
      offReason.value = "";
    }

    await render();
  } catch (err) {
    console.error(err);
    show(topError, true);
    setText(topError, err?.message || "Time off update failed.");
  }
});

markOffFromDetailBtn?.addEventListener("click", () => {
  if (!selectedCell) return;

  if (offDate) offDate.value = toISODate(selectedCell.dayDate);
  if (offBlock) offBlock.value = "slot";
  if (offSlot) offSlot.value = String(selectedCell.slot.slot_index);
});

deleteOffFromDetailBtn?.addEventListener("click", async () => {
  try {
    if (!selectedCell?.offRows?.length) return;
    const row = selectedCell.offRows[0];

    const { error } = await supabase.from("tech_time_off").delete().eq("id", row.id);
    if (error) throw error;

   await syncOffersForTimeOffRow({
  tech_id: row.tech_id,
  start_ts: row.start_ts,
  end_ts: row.end_ts,
  type: row.type,
  service_date: row.service_date || null,
  slot_index: row.slot_index || null,
  is_active: true,
});

    await reapplyTimeOffForWindow({ tech_id: row.tech_id, start_ts: row.start_ts, end_ts: row.end_ts });
    clearSelectedCell();
    await render();
  } catch (err) {
    setError(topError, err, "Remove OFF failed.");
  }
});

// ---------- Jobs list / stats / search ----------
function renderJobsList(bookings) {
  if (!jobsList) return;

  if (!bookings.length) {
    jobsList.textContent = "No bookings in this view.";
    return;
  }

  const lines = bookings.slice(0, 60).map((booking) => {
    const req = booking.booking_requests || {};
    const zone = booking.route_zone_code || booking.zone_code || "";
    return `• ${fmtDay(new Date(booking.window_start))} ${fmtTime(booking.window_start)}–${fmtTime(booking.window_end)} — ${req.name || "Customer"}${zone ? ` (Zone ${zone})` : ""} • ${scheduleStatusLabel(booking)}`;
  });

  jobsList.textContent = lines.join("\n") + (bookings.length > 60 ? `\n…plus ${bookings.length - 60} more` : "");
}

function computeStats(bookings, partsRows = []) {
  const visiblePartsRows = filterPartsRowsForSelection(partsRows);

  const total = bookings.length;
  const completed = bookings.filter((b) => String(b.status || "").toLowerCase() === "completed").length;
  const fullService = bookings.filter((b) => String(b.appointment_type || "").toLowerCase() === "full_service" || Number(b.full_service_cents || 0) > 0).length;
  const collected = bookings.reduce((sum, b) => sum + Number(b.collected_cents || 0), 0);
  const returnVisits = visiblePartsRows.filter((r) => String(r.part_status || "").toLowerCase() === "return_visit_ready").length;
  const parts = visiblePartsRows.filter((r) => {
    const partStatus = String(r.part_status || "").toLowerCase();
    const status = String(r.status || "").toLowerCase();
    return status === "parts_on_order" || ["awaiting_payment", "ordered", "customer_receiving", "tech_receiving", "customer_has_part", "tech_has_part"].includes(partStatus);
  }).length;

  setText(kTotal, total);
  setText(kCompleted, completed);
  setText(kFullService, fullService);
  setText(kCollected, fmtMoneyCents(collected));
  setText(kReturn, returnVisits);
  setText(kParts, parts);
}

function formatSearchRow(booking) {
  const req = booking.booking_requests || {};
  const zone = booking.route_zone_code || booking.zone_code || "";
  return `• ${fmtDay(new Date(booking.window_start))} ${fmtTime(booking.window_start)}–${fmtTime(booking.window_end)} — ${req.name || "Customer"}${zone ? ` (Zone ${zone})` : ""} • Ref: ${booking.job_ref || "—"} • ${statusLabel(booking.status)}${req.address ? `\n  ${req.address}` : ""}`;
}

async function searchJobs(termRaw) {
  const term = String(termRaw || "").trim();
  if (!term) return [];

  const q1 = supabase
    .from("bookings")
    .select(`
      id,window_start,window_end,status,appointment_type,zone_code,route_zone_code,job_ref,
      booking_requests:request_id ( id,name,address,phone,email,notes )
    `)
    .ilike("job_ref", `%${term}%`)
    .order("window_start", { ascending: false })
    .limit(25);

  const q2 = supabase
    .from("bookings")
    .select(`
      id,window_start,window_end,status,appointment_type,zone_code,route_zone_code,job_ref,
      booking_requests:request_id!inner ( id,name,address,phone,email,notes )
    `)
    .ilike("booking_requests.name", `%${term}%`)
    .order("window_start", { ascending: false })
    .limit(25);

  const [r1, r2] = await Promise.all([q1, q2]);
  if (r1.error) throw r1.error;
  if (r2.error) throw r2.error;

  const map = new Map();
  for (const row of r1.data || []) map.set(row.id, row);
  for (const row of r2.data || []) map.set(row.id, row);

  return Array.from(map.values()).sort((a, b) => new Date(b.window_start) - new Date(a.window_start)).slice(0, 40);
}

jobSearchBtn?.addEventListener("click", async () => {
  try {
    if (!jobSearchResults) return;
    setText(jobSearchResults, "Searching…");
    const rows = await searchJobs(jobSearchInput?.value || "");
    setText(jobSearchResults, rows.length ? rows.map(formatSearchRow).join("\n\n") : "No matching jobs found.");
  } catch (err) {
    setError(topError, err, "Search failed.");
    setText(jobSearchResults, "");
  }
});

jobSearchClearBtn?.addEventListener("click", () => {
  if (jobSearchInput) jobSearchInput.value = "";
  setText(jobSearchResults, "");
});

// ---------- Render ----------
function setViewMode(mode) {
  viewMode = mode;
  clearSelectedCell();
  render();
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

async function generateFutureScheduleSlots() {
  try {
    show(topError, false);
    setText(topError, "");
    if (genOffersStubBtn) genOffersStubBtn.disabled = true;
    setText(sysNote, "Generating future schedule slots…");

    const json = await postAuthedJson("/api/admin-generate-schedule-slots", { days_ahead: 90 });
    const result = json.result || {};
    setText(sysNote, `Done. Inserted ${Number(result.inserted_slots || 0)} new slots${result.start_date && result.end_date ? ` for ${result.start_date} through ${result.end_date}` : ""}.`);
    await render();
  } catch (err) {
    setError(topError, err, "Schedule generation failed.");
    setText(sysNote, err?.message || "Could not generate schedule slots.");
  } finally {
    if (genOffersStubBtn) genOffersStubBtn.disabled = false;
  }
}

genOffersStubBtn?.addEventListener("click", generateFutureScheduleSlots);
refreshPmRequestsBtn?.addEventListener("click", loadPmRequests);
refreshJobHelpRequestsBtn?.addEventListener("click", loadJobHelpRequests);
refreshBookingFailuresBtn?.addEventListener("click", loadBookingFailures);
refreshPartsOnOrderBtn?.addEventListener("click", async () => renderPartsOnOrder(await loadPartsOnOrder()));

async function render() {
  show(topError, false);
  setText(topError, "");

  const { start, end, label } = getRangeForView();
  setText(rangeLabel, label);

  if (dayBtn) dayBtn.style.opacity = viewMode === "day" ? "1" : "0.75";
  if (weekBtn) weekBtn.style.opacity = viewMode === "week" ? "1" : "0.75";
  if (monthBtn) monthBtn.style.opacity = viewMode === "month" ? "1" : "0.75";
  if (overlayAllBtn) overlayAllBtn.style.opacity = overlayAll ? "1" : "0.75";
  if (clearOverlayBtn) clearOverlayBtn.style.opacity = !overlayAll ? "1" : "0.75";
  if (offDate && !offDate.value) offDate.value = toISODate(anchorDate);

  try {
    const [bookingsRaw, timeOffRows, partsRowsRaw] = await Promise.all([
      loadBookings(start, end),
      loadTimeOff(start, end),
      loadPartsOnOrder(),
    ]);

    const bookings = attachReturnVisitFlags(bookingsRaw, partsRowsRaw);

    computeStats(bookings, partsRowsRaw);
    renderTimeOffList(timeOffRows);
    renderJobsList(bookings);
    renderPartsOnOrder(partsRowsRaw);

    if (viewMode === "month") renderMonthCompact(anchorDate, bookings, timeOffRows);
    else if (viewMode === "day") renderDayView(anchorDate, bookings, timeOffRows);
    else renderWeekGrid(startOfWeekMon(anchorDate), bookings, timeOffRows);
  } catch (err) {
    setError(topError, err, "Load failed.");
  }
}

async function main() {
  const session = await requireAdmin();
  if (!session) return;

  await loadTechs();
  viewMode = "week";
  overlayAll = true;
  clearSelectedCell();

  await Promise.all([
    render(),
    loadPmRequests(),
    loadJobHelpRequests(),
    loadBookingFailures(),
  ]);
}

main();
