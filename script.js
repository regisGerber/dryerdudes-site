// script.js — v9 (FULL REPLACEMENT)

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
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
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

/**
 * Build a clean label. Prefers real start/end times.
 * Falls back to window_label only if times not present.
 */
function buildOptionLabel(opt) {
  const dateLabel = opt.dateLabel || formatDateFriendly(opt.service_date || opt.date || "");

  const start = opt.start_time || opt.arrival_start || "";
  const end = opt.end_time || opt.arrival_end || "";

  let windowLabel = "";
  if (start && end) {
    windowLabel = `${formatTime12h(start)}–${formatTime12h(end)}`;
  } else if (opt.window_label) {
    windowLabel = String(opt.window_label); // fallback only
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
  const gentleReminder = $("#gentleReminder");
  const payBtn = $("#payBtn");

  const noOneHomeExpand = $("#noOneHomeExpand");

  const choiceAdult = $("#choiceAdult");
  const choiceNoOne = $("#choiceNoOne");

  const homeChoiceHidden = $("#home_choice_required");

  const phoneInput = document.querySelector('input[name="phone"]');
  const emailInput = document.querySelector('input[name="email"]');
  const phoneReqStar = $("#phoneReqStar");
  const emailReqStar = $("#emailReqStar");

  const nohEntry = document.querySelector('textarea[name="noh_entry_instructions"]');
  const nohDryerLoc = document.querySelector('input[name="noh_dryer_location"]');
  const nohBreakerLoc = document.querySelector('input[name="noh_breaker_location"]');

  const normalBtnText = "Request appointment options";
  const nohBtnText = "Authorize & Get Appointment Options";

  let selectedCheckoutTokenOrSlot = null;

  // NEW: caching for View More + Email #2 automation
  let cachedRequestId = null;
  let cachedPrimaryOffers = [];
  let cachedMoreOffers = [];
  let moreEmailAlreadySent = false;

  function readHomeChoice() {
    // Your current HTML uses checkbox ids: home_adult, home_noone
    const adult = document.getElementById("home_adult");
    const noOne = document.getElementById("home_noone");
    if (noOne && noOne.checked) return "no_one_home";
    if (adult && adult.checked) return "adult_home";
    return "";
  }

  const jumpLink = $("#jumpToAuthorizedEntry");
  if (jumpLink) {
    jumpLink.addEventListener("click", () => {
      const noOne = document.getElementById("home_noone");
      if (noOne) {
        noOne.checked = true;
        noOne.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  function syncHiddenHomeChoice() {
    if (!homeChoiceHidden) return;
    const home = readHomeChoice();
    homeChoiceHidden.value = home || "";
  }

  function markSelectedCards() {
    const home = readHomeChoice();
    if (choiceAdult) choiceAdult.classList.toggle("dd-selected", home === "adult_home");
    if (choiceNoOne) choiceNoOne.classList.toggle("dd-selected", home === "no_one_home");
  }

  function applyNoOneHomeState(isNoOneHome) {
    if (noOneHomeExpand) noOneHomeExpand.classList.toggle("dd-hidden", !isNoOneHome);

    const agreeNames = ["agree_entry","agree_video","agree_video_delete","agree_parts_hold","agree_pets"];
    agreeNames.forEach((n) => setRequired(document.querySelector(`input[name="${n}"]`), isNoOneHome));

    setRequired(nohEntry, isNoOneHome);
    setRequired(nohDryerLoc, isNoOneHome);
    setRequired(nohBreakerLoc, false);

    if (btn) btn.textContent = isNoOneHome ? nohBtnText : normalBtnText;

    syncHiddenHomeChoice();
    markSelectedCards();

    if (isNoOneHome && noOneHomeExpand) setTimeout(() => scrollIntoViewNice(noOneHomeExpand), 80);
  }

  function forceEmailOnly() {
    setRequired(emailInput, true);
    setRequired(phoneInput, false);

    if (emailReqStar) emailReqStar.classList.remove("dd-hidden");
    if (phoneReqStar) phoneReqStar.classList.add("dd-hidden");

    const emailRadio = document.querySelector('input[name="contact_method"][value="email"]');
    if (emailRadio) emailRadio.checked = true;
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

    if (gentleReminder) gentleReminder.classList.add("dd-hidden");

    if (payBtn) {
      payBtn.disabled = true;
      payBtn.textContent = "Continue to payment";
    }

    if (optionsWrap) optionsWrap.classList.add("dd-hidden");
  }

  function getDisplayedPriceCents() {
    const full = !!document.querySelector("#full_service")?.checked;
    return full ? 10000 : 8000;
  }

  function renderOfferCard(offerObj, idx, container, labelPrefix) {
    const priceCents = getDisplayedPriceCents();
    const opt = offerObj.raw;
    const { dateLabel, windowLabel } = buildOptionLabel(opt);

    const el = document.createElement("div");
    el.className = "dd-option";
    el.innerHTML = `
      <div class="dd-option-title">${safeText(labelPrefix)} ${idx + 1}: ${safeText(dateLabel)} — ${safeText(windowLabel)}</div>
      <div class="dd-option-sub">Arrival window • Pay today: ${safeText(money(priceCents))}</div>
    `;

    el.addEventListener("click", () => {
      document.querySelectorAll(".dd-option").forEach((x) => x.classList.remove("dd-selected"));
      el.classList.add("dd-selected");

      selectedCheckoutTokenOrSlot = offerObj.offerToken || offerObj.slotId || null;

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
    if (!optionsWrap || !optionsList || !payBtn) return;

    // don’t nuke cachedRequestId here — clearOptionsUI() is already called before submit
    if (optionsList) optionsList.innerHTML = "";
    if (moreList) moreList.innerHTML = "";

    if (moreWrap) moreWrap.classList.add("dd-hidden");
    if (gentleReminder) gentleReminder.classList.add("dd-hidden");

    const primaryNorm = normalizeOffers(primaryOffers).slice(0, 3);
    const moreNorm = normalizeOffers(moreOffers).slice(0, 2);

    // store for later
    cachedPrimaryOffers = primaryNorm;
    cachedMoreOffers = moreNorm;

    primaryNorm.forEach((o, i) => renderOfferCard(o, i, optionsList, "Option"));

    // View more button only if we actually have more offers
    if (viewMoreBtn) {
      if (moreNorm.length) {
        viewMoreBtn.disabled = false;
        viewMoreBtn.classList.remove("dd-hidden");
      } else {
        viewMoreBtn.disabled = true;
        viewMoreBtn.classList.add("dd-hidden");
      }
    }

    // Gentle reminder visible if they are NOT authorized entry
    const home = readHomeChoice();
    if (gentleReminder) gentleReminder.classList.toggle("dd-hidden", home === "no_one_home");

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
        email,
        customer_name: (document.querySelector('input[name="customer_name"]')?.value || "").trim(),
      };

      const resp = await fetch("/api/send-more-options-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        // Not fatal: they still see more options on screen
        console.warn("send-more-options-email failed", data);
      } else {
        if (viewMoreBtn) viewMoreBtn.textContent = "More options sent to your email ✓";
      }
    } catch (err) {
      console.warn("send-more-options-email error", err);
    }
  }

  async function revealMoreOptions() {
    if (!moreWrap || !moreList) return;
    if (!cachedMoreOffers.length) return;

    moreList.innerHTML = "";

    // These are framed as “Additional options”
    cachedMoreOffers.forEach((o, i) => renderOfferCard(o, i, moreList, "Additional option"));

    moreWrap.classList.remove("dd-hidden");
    if (viewMoreBtn) viewMoreBtn.disabled = true;

    // Trigger Email #2 automation (once)
    await maybeSendMoreOptionsEmail();

    scrollIntoViewNice(moreWrap);
  }

  function startCheckout() {
    if (!selectedCheckoutTokenOrSlot) return;
    const token = selectedCheckoutTokenOrSlot;
    window.location.href = `/checkout.html?token=${encodeURIComponent(token)}`;
  }

  // Wire the ACTUAL checkboxes you have in the HTML
  function wireHomeCheckboxes() {
    const adult = document.getElementById("home_adult");
    const noOne = document.getElementById("home_noone");

    if (adult) {
      adult.addEventListener("change", () => {
        // enforce exclusivity
        if (adult.checked && noOne) noOne.checked = false;
        syncHiddenHomeChoice();
        applyNoOneHomeState(readHomeChoice() === "no_one_home");
      });
    }

    if (noOne) {
      noOne.addEventListener("change", () => {
        // enforce exclusivity
        if (noOne.checked && adult) adult.checked = false;
        syncHiddenHomeChoice();
        applyNoOneHomeState(readHomeChoice() === "no_one_home");
      });
    }
  }

  if (viewMoreBtn) viewMoreBtn.addEventListener("click", revealMoreOptions);
  if (payBtn) payBtn.addEventListener("click", startCheckout);

  // Init
  forceEmailOnly();
  wireHomeCheckboxes();
  syncHiddenHomeChoice();
  applyNoOneHomeState(readHomeChoice() === "no_one_home");
  markSelectedCards();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (successMsg) successMsg.classList.add("hide");

    // Clear UI but DO NOT clear the form fields
    clearOptionsUI();

    syncHiddenHomeChoice();

    const ok = form.checkValidity();
    if (!ok) {
      form.reportValidity();
      return;
    }

    const home = readHomeChoice();
    if (!home) {
      alert("home choice is required");
      return;
    }

    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());

    // Email-only for now
    payload.contact_method = "email";

    // Back-compat: send ALL known variants so your deployed API can accept it
    payload.home = home;
    payload.home_choice_required = home; // your hidden required field
    payload.home_adult = home === "adult_home" ? "1" : "";
    payload.home_noone = home === "no_one_home" ? "1" : "";

    // Explicit full_service boolean (helps API)
    payload.full_service = !!fd.get("full_service");

    // Optional: align “appointment_type” if your API expects that name
    payload.appointment_type = fd.get("full_service") ? "full_service" : "standard";

    if (home === "no_one_home") {
      payload.no_one_home = {
        agree_entry: !!fd.get("agree_entry"),
        agree_video: !!fd.get("agree_video"),
        agree_video_delete: !!fd.get("agree_video_delete"),
        agree_parts_hold: !!fd.get("agree_parts_hold"),
        agree_pets: !!fd.get("agree_pets"),
        entry_instructions: String(fd.get("noh_entry_instructions") || ""),
        dryer_location: String(fd.get("noh_dryer_location") || ""),
        breaker_location: String(fd.get("noh_breaker_location") || ""),
      };
    }

    delete payload.noh_entry_instructions;
    delete payload.noh_dryer_location;
    delete payload.noh_breaker_location;

    setBtnLoading(btn, true, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);

    try {
      const resp = await fetch("/api/request-appointment-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || `Request failed (${resp.status})`);
      }

      // cache request id if your backend returns it (needed for Email #2)
      cachedRequestId = data.request_id || data.requestId || data.id || null;

      if (successMsg) {
        successMsg.classList.remove("hide");
        successMsg.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      const primary = Array.isArray(data?.primary)
        ? data.primary
        : (Array.isArray(data?.options) ? data.options : []);

      const more = Array.isArray(data?.more?.options)
        ? data.more.options
        : (Array.isArray(data?.more) ? data.more : []);

      if (primary.length) {
        showOptionsUI(primary.slice(0, 3), more.slice(0, 2));
      } else {
        alert("No appointment options available right now. Please try again soon.");
      }

    } catch (err) {
      console.error(err);
      alert(err?.message || "Something went wrong. Please try again.");
    } finally {
      setBtnLoading(btn, false, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);
    }
  });
});
