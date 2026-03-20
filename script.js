// script.js — Dryer Dudes v11 (stable)

const $ = (sel) => document.querySelector(sel);

function setBtnLoading(btn, isLoading, loadingText, normalText) {
  if (!btn) return;
  btn.disabled = isLoading;
  btn.style.opacity = isLoading ? "0.75" : "1";
  btn.textContent = isLoading ? loadingText : normalText;
}

function setRequired(el, required) {
  if (!el) return;
  if (required) el.setAttribute("required", "required");
  else el.removeAttribute("required");
}

function scrollIntoViewNice(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function money(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function safeText(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;"
  }[c]));
}

function formatDateFriendly(isoDate) {
  const s = String(isoDate || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatTime12h(t) {
  if (!t) return "";
  const raw = String(t).slice(0, 5);
  const m = raw.match(/^(\d{2}):(\d{2})$/);
  if (!m) return raw;
  let hh = Number(m[1]);
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${mm} ${ampm}`;
}

function buildOptionLabel(opt) {
  const dateLabel = opt.dateLabel || formatDateFriendly(opt.service_date || opt.date || "");

  const start = opt.start_time || opt.arrival_start || "";
  const end = opt.end_time || opt.arrival_end || "";

  let windowLabel = "";
  if (start && end) {
    windowLabel = `${formatTime12h(start)}–${formatTime12h(end)}`;
  } else if (opt.window_label) {
    windowLabel = String(opt.window_label);
  } else {
    windowLabel = "Arrival window";
  }

  return { dateLabel, windowLabel };
}

function normalizeOffers(arr) {
  const list = Array.isArray(arr) ? arr : [];
  return list.map((x) => ({
    raw: x,
    offerToken: x.offer_token || x.offerToken || x.token || null,
    slotId: x.slotId || x.slot_id || null,
  }));
}

// --------------------------------------------------
// Google address autocomplete
// --------------------------------------------------

let addressWasSelectedFromAutocomplete = false;

function initAddressAutocomplete() {

  const addressInput = document.getElementById("addressInput");
  const cityInput = document.getElementById("cityInput");
  const stateInput = document.getElementById("stateInput");
  const zipInput = document.getElementById("zipInput");

  if (!addressInput) return;

  // If Google fails, DO NOT break form
  if (!window.google || !google.maps || !google.maps.places) {
    console.warn("Google Places failed — falling back to manual entry");

    addressInput.disabled = false;
    addressInput.placeholder = "Enter your address manually";

    return;
  }

  const autocomplete = new google.maps.places.Autocomplete(addressInput, {
    types: ["address"],
    componentRestrictions: { country: "us" },
    fields: ["address_components", "geometry", "formatted_address", "name"]
  });

  const southernOregonBounds = new google.maps.LatLngBounds(
    { lat: 41.8, lng: -124.0 },
    { lat: 43.5, lng: -121.0 }
  );

  autocomplete.setBounds(southernOregonBounds);
  autocomplete.setOptions({
    strictBounds: false
  });

  autocomplete.addListener("place_changed", () => {

    const place = autocomplete.getPlace();

    if (!place.address_components) return;

    addressWasSelectedFromAutocomplete = true;

    let streetNumber = "";
    let route = "";

    cityInput.value = "";
    stateInput.value = "";
    zipInput.value = "";

    place.address_components.forEach((component) => {
      const types = component.types || [];

      if (types.includes("street_number")) {
        streetNumber = component.long_name;
      }

      if (types.includes("route")) {
        route = component.long_name;
      }

      if (types.includes("locality")) {
        cityInput.value = component.long_name;
      }

      if (types.includes("administrative_area_level_1")) {
        stateInput.value = component.short_name;
      }

      if (types.includes("postal_code")) {
        zipInput.value = component.long_name;
      }
    });

    if (streetNumber && route) {
      addressInput.value = `${streetNumber} ${route}`;
    }
  });

  addressInput.addEventListener("input", () => {
    addressWasSelectedFromAutocomplete = false;
  });
}

window.initAddressAutocomplete = initAddressAutocomplete;

  // --------------------------------------------------
  // If user edits after selecting → force reselect
  // --------------------------------------------------
  addressInput.addEventListener("input", () => {
    addressWasSelectedFromAutocomplete = false;
  });

document.addEventListener("DOMContentLoaded", () => {

  const form = $("#bookingForm");
  if (!form) return;

  const btn = $("#bookingSubmitBtn");
  const successMsg = $("#bookingSuccessMsg");

  const optionsWrap = $("#optionsWrap");
  const optionsList = $("#optionsList");
  const moreWrap = $("#moreWrap");
  const moreList = $("#moreList");
  const viewMoreBtn = $("#viewMoreBtn");
  const payBtn = $("#payBtn");

  const noOneHomeExpand = $("#noOneHomeExpand");

  const choiceAdult = $("#choiceAdult");
  const choiceNoOne = $("#choiceNoOne");

  const homeChoiceHidden = $("#home_choice_required");

  const phoneInput = document.querySelector('input[name="phone"]');
  const emailInput = document.querySelector('input[name="email"]');
  const phoneReqStar = $("#phoneReqStar");
  const emailReqStar = $("#emailReqStar");

  const smsConsentWrap = $("#smsConsentWrap");
  const smsConsentInput = $("#sms_consent");

  const aboutToggle = $("#aboutToggle");
  const howToggle = $("#howToggle");
  const howGrid = $("#howGrid");

  const nohEntry = document.querySelector('textarea[name="noh_entry_instructions"]');
  const nohDryerLoc = document.querySelector('input[name="noh_dryer_location"]');

  const normalBtnText = "Request appointment options";
  const nohBtnText = "Authorize & Get Appointment Options";

  let selectedCheckoutTokenOrSlot = null;

  let cachedRequestId = null;
  let cachedPrimaryOffers = [];
  let cachedMoreOffers = [];
  let moreEmailAlreadySent = false;

  function getSelectedContactMethod() {
    const checked = document.querySelector('input[name="contact_method"]:checked');
    return checked ? checked.value : "both";
  }

  function updateContactMethodUI() {

    const method = getSelectedContactMethod();

    const phoneRequired = method === "text" || method === "both";
    const emailRequired = method === "email" || method === "both";

    setRequired(phoneInput, phoneRequired);
    setRequired(emailInput, emailRequired);

    if (phoneReqStar) phoneReqStar.classList.toggle("dd-hidden", !phoneRequired);
    if (emailReqStar) emailReqStar.classList.toggle("dd-hidden", !emailRequired);

    const smsNeeded = method === "text" || method === "both";

    setRequired(smsConsentInput, smsNeeded);

    if (smsConsentWrap) smsConsentWrap.classList.toggle("dd-hidden", !smsNeeded);

  }

  function getHomeInputs() {

    const adult =
      choiceAdult?.querySelector('input[type="radio"]') ||
      document.querySelector('input[name="home"][value="adult_home"]');

    const noOne =
      choiceNoOne?.querySelector('input[type="radio"]') ||
      document.querySelector('input[name="home"][value="no_one_home"]');

    return { adult, noOne };

  }

  function readHomeChoice() {
    const { adult, noOne } = getHomeInputs();
    if (noOne?.checked) return "no_one_home";
    if (adult?.checked) return "adult_home";
    return "";
  }

  function syncHiddenHomeChoice() {
    if (!homeChoiceHidden) return;
    homeChoiceHidden.value = readHomeChoice() || "";
  }

  function markSelectedCards() {
    const home = readHomeChoice();
    if (choiceAdult) choiceAdult.classList.toggle("dd-selected", home === "adult_home");
    if (choiceNoOne) choiceNoOne.classList.toggle("dd-selected", home === "no_one_home");
  }

  function applyNoOneHomeState(isNoOneHome) {

    if (noOneHomeExpand)
      noOneHomeExpand.classList.toggle("dd-hidden", !isNoOneHome);

    const agreeNames = [
      "agree_entry",
      "agree_video",
      "agree_video_delete",
      "agree_parts_hold",
      "agree_pets"
    ];

    agreeNames.forEach((n) => {
      setRequired(document.querySelector(`input[name="${n}"]`), isNoOneHome);
    });

    setRequired(nohEntry, isNoOneHome);
    setRequired(nohDryerLoc, isNoOneHome);

    if (btn)
      btn.textContent = isNoOneHome ? nohBtnText : normalBtnText;

  }

  function clearOptionsUI() {

    selectedCheckoutTokenOrSlot = null;

    cachedRequestId = null;
    cachedPrimaryOffers = [];
    cachedMoreOffers = [];

    moreEmailAlreadySent = false;

    if (optionsList) optionsList.innerHTML = "";
    if (moreList) moreList.innerHTML = "";

    if (moreWrap) moreWrap.classList.add("dd-hidden");

    if (viewMoreBtn) {
      viewMoreBtn.disabled = true;
      viewMoreBtn.classList.add("dd-hidden");
      viewMoreBtn.textContent = "View more options";
    }

    if (payBtn) {
      payBtn.disabled = true;
      payBtn.textContent = "Continue to payment";
    }

    if (optionsWrap)
      optionsWrap.classList.add("dd-hidden");

  }

  function renderOfferCard(offerObj, idx, container, labelPrefix) {

    const priceCents = document.querySelector("#full_service")?.checked ? 10000 : 8000;

    const opt = offerObj.raw;

    const { dateLabel, windowLabel } = buildOptionLabel(opt);

    const el = document.createElement("div");

    el.className = "dd-option";

    el.innerHTML = `
      <div class="dd-option-title">
      ${safeText(labelPrefix)} ${idx + 1}: ${safeText(dateLabel)} — ${safeText(windowLabel)}
      </div>
      <div class="dd-option-sub">
      Arrival window • Pay today: ${safeText(money(priceCents))}
      </div>
    `;

    el.addEventListener("click", () => {

      document.querySelectorAll(".dd-option")
        .forEach((x) => x.classList.remove("dd-selected"));

      el.classList.add("dd-selected");

      const prompt = $("#optionSelectPrompt");
if (prompt) prompt.classList.add("dd-hidden");


      selectedCheckoutTokenOrSlot =
        offerObj.offerToken || offerObj.slotId || null;

      if (payBtn) {

        payBtn.disabled = !selectedCheckoutTokenOrSlot;

        payBtn.textContent = selectedCheckoutTokenOrSlot
          ? `Continue to payment (${money(priceCents)})`
          : "Continue to payment";

      }

    });

    container.appendChild(el);

  }

  function showOptionsUI(primaryOffers, moreOffers) {

    if (!optionsWrap || !optionsList) return;

    optionsList.innerHTML = "";
    moreList.innerHTML = "";

    const primaryNorm = normalizeOffers(primaryOffers).slice(0, 3);
    const moreNorm = normalizeOffers(moreOffers).slice(0, 2);

    cachedPrimaryOffers = primaryNorm;
    cachedMoreOffers = moreNorm;

    primaryNorm.forEach((o, i) =>
      renderOfferCard(o, i, optionsList, "Option")
    );

    if (viewMoreBtn) {

      if (moreNorm.length) {

        viewMoreBtn.disabled = false;
        viewMoreBtn.classList.remove("dd-hidden");

      } else {

        viewMoreBtn.disabled = true;
        viewMoreBtn.classList.add("dd-hidden");

      }

    }

    optionsWrap.classList.remove("dd-hidden");

    scrollIntoViewNice(optionsWrap);

  }

  async function maybeSendMoreOptionsEmail() {

    if (moreEmailAlreadySent) return;

    if (!cachedRequestId) return;

    const email = (emailInput?.value || "").trim();

    if (!email) return;

    moreEmailAlreadySent = true;

    try {

      const payload = {
        request_id: cachedRequestId,
        email
      };

     console.log("REQUEST PAYLOAD", payload);

const resp = await fetch("/api/send-more-options-email", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});


      const data = await resp.json().catch(() => ({}));

      if (resp.ok && data?.ok) {

        if (viewMoreBtn)
          viewMoreBtn.textContent = "Now viewing all options";

      }

    } catch (err) {

      console.warn("send-more-options-email error", err);

    }

  }

  async function revealMoreOptions() {

    if (!cachedMoreOffers.length) return;

    moreList.innerHTML = "";

    cachedMoreOffers.forEach((o, i) =>
      renderOfferCard(o, i, moreList, "Additional option")
    );

    moreWrap.classList.remove("dd-hidden");

    if (viewMoreBtn)
      viewMoreBtn.disabled = true;

    await maybeSendMoreOptionsEmail();

    scrollIntoViewNice(moreWrap);
}

  function startCheckout() {
    const prompt = $("#optionSelectPrompt");

    if (!selectedCheckoutTokenOrSlot) {
      if (prompt) {
        prompt.classList.remove("dd-hidden");
        prompt.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      return;
    }

    if (prompt) prompt.classList.add("dd-hidden");

    const token = selectedCheckoutTokenOrSlot;
    window.location.href = `/checkout.html?token=${encodeURIComponent(token)}`;
  }

  function wireMobileAccordions() {

    if (aboutToggle) {
      aboutToggle.addEventListener("click", () => {
        const extras = document.querySelectorAll(".about-mobile-extra");
        const isOpening = Array.from(extras).some((el) => el.classList.contains("dd-hidden-mobile"));

        extras.forEach((el) => {
          el.classList.toggle("dd-hidden-mobile");
        });

        aboutToggle.textContent = isOpening
          ? "Show less"
          : "See more about Dryer Dudes";
      });
    }

    if (howToggle && howGrid) {
      howToggle.addEventListener("click", () => {
        const isHidden = howGrid.classList.contains("dd-hidden-mobile");

        howGrid.classList.toggle("dd-hidden-mobile");

        howToggle.textContent = isHidden
          ? "Show less"
          : "Click here for more information";
      });
    }

  }

  function wireHomeCards() {

    const { adult, noOne } = getHomeInputs();

    function onChange() {
      syncHiddenHomeChoice();
      applyNoOneHomeState(readHomeChoice() === "no_one_home");
      markSelectedCards();
    }

    adult?.addEventListener("change", onChange);
    noOne?.addEventListener("change", onChange);

    choiceAdult?.addEventListener("click", () => {
      if (!adult) return;
      adult.checked = true;
      adult.dispatchEvent(new Event("change", { bubbles: true }));
    });

    choiceNoOne?.addEventListener("click", () => {
      if (!noOne) return;
      noOne.checked = true;
      noOne.dispatchEvent(new Event("change", { bubbles: true }));
    });

}
document
  .querySelectorAll('input[name="contact_method"]')
  .forEach((r) => r.addEventListener("change", updateContactMethodUI));

if (viewMoreBtn) viewMoreBtn.addEventListener("click", revealMoreOptions);

if (payBtn) {
  payBtn.disabled = false;
  payBtn.addEventListener("click", startCheckout);
}

wireMobileAccordions();
wireHomeCards();
updateContactMethodUI();
initAddressAutocomplete();




syncHiddenHomeChoice();
applyNoOneHomeState(readHomeChoice() === "no_one_home");
markSelectedCards();

form.addEventListener("submit", async (e) => {

  e.preventDefault();

  clearOptionsUI();

  const prompt = $("#optionSelectPrompt");
  if (prompt) prompt.classList.add("dd-hidden");

const ok = form.checkValidity();

if (!ok) {
  form.reportValidity();
  return;
}

// ensure address came from autocomplete
const googleWorking = window.google && google.maps && google.maps.places;

if (googleWorking && !addressWasSelectedFromAutocomplete) {
 alert("Please select your address from the dropdown suggestions so we can verify service availability.");
  return;
}



  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());

  payload.contact_method = getSelectedContactMethod();
  payload.full_service = !!fd.get("full_service");
  payload.sms_consent = !!fd.get("sms_consent");

  setBtnLoading(btn, true, "Submitting…", normalBtnText);

  try {

    const resp = await fetch("/api/request-appointment-options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();

    // --------------------------------------------------
    // HANDLE INVALID ADDRESS FROM BACKEND
    // --------------------------------------------------

    if (!resp.ok) {

      const upstreamError =
        data?.upstream?.error ||
        data?.error ||
        "";

      const upstreamMessage =
        data?.upstream?.message ||
        data?.message ||
        "";

      if (
        upstreamError === "Invalid address" ||
        upstreamMessage.toLowerCase().includes("valid street address")
      ) {
        alert("Please enter a valid street address (example: 123 Main St).");
        return;
      }

      alert("We are not currently servicing this address.");
      return;
    }

    // --------------------------------------------------
    // NORMAL SUCCESS PATH
    // --------------------------------------------------

    cachedRequestId = data.request_id || data.requestId || null;

    const primary = data.primary || data.options || [];
    const more = data.more?.options || data.more || [];

    if (primary.length) {

      showOptionsUI(primary, more);

      if (successMsg) {
        successMsg.classList.remove("hide");
      }

      if (payBtn) {
        payBtn.disabled = false;
      }

    } else {

      alert(
        "We are not currently servicing this address. Please double-check that the address was entered correctly and try again."
      );

    }

  } catch (err) {

    console.error(err);
    alert("Something went wrong. Please try again.");

  } finally {

    setBtnLoading(btn, false, "Submitting…", normalBtnText);

  }

});

});

