import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey || supabaseAnonKey === "YOUR_ANON_KEY") {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and __SUPABASE_ANON_KEY__ in pm.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---------- UI ----------
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");
const newRequestBtn = document.getElementById("newRequestBtn");

const jobsList = document.getElementById("jobsList");
const searchInput = document.querySelector(".search");

const filterButtons = Array.from(document.querySelectorAll(".seg .btn.secondary"));

const statusBadge = document.querySelector(".panel .badge");
const jobTitleEl = document.querySelector(".panel .detail-block .detail-value") ? null : null;

// Right-side detail blocks
const detailBlocks = document.querySelectorAll(".grid-2 .panel:nth-child(2) .detail-block");
const actionsRows = document.querySelectorAll(".grid-2 .panel:nth-child(2) .actions");

// New request form
const newRequestForm = document.querySelector(".new-request");

// Billing summary buttons
const payBalanceBtn = Array.from(document.querySelectorAll("button")).find(
  (b) => b.textContent.trim().toLowerCase() === "pay balance now"
);

// ---------- State ----------
let currentSession = null;
let currentPm = null;
let allJobs = [];
let filteredJobs = [];
let activeJob = null;
let activeCardEl = null;
let activeFilter = "active";

// ---------- Helpers ----------
function showError(msg) {
  alert(msg);
}

function setText(el, text) {
  if (el) el.textContent = text ?? "";
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

function fmtDateOnly(value) {
  if (!value) return "";
  const d = new Date(value);
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function fmtMoney(value) {
  const n = Number(value || 0);
  return `$${n.toFixed(2).replace(".00", "")}`;
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();

  if (s === "pending_scheduling") return "pending scheduling";
  if (s === "awaiting_approval") return "awaiting approval";
  if (s === "in_progress") return "in progress";
  if (s === "completed") return "completed";
  if (s === "canceled") return "canceled";
  if (s === "scheduled") return "scheduled";
  if (s === "approval") return "approval";

  return s || "pending";
}

function schedulingActivityText(row) {
  const req = row.booking_requests || {};
  const items = [];

  if (req.scheduling_link_sent_at) items.push("Scheduling link sent");
  if (req.scheduling_link_opened_at) items.push("Link opened");
  if (req.authorized_entry === true) items.push("Authorized entry");
  if (req.selected_slot_at) items.push("Appointment selected");

  if (!items.length) {
    const status = String(row.status || "").toLowerCase();
    if (status === "pending_scheduling") return "No scheduling activity yet";
    return "No scheduling activity recorded";
  }

  return items.join("\n");
}

function appointmentText(row) {
  const start = row.window_start;
  const end = row.window_end;
  const type = row.appointment_type || "standard";

  if (!start || !end) return "Not scheduled yet";

  const startDate = new Date(start);
  const endDate = new Date(end);

  return [
    fmtDateOnly(start),
    `${startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${endDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    type
  ].join("\n");
}

function billingText(row) {
  const service = Number(row.service_amount ?? 80);
  const parts = Number(row.parts_amount ?? 0);
  const addon = Number(row.addon_amount ?? 0);
  const total = Number(row.total_amount ?? service + parts + addon);

  return [
    `Service: ${fmtMoney(service)}`,
    `Parts: ${fmtMoney(parts)}`,
    `Add-on: ${fmtMoney(addon)}`,
    `Total: ${fmtMoney(total)}`
  ].join("\n");
}

function approvalSettingsText(row) {
  const req = row.booking_requests || {};
  const limit = req.parts_approval_limit ?? currentPm?.default_parts_approval_limit ?? 150;
  const addonAllowed = req.addon_preapproved === false ? "needs approval" : "allowed";

  return [
    `Default parts approval limit: ${fmtMoney(limit)}`,
    `Add-on service: ${addonAllowed}`
  ].join("\n");
}

function approvalNeededText(row) {
  const overLimit = Number(row.parts_amount ?? 0);
  const limit = Number(row.booking_requests?.parts_approval_limit ?? currentPm?.default_parts_approval_limit ?? 150);

  if (overLimit <= limit) {
    return "No parts approval needed right now.";
  }

  return [
    `Recommended parts total: ${fmtMoney(overLimit)}`,
    `Awaiting approval for amount over limit.`
  ].join("\n");
}

function matchesFilter(row, filter) {
  const status = String(row.status || "").toLowerCase();

  if (filter === "active") {
    return !["completed", "canceled"].includes(status);
  }

  if (filter === "awaiting approval") {
    return status === "awaiting_approval" || status === "approval";
  }

  if (filter === "completed") {
    return status === "completed";
  }

  return true;
}

function matchesSearch(row, term) {
  if (!term) return true;

  const req = row.booking_requests || {};
  const haystack = [
    req.name,
    req.address,
    row.job_ref,
    req.phone,
    req.email
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(term.toLowerCase());
}

function clearActiveCard() {
  if (activeCardEl) activeCardEl.classList.remove("active");
  activeCardEl = null;
}

function wirePlaceholderActions(row) {
  const allButtons = Array.from(document.querySelectorAll(".grid-2 .panel:nth-child(2) .action-link, .grid-2 .panel:nth-child(2) button.action-link"));

  allButtons.forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const label = btn.textContent.trim();

      if (label === "Pay now") {
        alert("Next step: connect this to /api/create-pm-payment-session for this property manager or invoice.");
        return;
      }

      if (label === "View invoice") {
        alert("Next step: open invoice PDF or invoice detail page.");
        return;
      }

      if (label === "Approve") {
        alert(`Next step: approve parts for job ${row.job_ref || row.id}.`);
        return;
      }

      if (label === "Deny") {
        alert(`Next step: deny parts for job ${row.job_ref || row.id}.`);
        return;
      }

      if (label === "Resend scheduling link") {
        alert(`Next step: resend scheduling link to ${row.booking_requests?.email || "tenant"}.`);
        return;
      }

      if (label === "Send reminder") {
        alert(`Next step: trigger reminder for ${row.booking_requests?.name || "tenant"}.`);
        return;
      }
    };
  });
}

function renderJobDetails(row) {
  activeJob = row;

  const req = row.booking_requests || {};
  const rightPanel = document.querySelector(".grid-2 .panel:nth-child(2)");
  if (!rightPanel) return;

  const h3 = rightPanel.querySelector("h3");
  if (h3) h3.textContent = "Job details";

  const subtext = rightPanel.querySelector(".subtext");
  if (subtext) {
    subtext.textContent = "View status, scheduling activity, approvals, and billing for the selected job.";
  }

  const badge = rightPanel.querySelector(".badge");
  if (badge) badge.textContent = statusLabel(row.status);

  const blocks = rightPanel.querySelectorAll(".detail-block");
  if (blocks.length < 6) return;

  const tenantValue = blocks[0].querySelector(".detail-value");
  const addressValue = blocks[1].querySelector(".detail-value");
  const schedulingValue = blocks[2].querySelector(".detail-value");
  const appointmentValue = blocks[3].querySelector(".detail-value");
  const settingsValue = blocks[4].querySelector(".detail-value");
  const approvalValue = blocks[5].querySelector(".detail-value");

  if (tenantValue) {
    tenantValue.innerHTML = [
      req.name || "No tenant name",
      req.phone || "",
      req.email || ""
    ].filter(Boolean).join("<br>");
  }

  if (addressValue) {
    addressValue.textContent = req.address || "No address";
  }

  if (schedulingValue) {
    schedulingValue.style.whiteSpace = "pre-line";
    schedulingValue.textContent = schedulingActivityText(row);
  }

  if (appointmentValue) {
    appointmentValue.style.whiteSpace = "pre-line";
    appointmentValue.textContent = appointmentText(row);
  }

  if (settingsValue) {
    settingsValue.style.whiteSpace = "pre-line";
    settingsValue.textContent = approvalSettingsText(row);
  }

  if (approvalValue) {
    approvalValue.style.whiteSpace = "pre-line";
    approvalValue.textContent = approvalNeededText(row);
  }

  const billingBlock = blocks[6];
  if (billingBlock) {
    const billingValue = billingBlock.querySelector(".detail-value");
    if (billingValue) {
      billingValue.style.whiteSpace = "pre-line";
      billingValue.textContent = billingText(row);
    }
  }

  wirePlaceholderActions(row);
}

function selectJob(row, cardEl) {
  clearActiveCard();
  activeCardEl = cardEl;
  if (activeCardEl) activeCardEl.classList.add("active");
  renderJobDetails(row);
}

function createJobCard(row, isActive = false) {
  const req = row.booking_requests || {};

  const card = document.createElement("div");
  card.className = `job-card${isActive ? " active" : ""}`;

  const title = req.name
    ? `${req.name} — ${req.address || "No address"}`
    : `${row.job_ref || "Job"} — ${req.address || "No address"}`;

  let meta = "";
  if (row.window_start && row.window_end) {
    const start = new Date(row.window_start);
    const end = new Date(row.window_end);
    meta = `${statusLabel(row.status)} • ${fmtDateOnly(row.window_start)} • ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } else if (String(row.status || "").toLowerCase() === "pending_scheduling") {
    meta = "Tenant has not scheduled yet";
  } else {
    meta = statusLabel(row.status);
  }

  card.innerHTML = `
    <div class="job-top">
      <div>
        <div class="job-title">${title}</div>
        <div class="job-meta">${meta}</div>
      </div>
      <span class="badge">${statusLabel(row.status)}</span>
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
    empty.className = "tiny";
    empty.style.marginTop = "10px";
    empty.textContent = "No jobs found for this filter.";
    jobsList.appendChild(empty);
    return;
  }

  filteredJobs.forEach((row, idx) => {
    const card = createJobCard(row, idx === 0);
    jobsList.appendChild(card);

    if (idx === 0) {
      activeCardEl = card;
      activeJob = row;
    }
  });

  if (filteredJobs[0]) {
    renderJobDetails(filteredJobs[0]);
  }
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

async function loadPropertyManager(userId) {
  const { data, error } = await supabase
    .from("property_managers")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function loadPmJobs(propertyManagerId) {
  const { data, error } = await supabase
    .from("bookings")
    .select(`
      id,
      request_id,
      property_manager_id,
      window_start,
      window_end,
      status,
      appointment_type,
      job_ref,
      service_amount,
      parts_amount,
      addon_amount,
      total_amount,
      booking_requests:request_id (
        id,
        property_manager_id,
        name,
        phone,
        email,
        address,
        notes,
        parts_approval_limit,
        addon_preapproved,
        authorized_entry,
        scheduling_link_sent_at,
        scheduling_link_opened_at,
        selected_slot_at
      )
    `)
    .eq("property_manager_id", propertyManagerId)
    .order("window_start", { ascending: false, nullsFirst: false });

  if (error) throw error;
  return data || [];
}

// ---------- Actions ----------
function wireFilters() {
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.textContent.trim().toLowerCase();

      filterButtons.forEach((b) => {
        b.style.opacity = "0.75";
      });

      btn.style.opacity = "1";
      renderJobs();
    });
  });

  const activeBtn = filterButtons.find((b) => b.textContent.trim().toLowerCase() === "active");
  if (activeBtn) activeBtn.style.opacity = "1";
}

function wireSearch() {
  searchInput?.addEventListener("input", () => {
    renderJobs();
  });
}

function wireNewRequestButton() {
  newRequestBtn?.addEventListener("click", () => {
    newRequestForm?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function wireNewRequestForm() {
  if (!newRequestForm) return;

  newRequestForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!currentPm) {
      alert("Property manager account not loaded.");
      return;
    }

    const formData = new FormData(newRequestForm);

    const tenantName = String(formData.get("tenant_name") || "").trim();
    const tenantPhone = String(formData.get("tenant_phone") || "").trim();
    const tenantEmail = String(formData.get("tenant_email") || "").trim();
    const serviceAddress = String(formData.get("service_address") || "").trim();
    const accessNotes = String(formData.get("access_notes") || "").trim();
    const approvalLimit = Number(formData.get("parts_approval_limit") || currentPm.default_parts_approval_limit || 150);
    const addonApproval = String(formData.get("addon_preapproved") || "allow") === "allow";

    if (!tenantName || !serviceAddress) {
      alert("Tenant name and service address are required.");
      return;
    }

    alert(
      "Next step: connect this form to create a booking_requests row with property_manager_id locked to the signed-in PM.\n\n" +
      `Tenant: ${tenantName}\nAddress: ${serviceAddress}\nApproval limit: ${approvalLimit}`
    );
  });
}

function wirePayBalanceButton() {
  payBalanceBtn?.addEventListener("click", () => {
    if (!currentPm) {
      alert("Property manager account not loaded.");
      return;
    }

    alert(
      "Next step: call /api/create-pm-payment-session with this property manager account or a specific invoice id."
    );
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

    currentPm = await loadPropertyManager(user.id);
    if (!currentPm) {
      alert("No property manager account record was found for this login.");
      return;
    }

    wireFilters();
    wireSearch();
    wireNewRequestButton();
    wireNewRequestForm();
    wirePayBalanceButton();

    allJobs = await loadPmJobs(currentPm.id);
    renderJobs();
  } catch (err) {
    console.error(err);
    showError(err?.message || String(err));
  }
}

main();
