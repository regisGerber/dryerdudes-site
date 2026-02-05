// script.js (FULL REPLACEMENT — copy/paste this whole file)

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

// Make checkboxes truly required by attribute toggle
function setCheckboxRequired(name, required) {
  const el = document.querySelector(`input[name="${name}"]`);
  setRequired(el, required);
}

function scrollIntoViewNice(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ===== Booking flow =====
document.addEventListener("DOMContentLoaded", () => {
  const form = $("#bookingForm");
  if (!form) return;

  const btn = $("#bookingSubmitBtn");
  const successMsg = $("#bookingSuccessMsg");

  const noOneHomeExpand = $("#noOneHomeExpand");
  const homeAdult = $("#home_adult");
  const homeNoOne = $("#home_noone");

  // No-one-home fields
  const nohEntry = document.querySelector('textarea[name="noh_entry_instructions"]');
  const nohDryerLoc = document.querySelector('input[name="noh_dryer_location"]');

  const normalBtnText = "Request appointment options";
  const nohBtnText = "Authorize & Get Appointment Options";

  function applyNoOneHomeState(isNoOneHome) {
    // Expand/collapse
    if (isNoOneHome) noOneHomeExpand.classList.remove("dd-hidden");
    else noOneHomeExpand.classList.add("dd-hidden");

    // Toggle required fields only for no-one-home
    setCheckboxRequired("agree_entry", isNoOneHome);
    setCheckboxRequired("agree_video", isNoOneHome);
    setCheckboxRequired("agree_video_delete", isNoOneHome);
    setCheckboxRequired("agree_parts_hold", isNoOneHome);
    setCheckboxRequired("agree_pets", isNoOneHome);

    setRequired(nohEntry, isNoOneHome);
    setRequired(nohDryerLoc, isNoOneHome);

    // Button label
    btn.textContent = isNoOneHome ? nohBtnText : normalBtnText;

    if (isNoOneHome) {
      // Nudge the user down into the expanded area
      setTimeout(() => scrollIntoViewNice(noOneHomeExpand), 80);
    }
  }

  function readHomeChoice() {
    if (homeNoOne && homeNoOne.checked) return "no_one_home";
    if (homeAdult && homeAdult.checked) return "adult_home";
    return "";
  }

  // Wire radios
  if (homeAdult) homeAdult.addEventListener("change", () => applyNoOneHomeState(false));
  if (homeNoOne) homeNoOne.addEventListener("change", () => applyNoOneHomeState(true));

  // On load, respect any pre-selected value
  applyNoOneHomeState(readHomeChoice() === "no_one_home");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    successMsg.classList.add("hide");

    // Browser validation
    const ok = form.checkValidity();
    if (!ok) {
      form.reportValidity();
      return;
    }

    const home = readHomeChoice();

    // Collect base payload
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());

    // Normalize booleans
    payload.full_service = !!fd.get("full_service");

    // Normalize home
    payload.home = home;

    // If no-one-home, rename noh_ fields into a nested object (cleaner server side)
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

    // Remove the noh_ raw keys so your API doesn’t get duplicates
    delete payload.noh_entry_instructions;
    delete payload.noh_dryer_location;
    delete payload.noh_breaker_location;

    // IMPORTANT: you had entry_instructions already in the main form. Keep it.
    // If you want no-one-home to override it when filled, you can do that here:
    // if (home === "no_one_home" && payload.no_one_home.entry_instructions) payload.entry_instructions = payload.no_one_home.entry_instructions;

    setBtnLoading(btn, true, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);

    try {
      // TODO: Replace this endpoint with your real one.
      // This endpoint should:
      // 1) create the job / intake
      // 2) if no_one_home selected: store permissions + details
      // 3) trigger text/email with 3 appointment links
      //
      // Example expected response: { ok: true }
      const resp = await fetch("/api/request-appointment-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`Request failed (${resp.status}). ${txt}`.slice(0, 400));
      }

      successMsg.classList.remove("hide");
      successMsg.scrollIntoView({ behavior: "smooth", block: "center" });

      // Optional: you can reset the form after submit
      // form.reset();
      // applyNoOneHomeState(false);

    } catch (err) {
      alert("Something went wrong. Please try again.");
      console.error(err);
    } finally {
      setBtnLoading(btn, false, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);
    }
  });
});
