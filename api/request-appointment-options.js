// /api/request-appointment-options.js
// Alias route so the frontend can POST to /api/request-appointment-options
// while we reuse your existing /api/request-times.js logic.

function isTruthy(v) {
  return v === true || v === "true" || v === "on" || v === 1 || v === "1";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
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

    // HOME CHOICE (accept multiple variants for robustness)
    // Priority:
    // 1) explicit home/home_choice_required string
    // 2) checkbox booleans
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
      return res.status(400).json({ error: "Choose only one: adult_home OR no_one_home" });
    }
    if (!home) {
      return res.status(400).json({ error: "home choice is required" });
    }

    const full_service = isTruthy(b.full_service);

    // appointment type mapping
    let appointment_type = "standard";
    if (home === "no_one_home") appointment_type = "no_one_home";
    else if (full_service) appointment_type = "full_service";

    // Minimal validation
    if (!address) return res.status(400).json({ error: "address is required" });

    if ((contact_method === "text" || contact_method === "both") && !phone) {
      return res.status(400).json({ error: "phone is required for text/both" });
    }
    if ((contact_method === "email" || contact_method === "both") && !email) {
      return res.status(400).json({ error: "email is required for email/both" });
    }

    // Forward into your existing handler
    const origin = process.env.SITE_ORIGIN || `https://${req.headers.host}`;

    const forwardResp = await fetch(`${origin}/api/request-times`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        phone,
        email,
        contact_method,
        address,
        appointment_type,

        // Optional extras (safe for future use)
        entry_instructions: b.entry_instructions || "",
        dryer_symptoms: b.dryer_symptoms || "",
        home,
        no_one_home: b.no_one_home || null,
        full_service,
      }),
    });

    const data = await forwardResp.json().catch(() => ({}));
    return res.status(forwardResp.status).json(data);

  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
