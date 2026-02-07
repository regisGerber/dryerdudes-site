// script.js (FULL REPLACEMENT)

// ===== Helpers =====
const $ = (sel) => document.querySelector(sel);

function setBtnLoading(btn, isLoading, loadingText, normalText) {
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

// Friendly label builder
function formatOption(opt) {
  const dateLabel = opt.dateLabel || opt.date || "Scheduled date";
  const windowLabel =
    opt.arrivalWindowLabel ||
    (opt.arrivalStart && opt.arrivalEnd ? `${opt.arrivalStart}–${opt.arrivalEnd}` : "Arrival window");

  const priceLabel = opt.priceCents != null ? money(opt.priceCents) : null;

  return {
    title: `${dateLabel} — ${windowLabel}`,
    sub: priceLabel ? `Total today: ${priceLabel}` : `Arrival window`,
  };
}

// ===== Booking flow =====
document.addEventListener("DOMContentLoaded", () => {
  const form = $("#bookingForm");
  if (!form) return;

  const btn = $("#bookingSubmitBtn");
  const successMsg = $("#bookingSuccessMsg");

  const optionsWrap = $("#optionsWrap");
  const optionsList = $("#optionsList");
  const payBtn = $("#payBtn");

  const noOneHomeExpand = $("#noOneHomeExpand");

  // checkbox-style (exclusive)
  const homeAdult = $("#home_adult");
  const homeNoOne = $("#home_noone");
  const choiceAdult = $("#choiceAdult");
  const choiceNoOne = $("#choiceNoOne");

  // THIS is the hidden required field in your HTML
  const homeChoiceRequired = $("#home_choice_required");

  // contact method affects required phone/email
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

  // State we keep after options come back
  let lastRequestToken = null;
  let lastOptions = [];
  let selectedOption = null;

  function markSelectedCards() {
    if (choiceAdult) choiceAdult.classList.toggle("dd-selected", !!(homeAdult && homeAdult.checked));
    if (choiceNoOne) choiceNoOne.classList.toggle("dd-selected", !!(homeNoOne && homeNoOne.checked));
  }

  function setHomeChoiceRequiredValue() {
    if (!homeChoiceRequired) return;
    if (homeNoOne && homeNoOne.checked) homeChoiceRequired.value = "no_one_home";
    else if (homeAdult && homeAdult.checked) homeChoiceRequired.value = "adult_home";
    else homeChoiceRequired.value = "";
  }

  function applyNoOneHomeState(isNoOneHome) {
    // Expand/collapse section
    if (noOneHomeExpand) {
      if (isNoOneHome) noOneHomeExpand.classList.remove("dd-hidden");
      else noOneHomeExpand.classList.add("dd-hidden");
    }

    // Required permissions only when no-one-home selected
    const agreeNames = ["agree_entry","agree_video","agree_video_delete","agree_parts_hold","agree_pets"];
    agreeNames.forEach((n) => {
      const el = document.querySelector(`input[name="${n}"]`);
      setRequired(el, isNoOneHome);
    });

    setRequired(nohEntry, isNoOneHome);
    setRequired(nohDryerLoc, isNoOneHome);
    setRequired(nohBreakerLoc, false);

    // Button label
    if (btn) btn.textContent = isNoOneHome ? nohBtnText : normalBtnText;

    markSelectedCards();
    setHomeChoiceRequiredValue();

    if (isNoOneHome) {
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
    } else {
      // none selected
      if (homeAdult) homeAdult.checked = false;
      if (homeNoOne) homeNoOne.checked = false;
      applyNoOneHomeState(false);
      setHomeChoiceRequiredValue();
      markSelectedCards();
    }
  }

  // Card click (don’t prevent default; just control state)
  if (choiceAdult) {
    choiceAdult.addEventListener("click", (e) => {
      // If they clicked the checkbox itself, let the change handler run
      if (e.target && e.target.tagName === "INPUT") return;
      enforceExclusiveHome("adult");
    });
  }
  if (choiceNoOne) {
    choiceNoOne.addEventListener("click", (e) => {
      if (e.target && e.target.tagName === "INPUT") return;
      enforceExclusiveHome("noone");
    });
  }

  // Direct checkbox click should enforce exclusivity (allow uncheck -> none selected)
  if (homeAdult) {
    homeAdult.addEventListener("change", () => {
      if (homeAdult.checked) {
        if (homeNoOne) homeNoOne.checked = false;
        applyNoOneHomeState(false);
      } else {
        // allow none selected
        applyNoOneHomeState(false);
        setHomeChoiceRequiredValue();
        markSelectedCards();
      }
    });
  }

  if (homeNoOne) {
    homeNoOne.addEventListener("change", () => {
      if (homeNoOne.checked) {
        if (homeAdult) homeAdult.checked = false;
        applyNoOneHomeState(true);
      } else {
        // allow none selected
        applyNoOneHomeState(false);
        setHomeChoiceRequiredValue();
        markSelectedCards();
      }
    });
  }

  // Contact method → required fields
  function applyContactRequired() {
    const method = document.querySelector('input[name="contact_method"]:checked')?.value || "";

    const needsPhone = method === "text" || method === "both";
    const needsEmail = method === "email" || method === "both";

    setRequired(phoneInput, needsPhone);
    setRequired(emailInput, needsEmail);

    if (phoneReqStar) phoneReqStar.classList.toggle("dd-hidden", !needsPhone);
    if (emailReqStar) emailReqStar.classList.toggle("dd-hidden", !needsEmail);
  }

  document.querySelectorAll('input[name="contact_method"]').forEach((r) => {
    r.addEventListener("change", applyContactRequired);
  });

  // Initial states
  applyContactRequired();
  applyNoOneHomeState(readHomeChoice() === "no_one_home");
  setHomeChoiceRequiredValue();
  markSelectedCards();

  function showOptionsUI(options) {
    lastOptions = Array.isArray(options) ? options : [];
    selectedOption = null;
    if (!optionsWrap || !optionsList || !payBtn) return;

    optionsList.innerHTML = "";
    payBtn.disabled = true;

    lastOptions.forEach((opt, idx) => {
      const fmt = formatOption(opt);

      const el = document.createElement("div");
      el.className = "dd-option";
      el.dataset.idx = String(idx);

      el.innerHTML = `
        <div class="dd-option-title">${fmt.title}</div>
        <div class="dd-option-sub">${fmt.sub}</div>
      `;

      el.addEventListener("click", () => {
        optionsList.querySelectorAll(".dd-option").forEach((x) => x.classList.remove("dd-selected"));
        el.classList.add("dd-selected");
        selectedOption = opt;
        payBtn.disabled = false;

        const priceCents = opt.priceCents != null ? opt.priceCents : null;
        if (priceCents != null) payBtn.textContent = `Continue to payment (${money(priceCents)})`;
        else payBtn.textContent = "Continue to payment";
      });

      optionsList.appendChild(el);
    });

    optionsWrap.classList.remove("dd-hidden");
    scrollIntoViewNice(optionsWrap);
  }

  async function startCheckout() {
    if (!selectedOption) return;

    const slotId = selectedOption.slotId;
    if (!slotId) {
      alert("Missing slot selection. Please try again.");
      return;
    }
    if (!lastRequestToken) {
      alert("Missing request token. Please re-submit the form.");
      return;
    }

    setBtnLoading(payBtn, true, "Starting checkout…", "Continue to payment");

    try {
      const resp = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: lastRequestToken,
          slotId,
          fullService: !!document.querySelector("#full_service")?.checked,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok || !data?.url) {
        throw new Error(data?.message || data?.error || `Checkout failed (${resp.status})`);
      }

      window.location.href = data.url;
    } catch (err) {
      console.error(err);
      alert("Could not start checkout. Please try again.");
    } finally {
      setBtnLoading(payBtn, false, "Starting checkout…", "Continue to payment");
    }
  }

  if (payBtn) payBtn.addEventListener("click", startCheckout);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (successMsg) successMsg.classList.add("hide");
    if (optionsWrap) optionsWrap.classList.add("dd-hidden");

    // IMPORTANT: keep hidden required field in sync right before validation
    setHomeChoiceRequiredValue();

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

    payload.full_service = !!fd.get("full_service");
    payload.home = home;

    // remove checkbox-style home fields
    delete payload.home_adult;
    delete payload.home_noone;

    // remove hidden validator field (not needed server-side)
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
  if (!resp.ok) {
  const txt = data?.message || data?.error || JSON.stringify(data) || `Request failed (${resp.status})`;
  throw new Error(txt);
}


      lastRequestToken = data?.token || null;

      if (successMsg) {
        successMsg.classList.remove("hide");
        successMsg.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      if (Array.isArray(data?.options) && data.options.length) {
        showOptionsUI(data.options);
      }
        catch (err) {
  const msg = err?.message || String(err);
  alert("Request failed: " + msg);
  console.error(err);
    } finally {
      setBtnLoading(btn, false, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);
    }
  });
});
