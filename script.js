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

// Friendly label builder (prevents “dat weird” + removes internal slot letters)
function formatOption(opt) {
  // Expect backend to return already-clean fields when possible:
  // opt.dateLabel, opt.arrivalStartLabel, opt.arrivalEndLabel, opt.arrivalWindowLabel
  // Fallback to raw fields if needed.
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

    if (isNoOneHome) {
      setTimeout(() => scrollIntoViewNice(noOneHomeExpand), 80);
    }
  }

  function readHomeChoice() {
    // exactly one should be checked
    if (homeNoOne && homeNoOne.checked) return "no_one_home";
    if (homeAdult && homeAdult.checked) return "adult_home";
    return "";
  }

  function enforceExclusiveHome(clicked) {
    // checkbox-style but exclusive
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

  // Card click
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

  // Direct checkbox click should also enforce exclusivity
  if (homeAdult) {
    homeAdult.addEventListener("change", () => {
      if (homeAdult.checked) enforceExclusiveHome("adult");
      else {
        // don’t allow “none selected” once they started; keep it checked
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

  // Contact method → required fields
  function applyContactRequired() {
    const method = document.querySelector('input[name="contact_method"]:checked')?.value || "";

    const needsPhone = method === "text" || method === "both";
    const needsEmail = method === "email" || method === "both";

    setRequired(phoneInput, needsPhone);
    setRequired(emailInput, needsEmail);

    // stars
    if (phoneReqStar) phoneReqStar.classList.toggle("dd-hidden", !needsPhone);
    if (emailReqStar) emailReqStar.classList.toggle("dd-hidden", !needsEmail);
  }

  document.querySelectorAll('input[name="contact_method"]').forEach((r) => {
    r.addEventListener("change", applyContactRequired);
  });

  // Initial states
  applyNoOneHomeState(readHomeChoice() === "no_one_home");
  applyContactRequired();

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

        // Update button label to reflect Full Service total
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

    // We expect backend to give us:
    // selectedOption.slotId (internal)
    // selectedOption.priceCents (8000 or 10000)
    // and we will pass those into checkout session creation.
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
          // backend should compute amount from slotId + full_service in stored request,
          // but we can include for safety too:
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

    // Normalize booleans + canonical fields
    payload.full_service = !!fd.get("full_service");
    payload.home = home;

    // IMPORTANT: remove the checkbox-style home fields
    delete payload.home_adult;
    delete payload.home_noone;

    // Nest no-one-home details if selected
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

    // Make sure address fields are present (these drive zone selection)
    // payload.address_line1, payload.city, payload.state, payload.zip already exist from the form

    setBtnLoading(btn, true, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);

    try {
      const resp = await fetch("/api/request-appointment-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const txt = data?.message || data?.error || `Request failed (${resp.status})`;
        throw new Error(txt);
      }

      // Expected backend response shape:
      // {
      //   ok: true,
      //   token: "abc123",
      //   options: [
      //     { slotId:"...", dateLabel:"Mon Feb 10", arrivalWindowLabel:"10am–12pm", priceCents:8000 }
      //   ]
      // }
      lastRequestToken = data?.token || null;

      if (successMsg) {
        successMsg.classList.remove("hide");
        successMsg.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      if (Array.isArray(data?.options) && data.options.length) {
        showOptionsUI(data.options);
      } else {
        // Keep your original promise: “you’ll receive a text/email shortly…”
        // If your backend still sends options by Twilio/Resend instead of returning them,
        // this is fine.
      }

    } catch (err) {
      alert("Something went wrong. Please try again.");
      console.error(err);
    } finally {
      setBtnLoading(btn, false, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);
    }
  });
});
