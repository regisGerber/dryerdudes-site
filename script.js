// script.js (FULL REPLACEMENT) — v7
// Fixes: home choice bug (radios), clean on-page options (3 + “view more” 2),
// still emails via backend, text later (plug-in ready).

// ===== Helpers =====
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

// Convert "2026-02-10" => "Mon, Feb 10"
function formatDateFriendly(isoDate) {
  const s = String(isoDate || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Convert "09:00:00" / "09:00" => "9:00 AM"
function formatTime12h(t) {
  if (!t) return "";
  const raw = String(t).slice(0, 5); // HH:MM
  const m = raw.match(/^(\d{2}):(\d{2})$/);
  if (!m) return raw;
  let hh = Number(m[1]);
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${mm} ${ampm}`;
}

// Build a clean label from common backend shapes
function buildOptionLabel(opt) {
  // Your backend may send either:
  // - { service_date, start_time, end_time, window_label }
  // - OR cleaned fields (dateLabel, arrivalWindowLabel)
  const dateLabel = opt.dateLabel || formatDateFriendly(opt.service_date || opt.date || "");
  const windowLabel =
    opt.arrivalWindowLabel ||
    opt.window_label ||
    (() => {
      const start = formatTime12h(opt.start_time || opt.arrival_start || "");
      const end = formatTime12h(opt.end_time || opt.arrival_end || "");
      return (start && end) ? `${start}–${end}` : "Arrival window";
    })();

  return { dateLabel, windowLabel };
}

// Normalize offers from various response shapes into a standard list.
// We prefer offer_token if present; otherwise slotId; otherwise keep object.
function normalizeOffers(arr) {
  const list = Array.isArray(arr) ? arr : [];
  return list.map((x) => ({
    raw: x,
    offerToken: x.offer_token || x.offerToken || null,
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

  // home radios
  const choiceAdult = $("#choiceAdult");
  const choiceNoOne = $("#choiceNoOne");

  // contact method (email-only for now)
  const phoneInput = document.querySelector('input[name="phone"]');
  const emailInput = document.querySelector('input[name="email"]');
  const phoneReqStar = $("#phoneReqStar");
  const emailReqStar = $("#emailReqStar");

  // No-one-home fields
  const nohEntry = document.querySelector('textarea[name="noh_entry_instructions"]');
  const nohDryerLoc = document.querySelector('input[name="noh_dryer_location"]');
  const nohBreakerLoc = document.querySelector('input[name="noh_breaker_location"]');

  const normalBtnText = "Request appointment options";
  const nohBtnText = "Authorize & Get Appointment Options";

  let selectedCheckoutTokenOrSlot = null;
  let cachedMoreOffers = [];
  let lastResponseRequestId = null;

  function readHomeChoice() {
    return document.querySelector('input[name="home"]:checked')?.value || "";
  }

  function markSelectedCards() {
    const home = readHomeChoice();
    if (choiceAdult) choiceAdult.classList.toggle("dd-selected", home === "adult_home");
    if (choiceNoOne) choiceNoOne.classList.toggle("dd-selected", home === "no_one_home");
  }

  function applyNoOneHomeState(isNoOneHome) {
    if (noOneHomeExpand) {
      noOneHomeExpand.classList.toggle("dd-hidden", !isNoOneHome);
    }

    const agreeNames = ["agree_entry","agree_video","agree_video_delete","agree_parts_hold","agree_pets"];
    agreeNames.forEach((n) => {
      const el = document.querySelector(`input[name="${n}"]`);
      setRequired(el, isNoOneHome);
    });

    setRequired(nohEntry, isNoOneHome);
    setRequired(nohDryerLoc, isNoOneHome);
    setRequired(nohBreakerLoc, false);

    if (btn) btn.textContent = isNoOneHome ? nohBtnText : normalBtnText;

    markSelectedCards();

    if (isNoOneHome && noOneHomeExpand) {
      setTimeout(() => scrollIntoViewNice(noOneHomeExpand), 80);
    }
  }

  // Force email-only for now (text later; plug-in ready)
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
    cachedMoreOffers = [];
    lastResponseRequestId = null;

    if (optionsList) optionsList.innerHTML = "";
    if (moreList) moreList.innerHTML = "";
    if (moreWrap) moreWrap.classList.add("dd-hidden");
    if (viewMoreBtn) viewMoreBtn.classList.add("dd-hidden");
    if (gentleReminder) gentleReminder.classList.add("dd-hidden");

    if (payBtn) {
      payBtn.disabled = true;
      payBtn.textContent = "Continue to payment";
    }
    if (optionsWrap) optionsWrap.classList.add("dd-hidden");
  }

  function getDisplayedPriceCents() {
    const full = !!document.querySelector("#full_service")?.checked;
    // Your stated pricing logic (adjust if needed)
    return full ? 10000 : 8000;
  }

  function renderOfferCard(offerObj, idx, container) {
    const priceCents = getDisplayedPriceCents();
    const opt = offerObj.raw;

    const { dateLabel, windowLabel } = buildOptionLabel(opt);

    const el = document.createElement("div");
    el.className = "dd-option";

    el.innerHTML = `
      <div class="dd-option-title">Option ${idx + 1}: ${safeText(dateLabel)} — ${safeText(windowLabel)}</div>
      <div class="dd-option-sub">Pay today: ${safeText(money(priceCents))}</div>
    `;

    el.addEventListener("click", () => {
      // clear selections across both lists
      document.querySelectorAll(".dd-option").forEach((x) => x.classList.remove("dd-selected"));
      el.classList.add("dd-selected");

      // Prefer offer token if you’re using tokenized checkout flow; fallback to slotId if later needed
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

    clearOptionsUI();

    const primaryNorm = normalizeOffers(primaryOffers).slice(0, 3);
    const moreNorm = normalizeOffers(moreOffers).slice(0, 2);

    primaryNorm.forEach((o, i) => renderOfferCard(o, i, optionsList));

    cachedMoreOffers = moreNorm;

    if (moreNorm.length && viewMoreBtn) {
      viewMoreBtn.classList.remove("dd-hidden");
    }

    // Gentle reminder only if they did NOT choose authorized entry
    const home = readHomeChoice();
    if (gentleReminder) {
      gentleReminder.classList.toggle("dd-hidden", home === "no_one_home");
    }

    optionsWrap.classList.remove("dd-hidden");
    scrollIntoViewNice(optionsWrap);
  }

  function revealMoreOptions() {
    if (!moreWrap || !moreList) return;
    if (!cachedMoreOffers.length) return;

    moreList.innerHTML = "";
    cachedMoreOffers.forEach((o, i) => renderOfferCard(o, i, moreList));

    moreWrap.classList.remove("dd-hidden");
    if (viewMoreBtn) viewMoreBtn.classList.add("dd-hidden");

    scrollIntoViewNice(moreWrap);
  }

  async function startCheckout() {
    if (!selectedCheckoutTokenOrSlot) return;

    // If you’re using tokenized links (offer_token) in checkout.html:
    // /checkout.html?token=...
    // If you later switch to slotId + request token, you can adjust here.
    const token = selectedCheckoutTokenOrSlot;
    window.location.href = `/checkout.html?token=${encodeURIComponent(token)}`;
  }

  // Home selection change
  document.querySelectorAll('input[name="home"]').forEach((r) => {
    r.addEventListener("change", () => {
      applyNoOneHomeState(readHomeChoice() === "no_one_home");
      markSelectedCards();
    });
  });

  if (viewMoreBtn) viewMoreBtn.addEventListener("click", revealMoreOptions);
  if (payBtn) payBtn.addEventListener("click", startCheckout);

  // Init
  forceEmailOnly();
  applyNoOneHomeState(readHomeChoice() === "no_one_home");
  markSelectedCards();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (successMsg) successMsg.classList.add("hide");
    clearOptionsUI();

    const ok = form.checkValidity();
    if (!ok) {
      form.reportValidity();
      return;
    }

    const home = readHomeChoice();
    if (!home) {
      alert("Please choose visit flexibility.");
      return;
    }

    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());

    // Email-only for now (text later)
    payload.contact_method = "email";

    // Canonical fields
    payload.full_service = !!fd.get("full_service");
    payload.home = home;

    // Nest authorized entry details if selected
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

    // Remove raw noh_ keys so API doesn’t get duplicates
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
        // surface server error if provided
        throw new Error(data?.message || data?.error || `Request failed (${resp.status})`);
      }

      // Show confirmation
      if (successMsg) {
        successMsg.classList.remove("hide");
        successMsg.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      // Support both response shapes:
      // (A) { primary:[...], more:{ options:[...] } }
      // (B) { options:[...] } (older)
      const primary = Array.isArray(data?.primary) ? data.primary : (Array.isArray(data?.options) ? data.options : []);
      const more = Array.isArray(data?.more?.options) ? data.more.options : [];

      lastResponseRequestId = data?.request_id || data?.requestId || null;

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
