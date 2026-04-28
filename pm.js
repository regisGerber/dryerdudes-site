import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and __SUPABASE_ANON_KEY__ in pm.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---------- UI ----------
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");
const newRequestBtn = document.getElementById("newRequestBtn");
const pmCompanyName = document.getElementById("pmCompanyName");
const portalError = document.getElementById("portalError");

const jobsList = document.getElementById("jobsList");
const searchInput = document.getElementById("jobSearchInput");
const filterButtons = Array.from(document.querySelectorAll(".filter-btn"));

const detailTitle = document.getElementById("detailTitle");
const detailSubtext = document.getElementById("detailSubtext");
const detailStatusBadge = document.getElementById("detailStatusBadge");
const detailEmpty = document.getElementById("detailEmpty");
const detailWrap = document.getElementById("detailWrap");

const tenantDetails = document.getElementById("tenantDetails");
const addressDetails = document.getElementById("addressDetails");
const schedulingDetails = document.getElementById("schedulingDetails");
const appointmentDetails = document.getElementById("appointmentDetails");
const approvalDetails = document.getElementById("approvalDetails");
const billingDetails = document.getElementById("billingDetails");

const resendSchedulingBtn = document.getElementById("resendSchedulingBtn");
const sendReminderBtn = document.getElementById("sendReminderBtn");
const payNowBtn = document.getElementById("payNowBtn");

const newRequestPanel = document.getElementById("newRequestPanel");
const newRequestForm = document.getElementById("newRequestForm");
const createRequestBtn = document.getElementById("createRequestBtn");
const newRequestMsg = document.getElementById("newRequestMsg");

const currentBalanceText = document.getElementById("currentBalanceText");
const latestInvoiceText = document.getElementById("latestInvoiceText");
const payBalanceBtn = document.getElementById("payBalanceBtn");

// ---------- State ----------
let currentSession = null;
let currentPm = null;
let allJobs = [];
let filteredJobs = [];
let activeJob = null;
let activeCardEl = null;
let activeFilter = "active";

// ---------- Helpers ----------
function show(el, on = true) {
  if (el) el.style.display = on ? "" : "none";
}

function setText(el, text) {
  if (el) el.textContent = text ?? "";
}

