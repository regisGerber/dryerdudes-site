(() => {
  "use strict";

  const MAX_PARTS = 12;
  const originalFetch = window.fetch.bind(window);
  let rowsContainer = null;
  let totalText = null;
  let addPartButton = null;
  let legacyPartsCost = null;
  let noPartsNeeded = null;
  let billingForm = null;
  let billingMessage = null;

  function money(value) {
    const amount = Number(value || 0);
    return amount.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
    });
  }

  function cleanDescription(value) {
    return String(value || "").trim().slice(0, 120);
  }

  function rowValues(row) {
    return {
      description: cleanDescription(row.querySelector('[data-part-description]')?.value),
      quantity: Number(row.querySelector('[data-part-quantity]')?.value || 0),
      unit_cost: Number(row.querySelector('[data-part-unit-cost]')?.value || 0),
    };
  }

  function allRows() {
    return Array.from(rowsContainer?.querySelectorAll("[data-part-row]") || []);
  }

  function enteredParts() {
    return allRows()
      .map(rowValues)
      .filter((part) => part.description || part.quantity || part.unit_cost);
  }

  function totalDollars(parts = enteredParts()) {
    return parts.reduce((sum, part) => {
      const quantity = Number.isFinite(part.quantity) ? part.quantity : 0;
      const unitCost = Number.isFinite(part.unit_cost) ? part.unit_cost : 0;
      return sum + quantity * unitCost;
    }, 0);
  }

  function updateLineTotal(row) {
    const part = rowValues(row);
    const lineTotal =
      Number.isFinite(part.quantity) && Number.isFinite(part.unit_cost)
        ? Math.max(0, part.quantity) * Math.max(0, part.unit_cost)
        : 0;

    const target = row.querySelector("[data-part-line-total]");
    if (target) target.textContent = money(lineTotal);
  }

  function updateTotals() {
    allRows().forEach(updateLineTotal);

    const total = totalDollars();
    if (totalText) totalText.textContent = `Parts total: ${money(total)}`;

    if (legacyPartsCost) {
      legacyPartsCost.value = total > 0 ? total.toFixed(2) : "";
      legacyPartsCost.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const disabled = !!noPartsNeeded?.checked;
    allRows().forEach((row) => {
      row.querySelectorAll("input, button").forEach((control) => {
        control.disabled = disabled;
      });
    });

    if (addPartButton) {
      addPartButton.disabled = disabled || allRows().length >= MAX_PARTS;
    }
  }

  function createPartRow(values = {}) {
    const row = document.createElement("div");
    row.className = "dd-part-row";
    row.dataset.partRow = "true";

    row.innerHTML = `
      <div class="dd-part-description">
        <label>Part description</label>
        <input
          type="text"
          maxlength="120"
          placeholder="Example: Heating element"
          data-part-description
        />
      </div>
      <div>
        <label>Qty</label>
        <input
          type="number"
          min="1"
          max="99"
          step="1"
          value="1"
          inputmode="numeric"
          data-part-quantity
        />
      </div>
      <div>
        <label>Unit cost</label>
        <input
          type="number"
          min="0.01"
          max="9999.99"
          step="0.01"
          placeholder="0.00"
          inputmode="decimal"
          data-part-unit-cost
        />
      </div>
      <div class="dd-part-line-total-wrap">
        <label>Line total</label>
        <div class="dd-part-line-total" data-part-line-total>$0.00</div>
      </div>
      <button type="button" class="dd-remove-part" data-remove-part aria-label="Remove this part">
        Remove
      </button>
    `;

    row.querySelector("[data-part-description]").value = values.description || "";
    row.querySelector("[data-part-quantity]").value = values.quantity || 1;
    row.querySelector("[data-part-unit-cost]").value = values.unit_cost || "";

    row.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", updateTotals);
      input.addEventListener("change", updateTotals);
    });

    row.querySelector("[data-remove-part]").addEventListener("click", () => {
      if (allRows().length <= 1) {
        row.querySelectorAll("input").forEach((input) => {
          input.value = input.hasAttribute("data-part-quantity") ? "1" : "";
        });
      } else {
        row.remove();
      }
      updateTotals();
    });

    return row;
  }

  function resetRows() {
    if (!rowsContainer) return;
    rowsContainer.innerHTML = "";
    rowsContainer.appendChild(createPartRow());
    updateTotals();
  }

  function setBillingError(message) {
    if (billingMessage) billingMessage.textContent = message || "";
  }

  function validateParts() {
    if (noPartsNeeded?.checked) return "";

    const parts = enteredParts();
    if (!parts.length) {
      return "Add at least one part, or choose “No parts needed.”";
    }

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part.description) return `Enter a description for part ${index + 1}.`;
      if (!Number.isInteger(part.quantity) || part.quantity < 1 || part.quantity > 99) {
        return `Enter a valid quantity for part ${index + 1}.`;
      }
      if (!Number.isFinite(part.unit_cost) || part.unit_cost <= 0) {
        return `Enter a valid unit cost for part ${index + 1}.`;
      }
    }

    return "";
  }

  function installFetchWrapper() {
    window.fetch = async function dryerDudesPartsFetch(input, init = {}) {
      const url = typeof input === "string" ? input : String(input?.url || "");
      const method = String(init?.method || "GET").toUpperCase();

      if (method === "POST" && /\/api\/tech-submit-billing(?:\?.*)?$/.test(url)) {
        let body = {};
        try {
          body = typeof init.body === "string" ? JSON.parse(init.body) : { ...(init.body || {}) };
        } catch {
          body = {};
        }

        const parts = noPartsNeeded?.checked ? [] : enteredParts();
        body.parts = parts;
        body.parts_cost = totalDollars(parts).toFixed(2);

        const nextUrl = url.replace(
          /\/api\/tech-submit-billing(?=\?|$)/,
          "/api/tech-submit-billing-multi"
        );

        return originalFetch(nextUrl, {
          ...init,
          body: JSON.stringify(body),
        });
      }

      return originalFetch(input, init);
    };
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .dd-multi-parts-panel {
        grid-column: 1 / -1;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 14px;
        padding: 12px;
        background: rgba(255,255,255,.035);
      }
      .dd-multi-parts-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }
      .dd-part-row {
        display: grid;
        grid-template-columns: minmax(190px, 1fr) 80px 120px 110px auto;
        gap: 8px;
        align-items: end;
        padding: 10px 0;
        border-top: 1px solid rgba(255,255,255,.10);
      }
      .dd-part-row:first-child { border-top: 0; padding-top: 0; }
      .dd-part-row label { display: block; margin-bottom: 6px; }
      .dd-part-line-total {
        min-height: 44px;
        display: flex;
        align-items: center;
        font-weight: 900;
      }
      .dd-remove-part {
        min-height: 44px;
        border: 1px solid rgba(255,134,178,.35);
        border-radius: 12px;
        background: rgba(255,80,120,.10);
        color: #ffd6e5;
        font-weight: 800;
        cursor: pointer;
        padding: 8px 10px;
      }
      .dd-parts-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      .dd-add-part {
        border: 1px solid rgba(48,230,207,.30);
        border-radius: 12px;
        background: rgba(48,230,207,.08);
        color: rgba(255,255,255,.94);
        font-weight: 900;
        cursor: pointer;
        padding: 10px 12px;
      }
      .dd-parts-total { font-weight: 900; }
      @media (max-width: 760px) {
        .dd-part-row { grid-template-columns: 1fr 82px 1fr; }
        .dd-part-description { grid-column: 1 / -1; }
        .dd-part-line-total-wrap { grid-column: 1 / 3; }
        .dd-remove-part { grid-column: 3; }
      }
    `;
    document.head.appendChild(style);
  }

  function init() {
    billingForm = document.getElementById("billingForm");
    legacyPartsCost = document.getElementById("partsCost");
    noPartsNeeded = document.getElementById("noPartsNeeded");
    billingMessage = document.getElementById("billingMsg");

    if (!billingForm || !legacyPartsCost || legacyPartsCost.dataset.multiPartsReady === "true") {
      return;
    }

    legacyPartsCost.dataset.multiPartsReady = "true";
    installFetchWrapper();
    injectStyles();

    const legacyField = legacyPartsCost.closest(".field");
    if (!legacyField) return;

    legacyPartsCost.type = "hidden";
    legacyField.style.display = "none";

    const panel = document.createElement("div");
    panel.className = "dd-multi-parts-panel";
    panel.innerHTML = `
      <div class="dd-multi-parts-heading">
        <div>
          <div style="font-weight:900;">Parts on this bill</div>
          <div class="tiny">Add each part separately. Quantity and unit cost are totaled automatically.</div>
        </div>
      </div>
      <div data-parts-rows></div>
      <div class="dd-parts-footer">
        <button type="button" class="dd-add-part" data-add-part>Add another part</button>
        <div class="dd-parts-total" data-parts-total>Parts total: $0.00</div>
      </div>
    `;

    legacyField.insertAdjacentElement("beforebegin", panel);
    rowsContainer = panel.querySelector("[data-parts-rows]");
    totalText = panel.querySelector("[data-parts-total]");
    addPartButton = panel.querySelector("[data-add-part]");

    addPartButton.addEventListener("click", () => {
      if (allRows().length >= MAX_PARTS) return;
      const row = createPartRow();
      rowsContainer.appendChild(row);
      row.querySelector("[data-part-description]")?.focus();
      updateTotals();
    });

    noPartsNeeded?.addEventListener("change", updateTotals);

    billingForm.addEventListener(
      "submit",
      (event) => {
        const error = validateParts();
        if (!error) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        setBillingError(error);
      },
      true
    );

    billingForm.addEventListener("reset", () => {
      window.setTimeout(resetRows, 0);
    });

    resetRows();
  }

  window.DryerDudesMultiParts = {
    init,
    enteredParts,
    validateParts,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
