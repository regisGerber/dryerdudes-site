import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey || supabaseAnonKey === "YOUR_ANON_KEY") {
  alert(
    "Missing Supabase config. Check window.__SUPABASE_URL__ and __SUPABASE_ANON_KEY__ in pm.html"
  );
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

const searchInput =
  document.getElementById("jobSearchInput") ||
  document.querySelector(".search");

const filterButtons = Array.from(
  document.querySelectorAll(".filter-btn, .seg .btn.secondary")
);

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
const accessDetails = document.getElementById("accessDetails");
const billingDetails = document.getElementById("billingDetails");

const resendSchedulingBtn =
  document.getElementById("resendSchedulingBtn");

const sendReminderBtn =
  document.getElementById("sendReminderBtn");

const payNowBtn =
  document.getElementById("payNowBtn");

const newRequestPanel =
  document.getElementById("newRequestPanel") ||
  document.querySelector("form.new-request")?.closest(".panel");

const newRequestForm =
  document.getElementById("newRequestForm") ||
  document.querySelector("form.new-request");

const createRequestBtn =
  document.getElementById("createRequestBtn") ||
  newRequestForm?.querySelector('button[type="submit"]');

const newRequestMsg =
  document.getElementById("newRequestMsg");

const vacantUnitCheckbox =
  document.getElementById("vacantUnitCheckbox");

const tenantContactFields =
  document.getElementById("tenantContactFields");

const fullServiceCheckbox =
  document.getElementById("fullServiceCheckbox");

const vacantDetails =
  document.getElementById("vacantDetails");

const vacancyAccessMethod =
  document.getElementById("vacancyAccessMethod");

const vacancyEndsOn =
  document.getElementById("vacancyEndsOn");

const keyPickupWrap =
  document.getElementById("keyPickupWrap");

const keyPickupAddress =
  document.getElementById("keyPickupAddress");

const keyPickupAddressStatus =
  document.getElementById("keyPickupAddressStatus");

const vacancyInstructionsWrap =
  document.getElementById("vacancyInstructionsWrap");

const vacancyInstructionsLabel =
  document.getElementById("vacancyInstructionsLabel");

const vacancyAccessInstructions =
  document.getElementById("vacancyAccessInstructions");

const vacantEntryAuthorization =
  document.getElementById("vacantEntryAuthorization");

const pmServiceAddress =
  document.getElementById("pmServiceAddress");

const pmAddressLine1 =
  document.getElementById("pmAddressLine1");

const pmAddressCity =
  document.getElementById("pmAddressCity");

const pmAddressState =
  document.getElementById("pmAddressState");

const pmAddressZip =
  document.getElementById("pmAddressZip");

const pmAddressVerified =
  document.getElementById("pmAddressVerified");

const currentBalanceText =
  document.getElementById("currentBalanceText");

const latestInvoiceText =
  document.getElementById("latestInvoiceText");

const payBalanceBtn =
  document.getElementById("payBalanceBtn");

// ---------- State ----------
let currentSession = null;
let currentPm = null;
let allJobs = [];
let filteredJobs = [];
let activeJob = null;
let activeCardEl = null;
let activeFilter = "active";

let pmServiceAddressSelected = false;
let pmAddressAutocompleteInitialized = false;
let pmAddressInitAttempts = 0;
let pmServiceAutocomplete = null;
let pmKeyPickupAutocomplete = null;

const SERVICE_AREA_MESSAGE =
  "We are not currently servicing this address. To keep prices low and make online scheduling possible, we maintain a tight service area—but it covers nearly all of Medford and the surrounding cities.";

// ---------- Helpers ----------
function show(el, on = true) {
  if (el) {
    el.style.display = on ? "" : "none";
  }
}

function setText(el, text) {
  if (el) {
    el.textContent = text ?? "";
  }
}

function setHtml(el, html) {
  if (el) {
    el.innerHTML = html ?? "";
  }
}

function setError(message) {
  if (!portalError) {
    if (message) {
      alert(message);
    }
    return;
  }

  if (!message) {
    setText(portalError, "");
    show(portalError, false);
    return;
  }

  setText(portalError, message);
  show(portalError, true);
}

function setHidden(el, hidden = true) {
  el?.classList.toggle("hide", hidden);
}

function setRequired(el, required = true) {
  if (!el) {
    return;
  }

  if (required) {
    el.setAttribute("required", "required");
  } else {
    el.removeAttribute("required");
  }
}

function setRequestMessage(message, type = "info") {
  if (!newRequestMsg) {
    return;
  }

  newRequestMsg.classList.remove(
    "info",
    "success",
    "error",
    "hide"
  );

  if (!message) {
    setText(newRequestMsg, "");
    newRequestMsg.classList.add("hide");
    return;
  }

  newRequestMsg.classList.add(type);
  setText(newRequestMsg, message);
}

function cleanString(value) {
  return String(value || "").trim();
}

function isGooglePlacesReady() {
  return !!(
    window.google &&
    google.maps &&
    google.maps.places &&
    google.maps.places.Autocomplete
  );
}

function parseGoogleAddress(place) {
  if (!place || !Array.isArray(place.address_components)) {
    return null;
  }

  let streetNumber = "";
  let route = "";
  let city = "";
  let state = "";
  let zip = "";

  for (const component of place.address_components) {
    const types = component.types || [];

    if (types.includes("street_number")) {
      streetNumber = component.long_name || "";
    }

    if (types.includes("route")) {
      route = component.long_name || "";
    }

    if (
      !city &&
      (
        types.includes("locality") ||
        types.includes("postal_town") ||
        types.includes("administrative_area_level_2")
      )
    ) {
      city = component.long_name || "";
    }

    if (types.includes("administrative_area_level_1")) {
      state =
        component.short_name ||
        component.long_name ||
        "";
    }

    if (types.includes("postal_code")) {
      zip = component.long_name || "";
    }
  }

  if (!streetNumber || !route) {
    return null;
  }

  const line1 = `${streetNumber} ${route}`.trim();

  const composed = [
    line1,
    city,
    state,
    zip
  ]
    .filter(Boolean)
    .join(", ");

  return {
    line1,
    city,
    state,
    zip,
    formatted:
      cleanString(place.formatted_address) ||
      composed
  };
}

function setAddressStatus(
  el,
  message,
  kind = "verified"
) {
  if (!el) {
    return;
  }

  el.classList.remove(
    "hide",
    "verified",
    "warning"
  );

  el.classList.add(kind);
  setText(el, message);
}

function clearPmServiceAddressSelection() {
  pmServiceAddressSelected = false;

  if (pmAddressLine1) {
    pmAddressLine1.value = "";
  }

  if (pmAddressCity) {
    pmAddressCity.value = "";
  }

  if (pmAddressState) {
    pmAddressState.value = "";
  }

  if (pmAddressZip) {
    pmAddressZip.value = "";
  }

  setHidden(pmAddressVerified, true);
}

function fillPmServiceAddressFromPlace(place) {
  const parsed = parseGoogleAddress(place);

  if (!parsed) {
    clearPmServiceAddressSelection();

    setAddressStatus(
      pmAddressVerified,
      "Please choose a complete street address from the suggestions.",
      "warning"
    );

    return;
  }

  if (pmServiceAddress) {
    pmServiceAddress.value = parsed.formatted;
  }

  if (pmAddressLine1) {
    pmAddressLine1.value = parsed.line1;
  }

  if (pmAddressCity) {
    pmAddressCity.value = parsed.city;
  }

  if (pmAddressState) {
    pmAddressState.value = parsed.state;
  }

  if (pmAddressZip) {
    pmAddressZip.value = parsed.zip;
  }

  pmServiceAddressSelected = true;

  setAddressStatus(
    pmAddressVerified,
    "✓ Address selected and ready for service-area verification",
    "verified"
  );
}

function fillKeyPickupAddressFromPlace(place) {
  const parsed = parseGoogleAddress(place);

  if (!parsed) {
    return;
  }

  if (keyPickupAddress) {
    keyPickupAddress.value = parsed.formatted;
  }

  setAddressStatus(
    keyPickupAddressStatus,
    "✓ Key pickup address selected",
    "verified"
  );
}

function initPmAddressAutocomplete() {
  if (pmAddressAutocompleteInitialized) {
    return;
  }

  if (!pmServiceAddress) {
    return;
  }

  if (!isGooglePlacesReady()) {
    pmAddressInitAttempts += 1;

    if (pmAddressInitAttempts <= 25) {
      setTimeout(
        initPmAddressAutocomplete,
        300
      );
    } else {
      console.warn(
        "Google Places Autocomplete did not load for the PM portal."
      );
    }

    return;
  }

  pmAddressAutocompleteInitialized = true;

  const medfordBounds =
    new google.maps.LatLngBounds(
      new google.maps.LatLng(
        41.95,
        -123.25
      ),
      new google.maps.LatLng(
        42.65,
        -122.45
      )
    );

  const options = {
    fields: [
      "address_components",
      "formatted_address"
    ],
    types: ["address"],
    componentRestrictions: {
      country: "us"
    },
    bounds: medfordBounds,
    strictBounds: false
  };

  pmServiceAutocomplete =
    new google.maps.places.Autocomplete(
      pmServiceAddress,
      options
    );

  pmServiceAddress.addEventListener(
    "input",
    clearPmServiceAddressSelection
  );

  pmServiceAutocomplete.addListener(
    "place_changed",
    () => {
      fillPmServiceAddressFromPlace(
        pmServiceAutocomplete.getPlace()
      );
    }
  );

  if (keyPickupAddress) {
    pmKeyPickupAutocomplete =
      new google.maps.places.Autocomplete(
        keyPickupAddress,
        options
      );

    keyPickupAddress.addEventListener(
      "input",
      () => {
        setHidden(
          keyPickupAddressStatus,
          true
        );
      }
    );

    pmKeyPickupAutocomplete.addListener(
      "place_changed",
      () => {
        fillKeyPickupAddressFromPlace(
          pmKeyPickupAutocomplete.getPlace()
        );
      }
    );
  }
}

window.ddInitPmAddressAutocomplete =
  initPmAddressAutocomplete;

function propertyManagerAddressOnFile() {
  if (!currentPm) {
    return "";
  }

  return [
    currentPm.billing_address_line_1,
    currentPm.billing_address_line_2,
    currentPm.billing_city,
    currentPm.billing_state,
    currentPm.billing_zip
  ]
    .filter(Boolean)
    .join(", ");
}

function fillDefaultKeyPickupAddress(
  force = false
) {
  if (!keyPickupAddress) {
    return;
  }

  if (
    !force &&
    cleanString(keyPickupAddress.value)
  ) {
    return;
  }

  const address =
    propertyManagerAddressOnFile();

  if (!address) {
    return;
  }

  keyPickupAddress.value = address;

  setAddressStatus(
    keyPickupAddressStatus,
    "Using the property management address on file. You can edit it if needed.",
    "verified"
  );
}

function localTodayIso() {
  const now = new Date();

  const y = now.getFullYear();

  const m = String(
    now.getMonth() + 1
  ).padStart(2, "0");

  const d = String(
    now.getDate()
  ).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

function formatScheduledWindow(result) {
  const start = result?.window_start
    ? new Date(result.window_start)
    : null;

  const end = result?.window_end
    ? new Date(result.window_end)
    : null;

  if (
    !start ||
    Number.isNaN(start.getTime())
  ) {
    return "the first available appointment";
  }

  const date =
    start.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric"
    });

  const startTime =
    start.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });

  const endTime =
    end &&
    !Number.isNaN(end.getTime())
      ? end.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit"
        })
      : "";

  return (
    `${date}, ${startTime}` +
    `${endTime ? `–${endTime}` : ""}`
  );
}

