// script.js (FULL REPLACEMENT)

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

// Convert "2026-02-10" => "2/10/2026"
function formatDateMDY(isoDate) {
  const s = String(isoDate || "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return `${mo}/${d}/${y}`;
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

// Friendly option label (no internal slot letters)
function buildOptionLabel(opt) {
  const date = formatDateMDY(opt.service_date || opt.date || "");
  const start = formatTime12h(opt.start_time || opt.arrival_start || "");
  const end = formatTime12h(opt.end_time || opt.arrival_end || "");

  const windowStr = (start && end) ? `${start} – ${end}` : "Arrival window";
  return `${date} • ${windowStr}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const form = $("#bookingForm");
  if (!form) return;

  const btn = $("#bookingSubmitBtn");
  const successMsg = $("#bookingSuccessMsg");

  const optionsWrap = $("#optionsWrap");
  const optionsList = $("#optionsList");
  const payBtn = $("#payBtn");

  const noOneHomeExpand = $("#noOneHomeExpand");

  // checkbox-style but exclusive
  const homeAdult = $("#home_adult");
  const homeNoOne = $("#home_noone");
  const choiceAdult = $("#choiceAdult");
  const choiceNoOne = $("#choiceNoOne");

  // Contact method: we’re forcing email while text is disabled
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

  let selectedOfferToken = null;

  function markSelectedCards() {
    if (choiceAdult) choiceAdult.classList.toggle("dd-selected", !!(homeAdult && homeAdult.checked));
    if (choiceNoOne) choiceNoOne.classList.toggle("dd-selected", !!(homeNoOne && homeNoOne.checked));
  }

  function applyNoOneHomeState(isNoOneHome) {
    if (noOneHomeExpand) {
      if (isNoOneHome) noOneHomeExpand.classList.remove("dd-hidden");
      else noOneHomeExpand.classList.add("dd-hidden");
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

  function readHomeChoice() {
    if (homeNoOne && homeNoOne.checked) return "no_one_home";
    if (homeAdult && homeAdult.checked) return "adult_home";
    return "";
  }

  function enforceExclusiveHome(clicked) {
    if (clicked === "adult") {
      if (homeAdult) homeAdult.checked = true;
      if (homeNoOne) homeNoOne.checked = false;
      applyNoOneHomeState(false);
    } else if (clicked === "noone") {
      if (homeNoOne) homeNoOne.checked = true;
      if (homeAdult) homeAdult.checked = false;
      applyNoOneHomeState(true);
    }
  }

  // Card click (prevents double-checkbox weirdness)
  if (choiceAdult) {
    choiceAdult.addEventListener("click", (e) => {
      e.preventDefault();
      enforceExclusiveHome("adult");
    });
  }
  if (choiceNoOne) {
    choiceNoOne.addEventListener("click", (e) => {
      e.preventDefault();
      enforceExclusiveHome("noone");
    });
  }

  // Direct checkbox click also enforced
  if (homeAdult) {
    homeAdult.addEventListener("change", () => {
      if (homeAdult.checked) enforceExclusiveHome("adult");
      else {
        homeAdult.checked = true;
        enforceExclusiveHome("adult");
      }
    });
  }
  if (homeNoOne) {
    homeNoOne.addEventListener("change", () => {
      if (homeNoOne.checked) enforceExclusiveHome("noone");
      else {
        homeNoOne.checked = true;
        enforceExclusiveHome("noone");
      }
    });
  }

  // Force email-only for now
  function forceEmailOnly() {
    // Always require email, never require phone (for now).
    setRequired(emailInput, true);
    setRequired(phoneInput, false);

    if (emailReqStar) emailReqStar.classList.remove("dd-hidden");
    if (phoneReqStar) phoneReqStar.classList.add("dd-hidden");

    // Ensure the checked radio is "email" even if something cached
    const emailRadio = document.querySelector('input[name="contact_method"][value="email"]');
    if (emailRadio) emailRadio.checked = true;
  }

  // Initial states
  applyNoOneHomeState(readHomeChoice() === "no_one_home");
  forceEmailOnly();

  function clearOptionsUI() {
    selectedOfferToken = null;
    if (optionsList) optionsList.innerHTML = "";
    if (payBtn) {
      payBtn.disabled = true;
      payBtn.textContent = "Continue to payment";
    }
    if (optionsWrap) optionsWrap.classList.add("dd-hidden");
  }

  function showOptionsUI(primaryOffers) {
    if (!optionsWrap || !optionsList || !payBtn) return;

    optionsList.innerHTML = "";
    payBtn.disabled = true;
    selectedOfferToken = null;

    primaryOffers.forEach((offer, idx) => {
      const label = buildOptionLabel(offer);

      const el = document.createElement("div");
      el.className = "dd-option";
      el.dataset.idx = String(idx);

      // Show price hint based on full service choice (since backend doesn’t return pricing here)
      const full = !!document.querySelector("#full_service")?.checked;
      const priceCents = full ? 10000 : 8000;

      el.innerHTML = `
        <div class="dd-option-title">Option ${idx + 1}: ${safeText(label)}</div>
        <div class="dd-option-sub">Arrival window • Pay today: ${safeText(money(priceCents))}</div>
      `;

      el.addEventListener("click", () => {
        optionsList.querySelectorAll(".dd-option").forEach((x) => x.classList.remove("dd-selected"));
        el.classList.add("dd-selected");
        selectedOfferToken = offer.offer_token;
        payBtn.disabled = false;

        payBtn.textContent = `Continue to payment (${money(priceCents)})`;
      });

      optionsList.appendChild(el);
    });

    optionsWrap.classList.remove("dd-hidden");
    scrollIntoViewNice(optionsWrap);
  }

  async function startCheckout() {
    if (!selectedOfferToken) return;
    // Keep it simple: your checkout.html already knows how to take a token and start Stripe
    window.location.href = `/checkout.html?token=${encodeURIComponent(selectedOfferToken)}`;
  }

  if (payBtn) payBtn.addEventListener("click", startCheckout);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (successMsg) successMsg.classList.add("hide");
    clearOptionsUI();

    // Browser validation
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

    // Collect payload
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());

    // Force email-only while Twilio is dark
    payload.contact_method = "email";

    // Normalize booleans + canonical fields
    payload.full_service = !!fd.get("full_service");
    payload.home = home;

    // Remove checkbox-style home fields if they exist
    delete payload.home_adult;
    delete payload.home_noone;
    delete payload.home_choice_required;

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

      // Confirmation message (still true, because we ALSO email it)
      if (successMsg) {
        successMsg.classList.remove("hide");
        successMsg.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      // Show the 3 options on-screen (clean UI)
      const primary = Array.isArray(data?.primary) ? data.primary : [];
      if (primary.length) {
        showOptionsUI(primary.slice(0, 3));
      } else {
        // If no primary, still show a friendly note
        alert("No appointment options available right now. Please try again soon.");
      }

    } catch (err) {
      console.error(err);
      alert("Something went wrong. Please try again.");
    } finally {
      setBtnLoading(btn, false, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);
    }
  });
});
