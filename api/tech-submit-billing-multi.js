const originalHandler = require("./tech-submit-billing");

function isTruthy(value) {
  return (
    value === true ||
    value === "true" ||
    value === "1" ||
    value === 1 ||
    value === "yes" ||
    value === "on"
  );
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function parseParts(raw) {
  if (Array.isArray(raw)) return raw;

  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeParts(rawParts) {
  const source = parseParts(rawParts).slice(0, 12);
  const normalized = [];

  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index] || {};
    const description = String(raw.description || "").trim().slice(0, 120);
    const quantity = Number(raw.quantity || 0);
    const unitCostDollars = Number(raw.unit_cost || 0);
    const hasAnyValue = description || quantity || unitCostDollars;

    if (!hasAnyValue) continue;

    if (!description) {
      const error = new Error(`Enter a description for part ${index + 1}.`);
      error.statusCode = 400;
      throw error;
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      const error = new Error(`Enter a valid quantity for part ${index + 1}.`);
      error.statusCode = 400;
      throw error;
    }

    if (!Number.isFinite(unitCostDollars) || unitCostDollars <= 0) {
      const error = new Error(`Enter a valid unit cost for part ${index + 1}.`);
      error.statusCode = 400;
      throw error;
    }

    const unitCostCents = Math.round(unitCostDollars * 100);
    const lineTotalCents = unitCostCents * quantity;

    normalized.push({
      description,
      quantity,
      unit_cost_cents: unitCostCents,
      line_total_cents: lineTotalCents,
    });
  }

  return normalized;
}

function formatPartsSummary(parts) {
  const lines = parts.map((part) => {
    return `${part.description}: ${part.quantity} × ${money(part.unit_cost_cents)} = ${money(part.line_total_cents)}`;
  });

  const total = parts.reduce((sum, part) => sum + part.line_total_cents, 0);
  return `Parts on this bill — ${lines.join("; ")}. Parts total: ${money(total)}.`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return originalHandler(req, res);
  }

  try {
    const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
    const noPartsNeeded = isTruthy(body.no_parts_needed);
    const parts = normalizeParts(body.parts);

    if (noPartsNeeded && parts.length) {
      return res.status(400).json({
        ok: false,
        error: "Remove the part entries or uncheck “No parts needed.”",
      });
    }

    if (!noPartsNeeded && parts.length) {
      const totalCents = parts.reduce(
        (sum, part) => sum + part.line_total_cents,
        0
      );

      if (totalCents < 1 || totalCents > 9999999) {
        return res.status(400).json({
          ok: false,
          error: "The parts total is not valid.",
        });
      }

      const itemizedSummary = formatPartsSummary(parts);
      body.parts_cost = (totalCents / 100).toFixed(2);
      body.tech_notes = [itemizedSummary, String(body.tech_notes || "").trim()]
        .filter(Boolean)
        .join(" ");

      if (isTruthy(body.parts_on_order)) {
        body.parts_order_notes = [
          itemizedSummary,
          String(body.parts_order_notes || "").trim(),
        ]
          .filter(Boolean)
          .join(" | ");

        body.part_tracking_notes = body.parts_order_notes;
      }

      body.parts = parts;
    }

    req.body = body;
    return originalHandler(req, res);
  } catch (error) {
    return res.status(error?.statusCode || 400).json({
      ok: false,
      error: error?.message || "The parts list is not valid.",
    });
  }
};
