// script.js (FULL REPLACEMENT)

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

function setCheckboxRequired(idOrName, required) {
  const el = document.getElementById(idOrName) || document.querySelector(`input[name="${idOrName}"]`);
  setRequired(el, required);
}

function safeText(v) {
  return String(v ?? "").trim();
}

function buildAddress(fd) {
  const a1 = safeText(fd.get("address_line1"));
  const city = safeText(fd.get("city"));
  const state = safeText(fd.get("state"));
  const zip = safeText(fd.get("zip"));
  return [a1, `${city}, ${state} ${zip}`.trim()].filter(Boolean).join(", ");
}

function formatSlotLine(s) {
  const date = s?.service_date || "";
  const start = s?.start_time ? String(s.start_time).slice(0, 5) : "";
  const end = s?.end_time ? String(s.end_time).slice(0, 5) : "";
  const time = start && end ? `${start}–${end}` : (s?.slot_index != null ? `slot ${s.slot_index}` : "scheduled window");
  const label = s?.window_label ? ` (${s.window_label})` : "";
  return `${date} • ${time}${label}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const form = $("#bookingForm");
  if (!form) return;

  const btn = $("#bookingSubmitBtn");
  const successMsg = $("#bookingSuccessMsg");
  const debugWrap = $("#bookingDebugWrap");
  const debugList = $("#bookingDebugList");
  const debugNote = $("#bookingDebugNote");

  const noOneHomeExpand = $("#noOneHomeExpand");
  const homeAdult = $("#home_adult");
  const homeNoOne = $("#home_noone");

  const nohEntry = document.querySelector('textarea[name="noh_entry_instructions"]');
  const nohDryerLoc = document.querySelector('input[name="noh_dryer_location"]');

  const normalBtnText = "Request appointment options";
  const nohBtnText = "Authorize & Get Appointment Options";

  function applyNoOneHomeState(isNoOneHome) {
    if (noOneHomeExpand) {
      if (isNoOneHome) noOneHomeExpand.classList.remove("dd-hidden");
      else noOneHomeExpand.classList.add("dd-hidden");
    }

    setCheckboxRequired("agree_entry", isNoOneHome);
    setCheckboxRequired("agree_video", isNoOneHome);
    setCheckboxRequired("agree_video_delete", isNoOneHome);
    setCheckboxRequired("agree_parts_hold", isNoOneHome);
    setCheckboxRequired("agree_pets", isNoOneHome);

    setRequired(nohEntry, isNoOneHome);
    setRequired(nohDryerLoc, isNoOneHome);

    btn.textContent = isNoOneHome ? nohBtnText : normalBtnText;
  }

  function readHomeChoice() {
    if (homeNoOne && homeNoOne.checked) return "no_one_home";
    if (homeAdult && homeAdult.checked) return "adult_home";
    return "";
  }

  if (homeAdult) homeAdult.addEventListener("change", () => applyNoOneHomeState(false));
  if (homeNoOne) homeNoOne.addEventListener("change", () => applyNoOneHomeState(true));

  applyNoOneHomeState(readHomeChoice() === "no_one_home");

  function clearUi() {
    if (successMsg) successMsg.classList.add("hide");
    if (debugWrap) debugWrap.classList.add("hide");
    if (debugList) debugList.innerHTML = "";
    if (debugNote) debugNote.textContent = "";
  }

  function showDebugLinks(respJson) {
    if (!debugWrap || !debugList) return;
    const primary = Array.isArray(respJson?.primary) ? respJson.primary : [];
    if (!primary.length) {
      debugWrap.classList.remove("hide");
      debugNote.textContent = "No slots returned by the server right now.";
      return;
    }

    const origin = window.location.origin;
    debugList.innerHTML = "";

    primary.slice(0, 3).forEach((s, idx) => {
      const token = s.offer_token;
      const href = `${origin}/checkout.html?token=${encodeURIComponent(token)}`;
      const line = formatSlotLine(s);

      const item = document.createElement("div");
      item.className = "dd-debug-item";
      item.innerHTML = `
        <div class="dd-debug-title">Option ${idx + 1}: ${line}</div>
        <a class="dd-debug-link" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>
      `;
      debugList.appendChild(item);
    });

    debugWrap.classList.remove("hide");
    debugNote.textContent =
      "Testing mode: these links are shown on-screen. In production, customers receive these by text/email.";
  }

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    clearUi();

    // Must choose home option (radio required, but we enforce a clearer message)
    const home = readHomeChoice();
    if (!home) {
      alert("Please choose whether someone will be home, or if you want authorized entry.");
      return;
    }

    // Native validation
    const ok = form.checkValidity();
    if (!ok) {
      form.reportValidity();
      return;
    }

    const fd = new FormData(form);

    const payload = {
      name: safeText(fd.get("customer_name")),
      phone: safeText(fd.get("phone")),
      email: safeText(fd.get("email")),
      contact_method: safeText(fd.get("contact_method")) || "text",
      address: buildAddress(fd),
      appointment_type: "standard",
      entry_instructions: safeText(fd.get("entry_instructions")),
      dryer_symptoms: safeText(fd.get("dryer_symptoms")),
      full_service: !!fd.get("full_service"),
      home: home,
      no_one_home: null,
    };

    if (home === "no_one_home") {
      payload.appointment_type = "no_one_home";
      payload.no_one_home = {
        agree_entry: !!fd.get("agree_entry"),
        agree_video: !!fd.get("agree_video"),
        agree_video_delete: !!fd.get("agree_video_delete"),
        agree_parts_hold: !!fd.get("agree_parts_hold"),
        agree_pets: !!fd.get("agree_pets"),
        entry_instructions: safeText(fd.get("noh_entry_instructions")),
        dryer_location: safeText(fd.get("noh_dryer_location")),
        breaker_location: safeText(fd.get("noh_breaker_location")),
      };
    } else if (payload.full_service) {
      payload.appointment_type = "full_service";
    }

    setBtnLoading(btn, true, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);

    try {
      const resp = await fetch("/api/request-times", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await resp.json().catch(() => ({}));

      if (!resp.ok || !json.ok) {
        console.error("API error:", json);
        alert(json?.message || json?.error || "Something went wrong. Please try again.");
        return;
      }

      if (successMsg) successMsg.classList.remove("hide");
      showDebugLinks(json);

    } catch (err) {
      console.error(err);
      alert("Something went wrong. Please try again.");
    } finally {
      setBtnLoading(btn, false, "Submitting…", home === "no_one_home" ? nohBtnText : normalBtnText);
    }
  });
});
