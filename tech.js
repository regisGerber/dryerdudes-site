import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey || supabaseAnonKey === "YOUR_REAL_ANON_KEY_HERE") {
  alert("Missing Supabase config. Check window.__SUPABASE_URL__ and __SUPABASE_ANON_KEY__ in tech.html");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ------- UI -------
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");

const viewTodayBtn = document.getElementById("viewTodayBtn");
const viewWeekBtn = document.getElementById("viewWeekBtn");
const rangeLabel = document.getElementById("rangeLabel");

const jobsList = document.getElementById("jobsList");
const jobsEmpty = document.getElementById("jobsEmpty");
const jobsError = document.getElementById("jobsError");

const outstandingJobsList = document.getElementById("outstandingJobsList");
const outstandingEmpty = document.getElementById("outstandingEmpty");

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

const billingPanel = document.getElementById("billingPanel");
const billingForm = document.getElementById("billingForm");
const billingJobTitle = document.getElementById("billingJobTitle");
const billingMsg = document.getElementById("billingMsg");

const issueCode = document.getElementById("issueCode");
const issueOtherWrap = document.getElementById("issueOtherWrap");
const issueOther = document.getElementById("issueOther");
const issueSummaryPreview = document.getElementById("issueSummaryPreview");

const noPartsNeeded = document.getElementById("noPartsNeeded");
const partsCost = document.getElementById("partsCost");
const addFullService = document.getElementById("addFullService");
const addFullServiceText = document.getElementById("addFullServiceText");

const applianceYearMadeWrap = document.getElementById("applianceYearMadeWrap");
const applianceYearMade = document.getElementById("applianceYearMade");
const applianceYearMadeHelp = document.getElementById("applianceYearMadeHelp");

const washerMatchWrap = document.getElementById("washerMatchWrap");
const dryerMatchesWasher = document.getElementById("dryerMatchesWasher");

const partsOnOrder = document.getElementById("partsOnOrder");
const partsOrderNotes = document.getElementById("partsOrderNotes");

const dryerPhotoWrap = document.getElementById("dryerPhotoWrap");
const dryerPhotoInput = document.getElementById("dryerPhotoInput");
const dryerPhotoHelp = document.getElementById("dryerPhotoHelp");

const billingTechNotes = document.getElementById("billingTechNotes");
const submitBillingBtn = document.getElementById("submitBillingBtn");
const cancelBillingBtn = document.getElementById("cancelBillingBtn");

// ------- state -------
let mode = "today";
let activeBooking = null;
let activeCardEl = null;
let currentTechId = null;
let currentSession = null;

const BOOKING_SELECT = `
  id,
  request_id,
  assigned_tech_id,
  window_start,
  window_end,
  status,
  appointment_type,
  job_ref,
  tech_notes,
  payment_status,
  base_fee_cents,
  full_service_cents,
  collected_cents,
  property_manager_id,
  request_source,
  paid_by_property_manager,
  invoice_status,
  billing_started_at,
  billing_sent_at,
  completed_at,
  booking_requests:request_id (
    id,
    name,
    phone,
    email,
    address,
    notes,
    total_job_approval_limit_cents,
    property_manager_id,
    request_source,
    authorized_entry
  )
`;

// ------- helpers -------
function show(el, on = true) {
  if (el) el.style.display = on ? "" : "none";
}

function setText(el, t) {
  if (el) el.textContent = t ?? "";
}

function hideBillingPanel() {
  billingPanel?.classList.add("hide");
  setText(billingMsg, "");
}

function showBillingPanel() {
  billingPanel?.classList.remove("hide");
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
  return x.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function statusLabel(s) {
  const v = String(s || "").toLowerCase();

  if (v === "en_route") return "en route";
  if (v === "on_site") return "on site";
  if (v === "billing_pending") return "billing pending";
  if (v === "awaiting_payment") return "awaiting payment";
  if (v === "parts_approval_needed") return "approval needed";
  if (v === "parts_on_order") return "parts on order";
  if (v === "return_visit_needed") return "return visit";
  if (v === "no_show") return "no show";

  return v || "scheduled";
}

function cleanPhone(p) {
  if (!p) return "";
  return String(p).replace(/[^\d+]/g, "");
}

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || "")}`;
}

function matchesSlotExactly(slot, booking, toleranceMs = 60_000) {
  const s = slot.start.getTime();
  const e = slot.end.getTime();
  const bs = new Date(booking.window_start).getTime();
  const be = new Date(booking.window_end).getTime();

  return Math.abs(bs - s) <= toleranceMs && Math.abs(be - e) <= toleranceMs;
}

function tzNameSafe() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
  catch { return ""; }
}

function isOutstanding(b) {
  const s = String(b.status || "").toLowerCase();
  return !["completed", "cancelled", "no_show"].includes(s);
}

function isAttentionStatus(b) {
  const s = String(b.status || "").toLowerCase();
  return [
    "awaiting_payment",
    "billing_pending",
    "parts_approval_needed",
    "parts_on_order",
    "return_visit_needed",
    "escalated"
  ].includes(s);
}

function isPmBooking(b) {
  return (
    String(b?.request_source || "").toLowerCase() === "property_manager" ||
    !!b?.property_manager_id ||
    String(b?.booking_requests?.request_source || "").toLowerCase() === "property_manager" ||
    !!b?.booking_requests?.property_manager_id ||
    b?.paid_by_property_manager === true
  );
}

function isAuthorizedEntryBooking(b) {
  return (
    String(b?.appointment_type || "").toLowerCase() === "no_one_home" ||
    b?.booking_requests?.authorized_entry === true
  );
}

function billingRequirementsForBooking(b) {
  const pm = isPmBooking(b);
  const authorizedEntry = isAuthorizedEntryBooking(b);

  return {
    is_pm_job: pm,
    is_authorized_entry: authorizedEntry,
    require_photo: pm || authorizedEntry,
    require_year_made: pm,
    show_washer_match: pm
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read photo file."));
    reader.readAsDataURL(file);
  });
}

function alreadyHasFullService(b) {
  return (
    String(b?.appointment_type || "").toLowerCase() === "full_service" ||
    Number(b?.full_service_cents || 0) > 0
  );
}

const ISSUE_STATEMENTS = {
  thermal_fuse: "The dryer had a failed thermal fuse. The failed part was addressed and the dryer was tested after service.",
  heating_element: "The dryer had a heating element issue. The heating system was serviced and the dryer was tested after service.",
  belt: "The dryer had a belt issue. The belt system was serviced and the dryer was tested after service.",
  rollers: "The dryer had worn drum rollers. The roller system was serviced and the dryer was tested after service.",
  idler_pulley: "The dryer had an idler pulley issue. The belt tension system was serviced and the dryer was tested after service.",
  motor: "The dryer had a motor-related issue. The dryer was diagnosed and serviced based on the motor findings.",
  timer: "The dryer had a timer/control issue. The control system was checked and serviced based on the findings.",
  start_switch: "The dryer had a start switch issue. The start circuit was serviced and the dryer was tested after service.",
  door_switch: "The dryer had a door switch issue. The door switch circuit was serviced and the dryer was tested after service.",
  venting_airflow: "The dryer had an airflow restriction or venting-related issue. Airflow was checked and recommendations were made as needed.",
  noise: "The dryer was making abnormal noise. The moving components were inspected and serviced based on the findings.",
  not_heating: "The dryer was not heating properly. The heating system was diagnosed and serviced based on the findings.",
  not_starting: "The dryer was not starting. The start circuit and related components were diagnosed and serviced based on the findings.",
  takes_too_long: "The dryer was taking too long to dry. Airflow, heating, and related components were checked and serviced based on the findings.",
  other: ""
};

function buildPreviewStatement() {
  const code = issueCode?.value || "";
  let base = ISSUE_STATEMENTS[code] || "";

  if (code === "other") {
    base = issueOther?.value?.trim()
      ? `The dryer was diagnosed for the following issue: ${issueOther.value.trim()}.`
      : "Describe the issue to generate the customer-facing statement.";
  }

  if (!base) {
    base = "Select the main issue to generate the customer-facing repair statement.";
  }

  const lines = [base];

  if (noPartsNeeded?.checked) {
    lines.push("No additional parts were needed for this visit.");
  } else if (partsCost?.value && Number(partsCost.value) > 0) {
    lines.push("Parts were used or recommended as part of this service.");
  }

  if (alreadyHasFullService(activeBooking)) {
    lines.push("Full Service was included with this appointment.");
  } else if (addFullService?.checked) {
    lines.push("Full Service was added during this visit.");
  }

  if (partsOnOrder?.checked) {
    lines.push("Parts need to be ordered before the repair can be fully completed.");
  }

  return lines.join(" ");
}

function updateIssueSummaryPreview() {
  setText(issueSummaryPreview, buildPreviewStatement());
}

function applyBillingRequirementUI() {
  const reqs = billingRequirementsForBooking(activeBooking);

  if (dryerPhotoWrap) dryerPhotoWrap.classList.toggle("hide", !reqs.require_photo);
  if (dryerPhotoInput) {
    dryerPhotoInput.required = reqs.require_photo;
    if (!reqs.require_photo) dryerPhotoInput.value = "";
  }

  if (dryerPhotoHelp) {
    if (reqs.is_pm_job) {
      dryerPhotoHelp.textContent = "Required for property manager records.";
    } else if (reqs.is_authorized_entry) {
      dryerPhotoHelp.textContent = "Required to document authorized-entry service.";
    } else {
      dryerPhotoHelp.textContent = "Not required for standard customer jobs.";
    }
  }

  if (applianceYearMadeWrap) applianceYearMadeWrap.classList.toggle("hide", !reqs.require_year_made);
  if (applianceYearMade) {
    applianceYearMade.required = reqs.require_year_made;
    if (!reqs.require_year_made) applianceYearMade.value = "";
  }

  if (applianceYearMadeHelp) {
    applianceYearMadeHelp.textContent = reqs.require_year_made
      ? "Required for property manager reporting."
      : "Not required for standard customer jobs.";
  }

  if (washerMatchWrap) washerMatchWrap.classList.toggle("hide", !reqs.show_washer_match);
  if (dryerMatchesWasher && !reqs.show_washer_match) dryerMatchesWasher.checked = false;

  if (addFullService && addFullServiceText) {
    const hasFull = alreadyHasFullService(activeBooking);
    addFullService.disabled = hasFull;
    addFullService.checked = false;
    addFullServiceText.textContent = hasFull
      ? "Full Service already included"
      : "Add Full Service (+$20)";
  }

  updateIssueSummaryPreview();
}

// ------- slots -------
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
    mk(8, 0, 10, 0, "8:00–10:00"),
    mk(8, 30, 10, 30, "8:30–10:30"),
    mk(9, 30, 11, 30, "9:30–11:30"),
    mk(10, 0, 12, 0, "10:00–12:00"),
    mk(13, 0, 15, 0, "1:00–3:00"),
    mk(13, 30, 15, 30, "1:30–3:30"),
    mk(14, 30, 16, 30, "2:30–4:30"),
    mk(15, 0, 17, 0, "3:00–5:00")
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
  if (!currentTechId) return [];

  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("assigned_tech_id", currentTechId)
    .gte("window_start", start.toISOString())
    .lt("window_start", end.toISOString())
    .order("window_start", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function loadOutstanding() {
  if (!currentTechId) return [];

  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("assigned_tech_id", currentTechId)
    .not("status", "in", "(completed,cancelled,no_show)")
    .order("window_start", { ascending: true });

  if (error) throw error;
  return data || [];
}

// ------- backend calls -------
async function getSessionOrThrow() {
  let session = currentSession;

  if (!session?.access_token) {
    const { data } = await supabase.auth.getSession();
    session = data?.session || null;
  }

  if (!session?.access_token) {
    throw new Error("You are not signed in.");
  }

  currentSession = session;
  return session;
}

async function postAuthed(url, payload) {
  const session = await getSessionOrThrow();

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify(payload || {})
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || !json.ok) {
    throw new Error(json?.error || json?.message || "Request failed.");
  }

  return json;
}

async function setJobStatus(bookingId, newStatus) {
  try {
    show(detailError, false);
    setText(detailError, "");

    await postAuthed("/api/tech-update-booking-status", {
      booking_id: bookingId,
      status: newStatus
    });

    if (activeBooking && activeBooking.id === bookingId) {
      activeBooking.status = newStatus;
      setText(statusBadge, statusLabel(newStatus));
    }

    await loadAndRender();
  } catch (e) {
    console.error(e);
    show(detailError, true);
    setText(detailError, e?.message || "Could not update status.");
  }
}

async function saveNotes() {
  if (!activeBooking) return;

  setText(saveState, "Saving…");
  show(detailError, false);
  setText(detailError, "");

  try {
    const newNotes = techNotes?.value || "";

    await postAuthed("/api/tech-save-notes", {
      booking_id: activeBooking.id,
      tech_notes: newNotes
    });

    activeBooking.tech_notes = newNotes;
    setText(saveState, "Saved.");
    setTimeout(() => setText(saveState, ""), 1500);
  } catch (e) {
    console.error(e);
    setText(saveState, "");
    show(detailError, true);
    setText(detailError, e?.message || "Could not save notes.");
  }
}

saveNotesBtn?.addEventListener("click", saveNotes);

// ------- details -------
function clearDetails() {
  activeBooking = null;
  if (activeCardEl) activeCardEl.classList.remove("active");
  activeCardEl = null;

  show(detailEmpty, true);
  show(detailWrap, false);
  show(statusBadge, false);
  hideBillingPanel();

  setText(detailError, "");
  show(detailError, false);

  if (techNotes) techNotes.value = "";
  setText(saveState, "");
  if (actionRow) actionRow.innerHTML = "";
}

function renderActions(req) {
  if (!actionRow) return;
  actionRow.innerHTML = "";

  const statusButtons = [
    ["en_route", "En Route"],
    ["on_site", "On Site"]
  ];

  for (const [key, label] of statusButtons) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "action-link";
    b.textContent = label;

    b.addEventListener("click", () => {
      if (!activeBooking) return;

      if (key === "en_route") {
        const ok = confirm(
          "Mark En Route?\n\nThis will notify the customer or tenant that the technician is on the way."
        );
        if (!ok) return;
      }

      setJobStatus(activeBooking.id, key);
    });

    actionRow.appendChild(b);
  }

  const billingBtn = document.createElement("button");
  billingBtn.type = "button";
  billingBtn.className = "action-link";
  billingBtn.textContent = "Billing";
  billingBtn.addEventListener("click", openBillingPanel);
  actionRow.appendChild(billingBtn);

  const completeBtn = document.createElement("button");
  completeBtn.type = "button";
  completeBtn.className = "action-link";
  completeBtn.textContent = "Complete";
  completeBtn.addEventListener("click", completeActiveBooking);
  actionRow.appendChild(completeBtn);

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
  activeCardEl?.classList.add("active");

  show(detailEmpty, false);
  show(detailWrap, true);
  hideBillingPanel();

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
  if (b.request_source) metaLines.push(`Source: ${b.request_source}`);
  if (b.payment_status) metaLines.push(`Payment: ${b.payment_status}`);
  if (b.invoice_status) metaLines.push(`Invoice: ${b.invoice_status}`);

  setText(dMeta, metaLines.join("\n"));

  setText(statusBadge, statusLabel(b.status));
  statusBadge.className = isAttentionStatus(b) ? "badge warn" : "badge";
  show(statusBadge, true);

  if (techNotes) techNotes.value = b.tech_notes || "";
  if (billingTechNotes) billingTechNotes.value = "";

  setText(saveState, "");
  show(detailError, false);
  setText(detailError, "");

  renderActions(req);
}

// ------- billing -------
function hideBillingPanel() {
  billingPanel?.classList.add("hide");
  setText(billingMsg, "");
}

function showBillingPanel() {
  billingPanel?.classList.remove("hide");
}

function openBillingPanel() {
  if (!activeBooking) return;

  if (billingForm) billingForm.reset();
  if (partsCost) partsCost.disabled = false;
  if (issueOtherWrap) issueOtherWrap.classList.add("hide");

  setText(billingMsg, "");

  const req = activeBooking.booking_requests || {};
  setText(
    billingJobTitle,
    `${activeBooking.job_ref || "Job"} — ${req.name || "Customer"}`
  );

  if (billingTechNotes) billingTechNotes.value = "";

  applyBillingRequirementUI();

  showBillingPanel();
  billingPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
}

cancelBillingBtn?.addEventListener("click", () => {
  hideBillingPanel();
});

issueCode?.addEventListener("change", () => {
  const isOther = issueCode.value === "other";
  issueOtherWrap?.classList.toggle("hide", !isOther);
  updateIssueSummaryPreview();
});

issueOther?.addEventListener("input", updateIssueSummaryPreview);
partsCost?.addEventListener("input", updateIssueSummaryPreview);
addFullService?.addEventListener("change", updateIssueSummaryPreview);
partsOnOrder?.addEventListener("change", updateIssueSummaryPreview);

noPartsNeeded?.addEventListener("change", () => {
  if (!partsCost) return;
  partsCost.disabled = noPartsNeeded.checked;
  if (noPartsNeeded.checked) partsCost.value = "";
  updateIssueSummaryPreview();
});

billingForm?.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!activeBooking) {
    setText(billingMsg, "Select a job first.");
    return;
  }

  try {
    setText(billingMsg, "Submitting billing…");
    if (submitBillingBtn) {
      submitBillingBtn.disabled = true;
      submitBillingBtn.style.opacity = "0.75";
    }

    const reqs = billingRequirementsForBooking(activeBooking);
    const file = dryerPhotoInput?.files?.[0] || null;
    const photoDataUrl = file ? await fileToDataUrl(file) : "";

    const payload = {
      booking_id: activeBooking.id,
      issue_code: issueCode?.value || "",
      issue_other: issueOther?.value || "",
      no_parts_needed: !!noPartsNeeded?.checked,
      parts_cost: partsCost?.value || "0",
      add_full_service: !!addFullService?.checked,
      appliance_year_made: applianceYearMade?.value || "",
      dryer_matches_washer: !!dryerMatchesWasher?.checked,
      parts_on_order: !!partsOnOrder?.checked,
      parts_order_notes: partsOrderNotes?.value || "",
      dryer_photo_data_url: photoDataUrl,
      tech_notes: billingTechNotes?.value || "",
      client_require_photo: reqs.require_photo,
      client_require_year_made: reqs.require_year_made,
      customer_summary_preview: buildPreviewStatement()
    };

    const json = await postAuthed("/api/tech-submit-billing", payload);

    let msg = "Billing submitted.";

    if (json.checkout_url) {
      msg += " Payment link was sent to the customer.";
    }

    if (json.booking_status === "parts_approval_needed") {
      msg += " Property manager approval is required.";
    }

    if (json.booking_status === "awaiting_payment") {
      msg += " Job cannot be completed until payment is received.";
    }

    if (json.requirements?.is_pm_job) {
      msg += " PM billing details were saved for the portal.";
    }

    setText(billingMsg, msg);

    await loadAndRender();
  } catch (err) {
    console.error(err);
    setText(billingMsg, err?.message || "Could not submit billing.");
  } finally {
    if (submitBillingBtn) {
      submitBillingBtn.disabled = false;
      submitBillingBtn.style.opacity = "1";
    }
  }
});

async function completeActiveBooking() {
  if (!activeBooking) return;

  const sendReview = confirm(
    "Should we send a review request?\n\nChoose OK only if you feel the customer had a good experience."
  );

  const finalConfirm = confirm(
    `Mark this job complete?\n\nReview request: ${sendReview ? "Yes" : "No"}`
  );

  if (!finalConfirm) return;

  try {
    show(detailError, false);
    setText(detailError, "");

    await postAuthed("/api/tech-complete-booking", {
      booking_id: activeBooking.id,
      send_review: sendReview
    });

    await loadAndRender();
  } catch (err) {
    console.error(err);
    show(detailError, true);
    setText(detailError, err?.message || "Could not complete booking.");
  }
}

// ------- card rendering -------
function makeCard(title, meta, badgeText, clickable = true, warn = false) {
  const card = document.createElement("div");
  card.className = `job-card${warn ? " warn" : ""}`;
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
  badge.className = warn ? "badge warn" : "badge";
  badge.textContent = badgeText;

  top.appendChild(left);
  top.appendChild(badge);

  card.appendChild(top);
  return card;
}

function renderOutstanding(bookings) {
  if (!outstandingJobsList) return;

  outstandingJobsList.innerHTML = "";

  const rows = bookings.filter(isOutstanding);

  if (!rows.length) {
    show(outstandingEmpty, true);
    return;
  }

  show(outstandingEmpty, false);

  for (const b of rows) {
    const req = b.booking_requests || {};
    const title = `${fmtDate(b.window_start)} ${fmtTime(b.window_start)} — ${req.name || "Customer"}`;
    const meta = [
      b.job_ref ? `Job ref: ${b.job_ref}` : "",
      req.address || "",
      isAttentionStatus(b) ? "Needs attention" : ""
    ].filter(Boolean).join(" • ");

    const c = makeCard(title, meta, statusLabel(b.status), true, isAttentionStatus(b));
    c.addEventListener("click", () => selectBooking(b, c));
    outstandingJobsList.appendChild(c);
  }
}

function renderToday(bookings) {
  jobsList.innerHTML = "";
  clearDetails();
  show(jobsEmpty, false);

  const today = new Date();
  const slots = buildDaySlots(today);

  for (const slot of slots) {
    const inSlot = bookings.filter(b => matchesSlotExactly(slot, b));

    if (inSlot.length === 0) {
      const c = makeCard(`${slot.label} — Open`, "Not booked", "open", false);
      jobsList.appendChild(c);
      continue;
    }

    for (const b of inSlot) {
      const req = b.booking_requests || {};
      const meta = [
        req.address || "",
        req.phone ? `📞 ${req.phone}` : "",
        b.appointment_type ? `• ${b.appointment_type}` : ""
      ].filter(Boolean).join(" ");

      const c = makeCard(`${slot.label} — ${req.name || "Customer"}`, meta, statusLabel(b.status), true, isAttentionStatus(b));
      c.addEventListener("click", () => selectBooking(b, c));
      jobsList.appendChild(c);
    }
  }
}

function renderWeek(bookings) {
  jobsList.innerHTML = "";
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
      jobsList.appendChild(header);
    }

    const req = b.booking_requests || {};
    const meta = [
      req.address || "",
      req.phone ? `📞 ${req.phone}` : "",
      b.appointment_type ? `• ${b.appointment_type}` : ""
    ].filter(Boolean).join(" ");

    const title = `${fmtTime(b.window_start)} – ${fmtTime(b.window_end)} — ${req.name || "Customer"}`;
    const c = makeCard(title, meta, statusLabel(b.status), true, isAttentionStatus(b));
    c.addEventListener("click", () => selectBooking(b, c));
    jobsList.appendChild(c);
  }
}

// ------- main load -------
async function loadAndRender() {
  show(jobsError, false);
  setText(jobsError, "");
  show(jobsEmpty, false);

  const { start, end } = getRange();

  const dayStr = start.toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric"
  });

  const zoneStr = tzNameSafe();

  if (mode === "today") {
    setText(rangeLabel, `${dayStr} • ${zoneStr}`);
  } else {
    const endMinus1 = new Date(end);
    endMinus1.setDate(endMinus1.getDate() - 1);
    const endStr = endMinus1.toLocaleDateString([], { month: "short", day: "numeric" });
    setText(rangeLabel, `${dayStr} – ${endStr} • ${zoneStr}`);
  }

  try {
    const [rows, outstanding] = await Promise.all([
      loadAssigned(start, end),
      loadOutstanding()
    ]);

    renderOutstanding(outstanding);

    if (mode === "today") renderToday(rows);
    else renderWeek(rows);
  } catch (e) {
    console.error(e);
    show(jobsError, true);
    setText(jobsError, `Failed to load bookings: ${e?.message || e}`);
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

  currentSession = session;
  currentTechId = session.user?.id || null;
  setText(whoami, session.user?.email || "Signed in");

  setMode("today");
}

main();