function setError(message) {
  if (!portalError) return;
  if (!message) {
    setText(portalError, "");
    show(portalError, false);
    return;
  }
  setText(portalError, message);
  show(portalError, true);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDateOnly(value) {
  if (!value) return "";
  const d = new Date(value);
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function fmtTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function fmtDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return d.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function fmtMoneyCents(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(0)}`;
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();

  if (s === "pending_scheduling") return "pending scheduling";
  if (s === "awaiting_approval") return "awaiting approval";
  if (s === "in_progress") return "in progress";
  if (s === "completed") return "completed";
  if (s === "canceled") return "canceled";
  if (s === "scheduled") return "scheduled";
  if (s === "sent") return "pending scheduling";
  if (s === "approval") return "approval";
  if (s === "parts_needed") return "parts needed";
  if (s === "return_visit") return "return visit";

  return s || "pending";
}

function recordTypeLabel(row) {
  return row.record_type === "booking" ? "booking" : "request";
}

function isActiveStatus(row) {
  const s = String(row.status || "").toLowerCase();
  return !["completed", "canceled"].includes(s);
}

function matchesFilter(row, filter) {
  const s = String(row.status || "").toLowerCase();

  if (filter === "all") return true;
  if (filter === "active") return isActiveStatus(row);
  if (filter === "awaiting_approval") {
    return ["awaiting_approval", "approval", "parts_needed"].includes(s);
  }
  if (filter === "completed") return s === "completed";

  return true;
}

function matchesSearch(row, term) {
  const q = String(term || "").trim().toLowerCase();
  if (!q) return true;

  const haystack = [
    row.tenant_name,
    row.tenant_phone,
    row.tenant_email,
    row.service_address,
    row.job_ref,
    row.status
  ].filter(Boolean).join(" ").toLowerCase();

  return haystack.includes(q);
}

function approvalLimitFor(row) {
  return Number(
    row.total_job_approval_limit_cents ||
    currentPm?.default_job_approval_limit_cents ||
    15000
  );
}

function schedulingActivityText(row) {
  const items = [];

  if (row.scheduling_link_sent_at) {
    items.push(`Scheduling link sent: ${fmtDateTime(row.scheduling_link_sent_at)}`);
  }

  if (row.scheduling_link_opened_at) {
    items.push(`Link opened: ${fmtDateTime(row.scheduling_link_opened_at)}`);
  }

  if (row.authorized_entry === true) {
    items.push("Authorized entry");
  }

  if (row.selected_slot_at) {
    items.push(`Appointment selected: ${fmtDateTime(row.selected_slot_at)}`);
  }

  if (!items.length) {
    const s = String(row.status || "").toLowerCase();
    if (s === "pending_scheduling" || s === "sent") {
      return "No tenant scheduling activity yet.";
    }
    return "No scheduling activity recorded.";
  }

  return items.join("\n");
}

function appointmentText(row) {
  if (!row.window_start || !row.window_end) {
    return "Not scheduled yet.";
  }

  return [
    fmtDateOnly(row.window_start),
    `${fmtTime(row.window_start)} – ${fmtTime(row.window_end)}`,
    row.appointment_type || "standard"
  ].join("\n");
}

function approvalSettingsText(row) {
  const addonText = row.addon_preapproved === false
    ? "Needs approval"
    : "Allowed";

  return [
    `Total job pre-approval limit: ${fmtMoneyCents(approvalLimitFor(row))}`,
    `Add-on service: ${addonText}`
  ].join("\n");
}

function billingText(row) {
  if (!row.booking_id) {
    return "Not billed yet.\nThis request has not become a scheduled booking.";
  }

  const base = Number(row.base_fee_cents || 0);
  const fullService = Number(row.full_service_cents || 0);
  const collected = Number(row.collected_cents || 0);
  const total = base + fullService;

  return [
    `Base service: ${fmtMoneyCents(base)}`,
    `Full service add-on: ${fmtMoneyCents(fullService)}`,
    `Scheduled total: ${fmtMoneyCents(total)}`,
    `Collected: ${fmtMoneyCents(collected)}`,
    `Payment status: ${row.payment_status || "not set"}`
  ].join("\n");
}

function jobCardTitle(row) {
  const who = row.tenant_name || "Tenant";
  const address = row.service_address || "No address";
  return `${who} — ${address}`;
}

function jobCardMeta(row) {
  if (row.window_start && row.window_end) {
    return `${statusLabel(row.status)} • ${fmtDateOnly(row.window_start)} • ${fmtTime(row.window_start)} – ${fmtTime(row.window_end)}`;
  }

  if (row.record_type === "request") {
    return `${statusLabel(row.status)} • request created ${fmtDateOnly(row.created_at)}`;
  }

  return statusLabel(row.status);
}

// ---------- Auth ----------
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

// ---------- Data ----------
async function loadProfileRole(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.role || null;
}

async function loadPropertyManagerProfile() {
  const { data, error } = await supabase.rpc("get_my_property_manager_profile");
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return row || null;
}

async function loadPmJobs() {
  const { data, error } = await supabase.rpc("get_my_property_manager_jobs");
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function createPmRequestFromForm() {
  const formData = new FormData(newRequestForm);

  const tenantName = String(formData.get("tenant_name") || "").trim();
  const tenantPhone = String(formData.get("tenant_phone") || "").trim();
  const tenantEmail = String(formData.get("tenant_email") || "").trim();
  const serviceAddress = String(formData.get("service_address") || "").trim();
  const accessNotes = String(formData.get("access_notes") || "").trim();

  const approvalRaw =
    formData.get("total_job_approval_limit_cents") ||
    formData.get("parts_approval_limit") ||
    15000;

  let totalJobApprovalLimitCents = Number(approvalRaw || 15000);
  if ([150, 175, 200, 225, 250].includes(totalJobApprovalLimitCents)) {
    totalJobApprovalLimitCents = totalJobApprovalLimitCents * 100;
  }

  const addonRaw = String(formData.get("addon_preapproved") || "true");
  const addonPreapproved =
    addonRaw === "true" ||
    addonRaw === "allow" ||
    addonRaw === "1";

  if (!tenantName || !tenantEmail || !serviceAddress) {
    throw new Error("Tenant name, tenant email, and service address are required.");
  }

  const session = currentSession || (await supabase.auth.getSession())?.data?.session;

  if (!session?.access_token) {
    throw new Error("You are not signed in.");
  }

  const resp = await fetch("/api/pm-request-times", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      tenant_name: tenantName,
      tenant_phone: tenantPhone,
      tenant_email: tenantEmail,
      service_address: serviceAddress,
      access_notes: accessNotes,
      total_job_approval_limit_cents: totalJobApprovalLimitCents,
      addon_preapproved: addonPreapproved,
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || !json.ok) {
    throw new Error(
      json?.error ||
      json?.message ||
      json?.upstream?.error ||
      "Could not create request."
    );
  }

  return json;
}
  const formData = new FormData(newRequestForm);

  const tenantName = String(formData.get("tenant_name") || "").trim();
  const tenantPhone = String(formData.get("tenant_phone") || "").trim();
  const tenantEmail = String(formData.get("tenant_email") || "").trim();
  const serviceAddress = String(formData.get("service_address") || "").trim();
  const accessNotes = String(formData.get("access_notes") || "").trim();
  const approvalLimitCents = Number(formData.get("total_job_approval_limit_cents") || 15000);
  const addonPreapproved = String(formData.get("addon_preapproved") || "true") === "true";

  if (!tenantName || !tenantEmail || !serviceAddress) {
    throw new Error("Tenant name, tenant email, and service address are required.");
  }

  const { data, error } = await supabase.rpc("create_my_property_manager_request", {
    p_tenant_name: tenantName,
    p_tenant_phone: tenantPhone,
    p_tenant_email: tenantEmail,
    p_service_address: serviceAddress,
    p_access_notes: accessNotes || null,
    p_total_job_approval_limit_cents: approvalLimitCents,
    p_addon_preapproved: addonPreapproved
  });

  if (error) throw error;
  return data;
}

// ---------- Render ----------
function clearDetails() {
  activeJob = null;

  if (activeCardEl) activeCardEl.classList.remove("active");
  activeCardEl = null;

  show(detailEmpty, true);
  show(detailWrap, false);
  show(detailStatusBadge, false);

  setText(detailTitle, "Job details");
  setText(detailSubtext, "Select a request or booking to view details.");
}

function selectJob(row, cardEl) {
  if (activeCardEl) activeCardEl.classList.remove("active");
  activeCardEl = cardEl;
  activeCardEl?.classList.add("active");

  activeJob = row;
  renderJobDetails(row);
}

function renderJobDetails(row) {
  show(detailEmpty, false);
  show(detailWrap, true);
  show(detailStatusBadge, true);

  setText(detailTitle, row.job_ref ? `Job ${row.job_ref}` : "Request details");
  setText(detailSubtext, `${recordTypeLabel(row)} • ${row.request_id}`);
  setText(detailStatusBadge, statusLabel(row.status));

  tenantDetails.innerHTML = [
    escapeHtml(row.tenant_name || "No tenant name"),
    escapeHtml(row.tenant_phone || ""),
    escapeHtml(row.tenant_email || "")
  ].filter(Boolean).join("<br>");

  setText(addressDetails, row.service_address || "No address");
  setText(schedulingDetails, schedulingActivityText(row));
  setText(appointmentDetails, appointmentText(row));
  setText(approvalDetails, approvalSettingsText(row));
  setText(billingDetails, billingText(row));

  const hasBooking = !!row.booking_id;

  if (payNowBtn) {
    payNowBtn.disabled = true;
    payNowBtn.title = hasBooking
      ? "PM payment checkout is not connected yet."
      : "This request has not become a booking yet.";
  }

  if (resendSchedulingBtn) {
    resendSchedulingBtn.disabled = true;
    resendSchedulingBtn.title = "Scheduling-link resend is not connected yet.";
  }

  if (sendReminderBtn) {
    sendReminderBtn.disabled = true;
    sendReminderBtn.title = "Tenant reminders are not connected yet.";
  }
}

function createJobCard(row) {
  const card = document.createElement("div");
  card.className = "job-card";

  card.innerHTML = `
    <div class="job-top">
      <div>
        <div class="job-title">${escapeHtml(jobCardTitle(row))}</div>
        <div class="job-meta">${escapeHtml(jobCardMeta(row))}</div>
      </div>
      <span class="badge">${escapeHtml(statusLabel(row.status))}</span>
    </div>
  `;

  card.addEventListener("click", () => selectJob(row, card));
  return card;
}

function renderJobs() {
  if (!jobsList) return;

  const term = searchInput?.value?.trim() || "";

  filteredJobs = allJobs
    .filter((row) => matchesFilter(row, activeFilter))
    .filter((row) => matchesSearch(row, term));

  jobsList.innerHTML = "";

  if (!filteredJobs.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = activeFilter === "active"
      ? "No active property manager requests yet. Create a new request below."
      : "No jobs found for this filter.";
    jobsList.appendChild(empty);
    clearDetails();
    return;
  }

  filteredJobs.forEach((row, index) => {
    const card = createJobCard(row);
    jobsList.appendChild(card);

    if (index === 0) {
      selectJob(row, card);
    }
  });
}

function renderBillingSummary() {
  const bookings = allJobs.filter((row) => row.booking_id);
  const completed = bookings.filter((row) => String(row.status || "").toLowerCase() === "completed");

  if (!bookings.length) {
    setText(currentBalanceText, "No scheduled PM jobs yet.");
    setText(latestInvoiceText, "No billing activity yet.");
    if (payBalanceBtn) payBalanceBtn.disabled = true;
    return;
  }

  const scheduledTotal = bookings.reduce((sum, row) => {
    return sum + Number(row.base_fee_cents || 0) + Number(row.full_service_cents || 0);
  }, 0);

  const collectedTotal = bookings.reduce((sum, row) => {
    return sum + Number(row.collected_cents || 0);
  }, 0);

  setText(
    currentBalanceText,
    [
      `Scheduled PM jobs: ${bookings.length}`,
      `Completed jobs: ${completed.length}`,
      `Scheduled service total: ${fmtMoneyCents(scheduledTotal)}`,
      `Collected so far: ${fmtMoneyCents(collectedTotal)}`
    ].join("\n")
  );

  const latest = bookings[0];

  setText(
    latestInvoiceText,
    latest
      ? [
          latest.job_ref ? `Latest job: ${latest.job_ref}` : "Latest PM booking",
          latest.window_start ? `Date: ${fmtDateOnly(latest.window_start)}` : "",
          `Status: ${statusLabel(latest.status)}`
        ].filter(Boolean).join("\n")
      : "No billing activity yet."
  );

  if (payBalanceBtn) {
    payBalanceBtn.disabled = true;
    payBalanceBtn.title = "Stripe PM billing is not connected yet.";
  }
}

// ---------- Wire ----------
function wireFilters() {
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter || "active";

      filterButtons.forEach((b) => b.classList.remove("active-filter"));
      btn.classList.add("active-filter");

      renderJobs();
    });
  });
}

function wireSearch() {
  searchInput?.addEventListener("input", renderJobs);
}

function wireNewRequestButton() {
  newRequestBtn?.addEventListener("click", () => {
    newRequestPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function wireNewRequestForm() {
  newRequestForm?.addEventListener("submit", async (e) => {
    e.preventDefault();

    setError("");
    setText(newRequestMsg, "");

    if (!currentPm) {
      setText(newRequestMsg, "Property manager account not loaded.");
      return;
    }

    if (createRequestBtn) {
      createRequestBtn.disabled = true;
      createRequestBtn.style.opacity = "0.85";
    }

    setText(newRequestMsg, "Creating request…");

    try {
      await createPmRequestFromForm();

      newRequestForm.reset();
      setText(
  newRequestMsg,
  "Request created. Tenant scheduling email sent. It now appears in your job list."
);

      allJobs = await loadPmJobs();
      renderJobs();
      renderBillingSummary();

      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error(err);
      setText(newRequestMsg, err?.message || "Could not create request.");
    } finally {
      if (createRequestBtn) {
        createRequestBtn.disabled = false;
        createRequestBtn.style.opacity = "1";
      }
    }
  });
}

function wirePayBalanceButton() {
  payBalanceBtn?.addEventListener("click", () => {
    alert("PM Stripe billing is not connected yet.");
  });
}

// ---------- Init ----------
async function main() {
  try {
    currentSession = await requireAuth();
    if (!currentSession) return;

    const user = currentSession.user;
    setText(whoami, user.email || "Signed in");

    const role = await loadProfileRole(user.id);

    if (role !== "property_manager") {
      await supabase.auth.signOut();
      alert("Your account is not assigned to the property manager portal.");
      window.location.href = "/login.html";
      return;
    }

    currentPm = await loadPropertyManagerProfile();

    if (!currentPm) {
      setError("No property manager account record was found for this login.");
      setText(pmCompanyName, "No PM account found");
      return;
    }

    setText(pmCompanyName, currentPm.company_name || "Property Manager Account");

    wireFilters();
    wireSearch();
    wireNewRequestButton();
    wireNewRequestForm();
    wirePayBalanceButton();

    allJobs = await loadPmJobs();
    renderJobs();
    renderBillingSummary();
  } catch (err) {
    console.error(err);
    setError(err?.message || String(err));
  }
}

main();
