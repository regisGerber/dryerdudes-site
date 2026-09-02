(() => {
  "use strict";

  function digitsOnly(value) {
    let digits = String(value || "").replace(/\D/g, "");

    if (digits.length === 11 && digits.startsWith("1")) {
      digits = digits.slice(1);
    }

    return digits.slice(0, 10);
  }

  function formatPhone(value) {
    const digits = digitsOnly(value);

    if (!digits) return "";
    if (digits.length < 3) return `(${digits}`;
    if (digits.length === 3) return `(${digits})`;
    if (digits.length <= 6) {
      return `(${digits.slice(0, 3)})-${digits.slice(3)}`;
    }

    return `(${digits.slice(0, 3)})-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  function wireInput(input) {
    if (!input || input.dataset.ddPhoneFormatting === "true") return;

    input.dataset.ddPhoneFormatting = "true";
    input.inputMode = "numeric";
    input.autocomplete = input.autocomplete || "tel";
    input.maxLength = 14;

    const apply = () => {
      const formatted = formatPhone(input.value);
      if (input.value !== formatted) input.value = formatted;
    };

    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
    input.addEventListener("blur", apply);

    apply();
  }

  function init(root = document) {
    root
      .querySelectorAll(
        'input[type="tel"], input[data-phone-format], input[name="phone"], input[name="tenant_phone"]'
      )
      .forEach(wireInput);
  }

  window.DryerDudesPhoneFormat = { formatPhone, init };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init(), { once: true });
  } else {
    init();
  }
})();