function friendlyPmRequestError(json) {
  const parts = [
    json?.error,
    json?.message,
    json?.upstream?.error,
    json?.upstream?.message,
    json?.upstream?.details?.error,
    json?.upstream?.details?.message,
    json?.upstream?.details?.data?.error,
    json?.upstream?.details?.data?.message
  ].filter(Boolean);

  const text =
    parts
      .join(" ")
      .toLowerCase();

  if (
    text.includes("invalid address") ||
    text.includes("geocoding failed") ||
    text.includes("valid street address") ||
    text.includes("incomplete address")
  ) {
    return "Please select a complete, valid street address from the dropdown suggestions.";
  }

  if (
    text.includes("outside service area") ||
    text.includes("could not resolve zone for address") ||
    text.includes("address outside service area")
  ) {
    return SERVICE_AREA_MESSAGE;
  }

  if (
    text.includes("no appointment options")
  ) {
    return "No appointment options are currently available for this address. Please try again after additional schedule openings are added.";
  }

  return (
    json?.message ||
    json?.error ||
    json?.upstream?.message ||
    json?.upstream?.error ||
    "Could not create the service request."
  );
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
  if (!value) {
    return "";
  }

  const d = new Date(value);

  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function fmtTime(value) {
  if (!value) {
    return "";
  }

  const d = new Date(value);

  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function fmtDateTime(value) {
  if (!value) {
    return "";
  }

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
  return `$${(
    Number(cents || 0) / 100
  ).toFixed(0)}`;
}

function statusLabel(status) {
  const s =
    String(status || "")
      .toLowerCase();

  if (s === "pending_scheduling") {
    return "pending scheduling";
  }

  if (s === "awaiting_approval") {
    return "awaiting approval";
  }

  if (s === "in_progress") {
    return "in progress";
  }

  if (s === "completed") {
    return "completed";
  }

  if (s === "canceled") {
    return "canceled";
  }

  if (s === "scheduled") {
    return "scheduled";
  }

  if (s === "sent") {
    return "pending scheduling";
  }

  if (s === "approval") {
    return "approval";
  }

  if (s === "parts_needed") {
    return "parts needed";
  }

  if (s === "return_visit") {
    return "return visit";
  }

  return s || "pending";
}

function recordTypeLabel(row) {
  return row.record_type === "booking"
    ? "booking"
    : "request";
}

function isActiveStatus(row) {
  const s =
    String(row.status || "")
      .toLowerCase();

  return ![
    "completed",
    "canceled"
  ].includes(s);
}

function getFilterValue(btn) {
  const dataFilter =
    btn?.dataset?.filter;

  if (dataFilter) {
    return dataFilter;
  }

  const txt =
    String(btn?.textContent || "")
      .trim()
      .toLowerCase();

  if (txt.includes("awaiting")) {
    return "awaiting_approval";
  }

  if (txt.includes("completed")) {
    return "completed";
  }

  if (txt.includes("all")) {
    return "all";
  }

  return "active";
}

function matchesFilter(row, filter) {
  const s =
    String(row.status || "")
      .toLowerCase();

  if (filter === "all") {
    return true;
  }

  if (filter === "active") {
    return isActiveStatus(row);
  }

  if (filter === "awaiting_approval") {
    return [
      "awaiting_approval",
      "approval",
      "parts_needed"
    ].includes(s);
  }

  if (filter === "completed") {
    return s === "completed";
  }

  return true;
}

function matchesSearch(row, term) {
  const q =
    String(term || "")
      .trim()
      .toLowerCase();

  if (!q) {
    return true;
  }

  const haystack = [
    row.tenant_name,
    row.tenant_phone,
    row.tenant_email,
    row.service_address,
    row.job_ref,
    row.status
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

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

  if (isVacantJob(row)) {
    items.push(
      "Vacant unit — automatically scheduled by the property manager portal"
    );
  }

  if (row.scheduling_link_sent_at) {
    items.push(
      `Scheduling link sent: ${fmtDateTime(
        row.scheduling_link_sent_at
      )}`
    );
  }

  if (row.scheduling_link_opened_at) {
    items.push(
      `Link opened: ${fmtDateTime(
        row.scheduling_link_opened_at
      )}`
    );
  }

  if (row.authorized_entry === true) {
    items.push("Authorized entry");
  }

  if (row.selected_slot_at) {
    items.push(
      `Appointment selected: ${fmtDateTime(
        row.selected_slot_at
      )}`
    );
  }

  if (!items.length) {
    const s =
      String(row.status || "")
        .toLowerCase();

    if (
      s === "pending_scheduling" ||
      s === "sent"
    ) {
      return "No tenant scheduling activity yet.";
    }

    return "No scheduling activity recorded.";
  }

  return items.join("\n");
}

function appointmentText(row) {
  if (
    !row.window_start ||
    !row.window_end
  ) {
    return "Not scheduled yet.";
  }

  return [
    fmtDateOnly(row.window_start),
    `${fmtTime(row.window_start)} – ${fmtTime(
      row.window_end
    )}`,
    row.appointment_type || "standard"
  ].join("\n");
}

function approvalSettingsText(row) {
  const appointmentType =
    String(row.appointment_type || "")
      .toLowerCase();

  const hasFullService =
    appointmentType === "full_service" ||
    Number(row.full_service_cents || 0) > 0;

  let fullServiceText =
    "Not selected";

  if (hasFullService) {
    fullServiceText =
      "Provide Full Service (+$20)";
  } else if (
    row.addon_preapproved === true
  ) {
    fullServiceText =
      "Pre-approved (legacy request)";
  }

  return [
    `Total job pre-approval limit: ${fmtMoneyCents(
      approvalLimitFor(row)
    )}`,
    `Full Service: ${fullServiceText}`
  ].join("\n");
}

function accessDetailsText(row) {
  const items = [];

  const notes =
    cleanString(row.notes);

  if (row.authorized_entry === true) {
    items.push(
      "Authorized entry approved"
    );
  } else {
    items.push(
      "Standard tenant access"
    );
  }

  if (notes) {
    items.push(notes);
  }

  return items.join("\n");
}

function billingText(row) {
  if (!row.booking_id) {
    return (
      "Not billed yet.\n" +
      "This request has not become a scheduled booking."
    );
  }

  const base =
    Number(row.base_fee_cents || 0);

  const fullService =
    Number(row.full_service_cents || 0);

  const collected =
    Number(row.collected_cents || 0);

  const total =
    base + fullService;

  return [
    `Base service: ${fmtMoneyCents(base)}`,
    `Full service add-on: ${fmtMoneyCents(
      fullService
    )}`,
    `Scheduled total: ${fmtMoneyCents(total)}`,
    `Collected: ${fmtMoneyCents(collected)}`,
    `Payment status: ${
      row.payment_status || "not set"
    }`
  ].join("\n");
}

function isVacantJob(row) {
  const notesFlag =
    /VACANT UNIT/i.test(
      String(row?.notes || "")
    );

  const autoScheduledAuthorizedEntry =
    row?.authorized_entry === true &&
    !row?.scheduling_link_sent_at &&
    !!(
      row?.window_start ||
      row?.selected_slot_at ||
      row?.booking_id
    );

  return (
    notesFlag ||
    autoScheduledAuthorizedEntry
  );
}

function jobCardTitle(row) {
  const who =
    isVacantJob(row)
      ? "Vacant unit"
      : (
          row.tenant_name ||
          "Tenant"
        );

  const address =
    row.service_address ||
    "No address";

  return `${who} — ${address}`;
}

function jobCardMeta(row) {
  if (
    row.window_start &&
    row.window_end
  ) {
    return (
      `${statusLabel(row.status)} • ` +
      `${fmtDateOnly(row.window_start)} • ` +
      `${fmtTime(row.window_start)} – ` +
      `${fmtTime(row.window_end)}`
    );
  }

  if (row.record_type === "request") {
    return (
      `${statusLabel(row.status)} • ` +
      `request created ${fmtDateOnly(
        row.created_at
      )}`
    );
  }

  return statusLabel(row.status);
}

// ---------- Auth ----------
async function requireAuth() {
  const {
    data: {
      session
    }
  } = await supabase.auth.getSession();

  if (!session) {
    window.location.href =
      "/login.html";

    return null;
  }

  return session;
}

async function logout() {
  await supabase.auth.signOut();

  window.location.href =
    "/login.html";
}

logoutBtn?.addEventListener(
  "click",
  logout
);

// ---------- Data ----------
async function loadProfileRole(userId) {
  const {
    data,
    error
  } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.role || null;
}

async function loadPropertyManagerProfile() {
  const session =
    currentSession ||
    (
      await supabase.auth.getSession()
    )?.data?.session;

  if (session?.access_token) {
    try {
      const response =
        await fetch(
          "/api/pm-request-times?mode=profile",
          {
            method: "GET",
            headers: {
              Authorization:
                `Bearer ${session.access_token}`
            }
          }
        );

      const json =
        await response
          .json()
          .catch(() => ({}));

      if (
        response.ok &&
        json?.ok &&
        json?.profile
      ) {
        return json.profile;
      }

      console.warn(
        "PM profile API did not return a profile; falling back to RPC.",
        json
      );
    } catch (error) {
      console.warn(
        "PM profile API failed; falling back to RPC.",
        error
      );
    }
  }

  const {
    data,
    error
  } = await supabase.rpc(
    "get_my_property_manager_profile"
  );

  if (error) {
    throw error;
  }

  const row =
    Array.isArray(data)
      ? data[0]
      : data;

  return row || null;
}

async function loadPmJobs() {
  const {
    data,
    error
  } = await supabase.rpc(
    "get_my_property_manager_jobs"
  );

  if (error) {
    throw error;
  }

  return Array.isArray(data)
    ? data
    : [];
}

async function createPmRequestFromForm() {
  const formData =
    new FormData(newRequestForm);

  const vacantUnit =
    !!vacantUnitCheckbox?.checked;

  const enteredTenantName =
    cleanString(
      formData.get("tenant_name")
    );

  const enteredTenantPhone =
    cleanString(
      formData.get("tenant_phone")
    );

  const enteredTenantEmail =
    cleanString(
      formData.get("tenant_email")
    );

  const tenantName =
    vacantUnit
      ? cleanString(
          currentPm?.contact_name ||
          currentPm?.company_name ||
          "Property manager"
        )
      : enteredTenantName;

  const tenantPhone =
    vacantUnit
      ? cleanString(
          currentPm?.phone ||
          enteredTenantPhone
        )
      : enteredTenantPhone;

  const tenantEmail =
    vacantUnit
      ? cleanString(
          currentPm?.email ||
          currentSession?.user?.email ||
          enteredTenantEmail
        )
      : enteredTenantEmail;

  const serviceAddress =
    cleanString(
      formData.get("service_address")
    );

  const accessNotes =
    cleanString(
      formData.get("access_notes")
    );

  const approvalRaw =
    formData.get(
      "total_job_approval_limit_cents"
    ) ||
    formData.get(
      "parts_approval_limit"
    ) ||
    currentPm?.default_job_approval_limit_cents ||
    15000;

  let totalJobApprovalLimitCents =
    Number(approvalRaw || 15000);

  if (
    [
      150,
      175,
      200,
      225,
      250
    ].includes(
      totalJobApprovalLimitCents
    )
  ) {
    totalJobApprovalLimitCents *= 100;
  }

  const fullServiceRequested =
    !!fullServiceCheckbox?.checked;

  const vacancyAccessMethodValue =
    cleanString(
      formData.get(
        "vacancy_access_method"
      )
    );

  const vacancyEndsOnValue =
    cleanString(
      formData.get(
        "vacancy_ends_on"
      )
    );

  const keyPickupAddressValue =
    cleanString(
      formData.get(
        "key_pickup_address"
      )
    );

  const vacancyAccessInstructionsValue =
    cleanString(
      formData.get(
        "vacancy_access_instructions"
      )
    );

  if (!serviceAddress) {
    throw new Error(
      "Service address is required."
    );
  }

  if (
    isGooglePlacesReady() &&
    !pmServiceAddressSelected
  ) {
    throw new Error(
      "Please select the service address from the dropdown suggestions so it can be verified."
    );
  }

  if (
    !vacantUnit &&
    (
      !tenantName ||
      !tenantPhone ||
      !tenantEmail
    )
  ) {
    throw new Error(
      "Tenant name, phone, and email are required."
    );
  }

  if (vacantUnit) {
    if (!vacancyAccessMethodValue) {
      throw new Error(
        "Choose whether access is by lockbox or key pickup."
      );
    }

    if (!vacancyEndsOnValue) {
      throw new Error(
        "Enter the date the vacancy ends."
      );
    }

    if (
      vacancyAccessMethodValue ===
        "key_pickup" &&
      !keyPickupAddressValue
    ) {
      throw new Error(
        "Enter the key pickup address."
      );
    }

    if (
      !vacancyAccessInstructionsValue
    ) {
      throw new Error(
        "Enter the vacant-unit access instructions."
      );
    }

    if (
      !vacantEntryAuthorization?.checked
    ) {
      throw new Error(
        "Authorize entry to the vacant unit before creating the request."
      );
    }
  }

  const session =
    currentSession ||
    (
      await supabase.auth.getSession()
    )?.data?.session;

  if (!session?.access_token) {
    throw new Error(
      "You are not signed in."
    );
  }

  const resp =
    await fetch(
      "/api/pm-request-times",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          Authorization:
            `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          tenant_name:
            tenantName,

          tenant_phone:
            tenantPhone,

          tenant_email:
            tenantEmail,

          service_address:
            serviceAddress,

          address_line1:
            cleanString(
              formData.get(
                "address_line1"
              )
            ),

          address_city:
            cleanString(
              formData.get(
                "address_city"
              )
            ),

          address_state:
            cleanString(
              formData.get(
                "address_state"
              )
            ),

          address_zip:
            cleanString(
              formData.get(
                "address_zip"
              )
            ),

          access_notes:
            accessNotes,

          total_job_approval_limit_cents:
            totalJobApprovalLimitCents,

          addon_preapproved:
            fullServiceRequested,

          full_service_requested:
            fullServiceRequested,

          vacant_unit:
            vacantUnit,

          vacancy_access_method:
            vacancyAccessMethodValue,

          vacancy_ends_on:
            vacancyEndsOnValue,

          key_pickup_address:
            keyPickupAddressValue,

          vacancy_access_instructions:
            vacancyAccessInstructionsValue,

          vacant_entry_authorized:
            !!vacantEntryAuthorization?.checked
        })
      }
    );

  const json =
    await resp
      .json()
      .catch(() => ({}));

  if (!resp.ok || !json.ok) {
    console.error(
      "PM request-times failed:",
      json
    );

    const err =
      new Error(
        friendlyPmRequestError(json)
      );

    err.apiPayload = json;

    throw err;
  }

  return json;
}

// ---------- Render ----------
function clearDetails() {
  activeJob = null;

  if (activeCardEl) {
    activeCardEl.classList.remove(
      "active"
    );
  }

  activeCardEl = null;

  show(detailEmpty, true);
  show(detailWrap, false);
  show(detailStatusBadge, false);

  setText(
    detailTitle,
    "Job details"
  );

  setText(
    detailSubtext,
    "Select a request or booking to view details."
  );
}

function selectJob(row, cardEl) {
  if (activeCardEl) {
    activeCardEl.classList.remove(
      "active"
    );
  }

  activeCardEl = cardEl;

  activeCardEl?.classList.add(
    "active"
  );

  activeJob = row;

  renderJobDetails(row);
}

function renderJobDetails(row) {
  show(detailEmpty, false);
  show(detailWrap, true);
  show(detailStatusBadge, true);

  setText(
    detailTitle,
    row.job_ref
      ? `Job ${row.job_ref}`
      : "Request details"
  );

  setText(
    detailSubtext,
    `${recordTypeLabel(row)} • ${
      row.request_id || ""
    }`
  );

  setText(
    detailStatusBadge,
    statusLabel(row.status)
  );

  if (tenantDetails) {
    const contactLines =
      isVacantJob(row)
        ? [
            "Vacant unit",
            row.tenant_name
              ? `Property manager contact: ${row.tenant_name}`
              : "",
            row.tenant_phone || "",
            row.tenant_email || ""
          ]
        : [
            row.tenant_name ||
              "No tenant name",
            row.tenant_phone || "",
            row.tenant_email || ""
          ];

    setHtml(
      tenantDetails,
      contactLines
        .filter(Boolean)
        .map(escapeHtml)
        .join("<br>")
    );
  }

  setText(
    addressDetails,
    row.service_address ||
      "No address"
  );

  setText(
    schedulingDetails,
    schedulingActivityText(row)
  );

  setText(
    appointmentDetails,
    appointmentText(row)
  );

  setText(
    approvalDetails,
    approvalSettingsText(row)
  );

  setText(
    accessDetails,
    accessDetailsText(row)
  );

  setText(
    billingDetails,
    billingText(row)
  );

  const hasBooking =
    !!row.booking_id;

  if (payNowBtn) {
    payNowBtn.disabled = true;

    payNowBtn.title =
      hasBooking
        ? "PM payment checkout is not connected yet."
        : "This request has not become a booking yet.";
  }

  if (resendSchedulingBtn) {
    resendSchedulingBtn.disabled = true;

    resendSchedulingBtn.title =
      "Scheduling-link resend is not connected yet.";
  }

  if (sendReminderBtn) {
    sendReminderBtn.disabled = true;

    sendReminderBtn.title =
      "Tenant reminders are not connected yet.";
  }
}

function createJobCard(row) {
  const card =
    document.createElement("div");

  card.className =
    "job-card";

  card.innerHTML = `
    <div class="job-top">
      <div>
        <div class="job-title">${escapeHtml(
          jobCardTitle(row)
        )}</div>

        <div class="job-meta">${escapeHtml(
          jobCardMeta(row)
        )}</div>
      </div>

      <span class="badge">${escapeHtml(
        statusLabel(row.status)
      )}</span>
    </div>
  `;

  card.addEventListener(
    "click",
    () => {
      selectJob(row, card);
    }
  );

  return card;
}

function renderJobs() {
  if (!jobsList) {
    return;
  }

  const term =
    searchInput?.value?.trim() ||
    "";

  filteredJobs =
    allJobs
      .filter((row) =>
        matchesFilter(
          row,
          activeFilter
        )
      )
      .filter((row) =>
        matchesSearch(
          row,
          term
        )
      );

  jobsList.innerHTML = "";

  if (!filteredJobs.length) {
    const empty =
      document.createElement("div");

    empty.className =
      "tiny";

    empty.style.marginTop =
      "10px";

    empty.textContent =
      activeFilter === "active"
        ? "No active property manager requests yet. Create a new request below."
        : "No jobs found for this filter.";

    jobsList.appendChild(empty);

    clearDetails();

    return;
  }

  filteredJobs.forEach(
    (row, index) => {
      const card =
        createJobCard(row);

      jobsList.appendChild(card);

      if (index === 0) {
        selectJob(row, card);
      }
    }
  );
}

function renderBillingSummary() {
  const bookings =
    allJobs.filter(
      (row) => row.booking_id
    );

  const completed =
    bookings.filter(
      (row) =>
        String(
          row.status || ""
        ).toLowerCase() ===
        "completed"
    );

  if (!bookings.length) {
    setText(
      currentBalanceText,
      "No scheduled PM jobs yet."
    );

    setText(
      latestInvoiceText,
      "No billing activity yet."
    );

    if (payBalanceBtn) {
      payBalanceBtn.disabled = true;
    }

    return;
  }

  const scheduledTotal =
    bookings.reduce(
      (sum, row) => {
        return (
          sum +
          Number(
            row.base_fee_cents || 0
          ) +
          Number(
            row.full_service_cents || 0
          )
        );
      },
      0
    );

  const collectedTotal =
    bookings.reduce(
      (sum, row) => {
        return (
          sum +
          Number(
            row.collected_cents || 0
          )
        );
      },
      0
    );

  setText(
    currentBalanceText,
    [
      `Scheduled PM jobs: ${bookings.length}`,
      `Completed jobs: ${completed.length}`,
      `Scheduled service total: ${fmtMoneyCents(
        scheduledTotal
      )}`,
      `Collected so far: ${fmtMoneyCents(
        collectedTotal
      )}`
    ].join("\n")
  );

  const latest =
    bookings[0];

  setText(
    latestInvoiceText,
    latest
      ? [
          latest.job_ref
            ? `Latest job: ${latest.job_ref}`
            : "Latest PM booking",

          latest.window_start
            ? `Date: ${fmtDateOnly(
                latest.window_start
              )}`
            : "",

          `Status: ${statusLabel(
            latest.status
          )}`
        ]
          .filter(Boolean)
          .join("\n")
      : "No billing activity yet."
  );

  if (payBalanceBtn) {
    payBalanceBtn.disabled = true;

    payBalanceBtn.title =
      "Stripe PM billing is not connected yet.";
  }
}

function updateVacancyAccessUI() {
  const isVacant =
    !!vacantUnitCheckbox?.checked;

  const method =
    cleanString(
      vacancyAccessMethod?.value
    );

  const isKeyPickup =
    isVacant &&
    method === "key_pickup";

  const hasMethod =
    isVacant &&
    !!method;

  setHidden(
    keyPickupWrap,
    !isKeyPickup
  );

  setHidden(
    vacancyInstructionsWrap,
    !hasMethod
  );

  setRequired(
    keyPickupAddress,
    isKeyPickup
  );

  setRequired(
    vacancyAccessInstructions,
    hasMethod
  );

  if (isKeyPickup) {
    fillDefaultKeyPickupAddress();

    setText(
      vacancyInstructionsLabel,
      "Key pickup and unit-entry instructions"
    );

    if (vacancyAccessInstructions) {
      vacancyAccessInstructions.placeholder =
        "Office hours, who to ask for, key return instructions, alarm details, and where the dryer is located.";
    }
  } else if (
    method === "lockbox"
  ) {
    setText(
      vacancyInstructionsLabel,
      "Lockbox location and code"
    );

    if (vacancyAccessInstructions) {
      vacancyAccessInstructions.placeholder =
        "Lockbox location and code, alarm details, parking notes, and where the dryer is located.";
    }
  }
}

function updateVacantUnitUI() {
  const isVacant =
    !!vacantUnitCheckbox?.checked;

  setHidden(
    tenantContactFields,
    isVacant
  );

  setHidden(
    vacantDetails,
    !isVacant
  );

  tenantContactFields
    ?.querySelectorAll(
      'input[name="tenant_name"], input[name="tenant_phone"], input[name="tenant_email"]'
    )
    .forEach((input) => {
      setRequired(
        input,
        !isVacant
      );
    });

  setRequired(
    vacancyAccessMethod,
    isVacant
  );

  setRequired(
    vacancyEndsOn,
    isVacant
  );

  setRequired(
    vacantEntryAuthorization,
    isVacant
  );

  if (isVacant) {
    if (vacancyEndsOn) {
      vacancyEndsOn.min =
        localTodayIso();
    }

    fillDefaultKeyPickupAddress();
  } else {
    setRequired(
      keyPickupAddress,
      false
    );

    setRequired(
      vacancyAccessInstructions,
      false
    );
  }

  updateVacancyAccessUI();
}

function wireVacantUnitForm() {
  vacantUnitCheckbox?.addEventListener(
    "change",
    updateVacantUnitUI
  );

  vacancyAccessMethod?.addEventListener(
    "change",
    updateVacancyAccessUI
  );

  if (vacancyEndsOn) {
    vacancyEndsOn.min =
      localTodayIso();
  }

  updateVacantUnitUI();
}

// ---------- Wire ----------
function wireFilters() {
  filterButtons.forEach((btn) => {
    btn.addEventListener(
      "click",
      () => {
        activeFilter =
          getFilterValue(btn);

        filterButtons.forEach(
          (b) => {
            b.classList.remove(
              "active-filter"
            );

            b.style.opacity =
              "0.75";
          }
        );

        btn.classList.add(
          "active-filter"
        );

        btn.style.opacity =
          "1";

        renderJobs();
      }
    );
  });

  const activeBtn =
    filterButtons.find(
      (b) =>
        getFilterValue(b) ===
        "active"
    );

  if (activeBtn) {
    activeBtn.classList.add(
      "active-filter"
    );

    activeBtn.style.opacity =
      "1";
  }
}

function wireSearch() {
  searchInput?.addEventListener(
    "input",
    renderJobs
  );
}

function wireNewRequestButton() {
  newRequestBtn?.addEventListener(
    "click",
    () => {
      newRequestPanel?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }
  );
}

function wireNewRequestForm() {
  newRequestForm?.addEventListener(
    "submit",
    async (e) => {
      e.preventDefault();

      setError("");
      setRequestMessage("");

      if (!currentPm) {
        setRequestMessage(
          "Property manager account not loaded.",
          "error"
        );

        return;
      }

      if (
        !newRequestForm.checkValidity()
      ) {
        newRequestForm.reportValidity();
        return;
      }

      if (createRequestBtn) {
        createRequestBtn.disabled =
          true;

        createRequestBtn.style.opacity =
          "0.85";
      }

      const isVacant =
        !!vacantUnitCheckbox?.checked;

      setRequestMessage(
        isVacant
          ? "Finding the first eligible appointment and scheduling the vacant unit…"
          : "Creating the request and sending the tenant scheduling email…",
        "info"
      );

      try {
        const result =
          await createPmRequestFromForm();

        newRequestForm.reset();
        clearPmServiceAddressSelection();

        if (fullServiceCheckbox) {
          fullServiceCheckbox.checked =
            true;
        }

        updateVacantUnitUI();

        fillDefaultKeyPickupAddress(
          true
        );

        if (result?.auto_scheduled) {
          const windowText =
            formatScheduledWindow(
              result
            );

          const refText =
            result?.job_ref
              ? ` Job reference: ${result.job_ref}.`
              : "";

          setRequestMessage(
            `Vacant unit scheduled automatically for ${windowText}.${refText}`,
            "success"
          );
        } else if (
          result?.email_sent === false
        ) {
          setRequestMessage(
            "Request created, but the tenant scheduling email did not send. The request is saved in the job list so it can be followed up on.",
            "error"
          );
        } else {
          setRequestMessage(
            "Request created. The tenant scheduling email was sent, and the request now appears in the job list.",
            "success"
          );
        }

        allJobs =
          await loadPmJobs();

        renderJobs();
        renderBillingSummary();

        window.scrollTo({
          top: 0,
          behavior: "smooth"
        });
      } catch (err) {
        console.error(err);

        setRequestMessage(
          err?.message ||
            "Could not create request.",
          "error"
        );

        newRequestMsg?.scrollIntoView({
          behavior: "smooth",
          block: "center"
        });
      } finally {
        if (createRequestBtn) {
          createRequestBtn.disabled =
            false;

          createRequestBtn.style.opacity =
            "1";
        }
      }
    }
  );
}

function wirePayBalanceButton() {
  payBalanceBtn?.addEventListener(
    "click",
    () => {
      alert(
        "PM Stripe billing is not connected yet."
      );
    }
  );
}

// ---------- Init ----------
async function main() {
  try {
    currentSession =
      await requireAuth();

    if (!currentSession) {
      return;
    }

    const user =
      currentSession.user;

    setText(
      whoami,
      user.email ||
        "Signed in"
    );

    const role =
      await loadProfileRole(
        user.id
      );

    if (
      role !== "property_manager"
    ) {
      await supabase.auth.signOut();

      alert(
        "Your account is not assigned to the property manager portal."
      );

      window.location.href =
        "/login.html";

      return;
    }

    currentPm =
      await loadPropertyManagerProfile();

    if (!currentPm) {
      setError(
        "No property manager account record was found for this login."
      );

      setText(
        pmCompanyName,
        "No PM account found"
      );

      return;
    }

    setText(
      pmCompanyName,
      currentPm.company_name ||
        "Property Manager Account"
    );

    const approvalSelect =
      newRequestForm?.querySelector(
        '[name="total_job_approval_limit_cents"]'
      );

    const defaultApproval =
      String(
        currentPm.default_job_approval_limit_cents ||
        ""
      );

    if (
      approvalSelect &&
      Array
        .from(approvalSelect.options)
        .some(
          (option) =>
            option.value ===
            defaultApproval
        )
    ) {
      approvalSelect.value =
        defaultApproval;
    }

    fillDefaultKeyPickupAddress();

    initPmAddressAutocomplete();

    wireFilters();
    wireSearch();
    wireNewRequestButton();
    wireVacantUnitForm();
    wireNewRequestForm();
    wirePayBalanceButton();

    allJobs =
      await loadPmJobs();

    renderJobs();
    renderBillingSummary();
  } catch (err) {
    console.error(err);

    setError(
      err?.message ||
      String(err)
    );
  }
}

main();
