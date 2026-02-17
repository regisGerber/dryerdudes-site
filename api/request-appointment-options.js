// /api/request-appointment-options.js
// Frontend POSTs here; we forward to /api/request-times and return its response.
// This wrapper normalizes responses to { ok: true/false, ... } and preserves upstream errors.

function isTruthy(v) {
  return v === true || v === "true" || v === "on" || v === 1 || v === "1";
}

function getOrigin(req) {
  const host = req?.headers?.host;
  // If you're behind Vercel, host will be correct.
  // Prefer explicit SITE_ORIGIN only if it looks valid.
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;
  return `https://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const b = req.body || {};

    const contact_method = String(b.contact_method || "email").toLowerCase();
    const name = String(b.customer_name || b.name || "").trim();
    const phone = String(b.phone || "").trim();
    const email = String(b.email || "").trim();

    const address_line1 = String(b.address_line1 || "").trim();
    const city = String(b.city || "").trim();
    const state = String(b.state || "").trim();
    const zip = String(b.zip || "").trim();

    const addressParts = [address_line1, city, state, zip].filter(Boolean);
    const address = addressParts.join(", ");

    // HOME CHOICE (accept multiple variants)
    let home = String(b.home_choice_required || b.home || "").trim();

    const homeAdult = isTruthy(b.home_adult);
    const homeNoOne = isTruthy(b.home_noone);

    if (!home) {
      home = homeNoOne ? "no_one_home" : homeAdult ? "adult_home" : "";
    }

    // normalize
    if (home === "adult_home" || home === "adult") home = "adult_home";
    if (home === "no_one_home" || home === "noone" || home === "authorized") home = "no_one_home";

    // enforce exactly one
    if (homeAdult && homeNoOne) {
      return res.status(400).json({ ok: false, error: "Choose only one: adult_home OR no_one_home" });
    }
    if (!home) {
      return res.status(400).json({ ok: false, error: "home choice is required" });
    }

    const full_service = isTruthy(b.full_service);

    // appointment type mapping
    let appointment_type = "standard";
    if (home === "no_one_home") appointment_type = "no_one_home";
    else if (full_service) appointment_type = "full_service";

    // Minimal validation
    if (!address) return res.status(400).json({ ok: false, error: "address is required" });

    if ((contact_method === "text" || contact_method === "both") && !phone) {
      return res.status(400).json({ ok: false, error: "phone is required for text/both" });
    }
    if ((contact_method === "email" || contact_method === "both") && !email) {
      return res.status(400).json({ ok: false, error: "email is required for email/both" });
    }

    const origin = getOrigin(req);

    const forwardPayload = {
      name,
      phone,
      email,
      contact_method,
      address,
      appointment_type,

      // Optional extras
      entry_instructions: b.entry_instructions || "",
      dryer_symptoms: b.dryer_symptoms || "",
      home,
      no_one_home: b.no_one_home || null,
      full_service,
    };

    const forwardUrl = `${origin}/api/request-times`;

    const forwardResp = await fetch(forwardUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardPayload),
    });

    // Read as text first so we can return raw error bodies if JSON parsing fails
    const text = await forwardResp.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { ok: false, error: "Upstream returned non-JSON", raw: text };
    }

    // Normalize: if upstream doesn't include ok, infer it from status
    if (typeof data?.ok !== "boolean") {
      data.ok = forwardResp.ok;
    }

    // If upstream failed, include its body so we can see the real error source
    if (!forwardResp.ok || !data.ok) {
      return res.status(forwardResp.status || 500).json({
        ok: false,
        error: data?.error || data?.message || `Upstream request-times failed (${forwardResp.status})`,
        upstream: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
