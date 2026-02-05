// /api/request-appointment-options.js
// Alias route so the frontend can POST to /api/request-appointment-options
// while we reuse your existing /api/request-times.js logic.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const b = req.body || {};

    // Frontend field names (from index.html / script.js)
    const contact_method = String(b.contact_method || "text").toLowerCase();
    const name = String(b.customer_name || b.name || "").trim();
    const phone = String(b.phone || "").trim();
    const email = String(b.email || "").trim();

    // Build a clean single-line address string (your request-times expects `address`)
    const address_line1 = String(b.address_line1 || "").trim();
    const city = String(b.city || "").trim();
    const state = String(b.state || "").trim();
    const zip = String(b.zip || "").trim();

    const addressParts = [address_line1, city, state, zip].filter(Boolean);
    const address = addressParts.join(", ");

    // Appointment type mapping:
    // - no-one-home if home === "no_one_home"
    // - full_service if checkbox selected
    // - otherwise standard
    const home = String(b.home || "").trim(); // "adult_home" | "no_one_home"
    const fullServiceRaw = b.full_service;

    // full_service can arrive as "on" or "true" or true
    const full_service =
      fullServiceRaw === true ||
      fullServiceRaw === "true" ||
      fullServiceRaw === "on" ||
      fullServiceRaw === 1 ||
      fullServiceRaw === "1";

    let appointment_type = "standard";
    if (home === "no_one_home") appointment_type = "no_one_home";
    else if (full_service) appointment_type = "full_service";

    // Minimal validation (your /api/request-times will validate too)
    if (!address) return res.status(400).json({ error: "address is required" });
    if ((contact_method === "text" || contact_method === "both") && !phone) {
      return res.status(400).json({ error: "phone is required for text/both" });
    }
    if ((contact_method === "email" || contact_method === "both") && !email) {
      return res.status(400).json({ error: "email is required for email/both" });
    }

    // Forward into your existing handler
    const origin = `https://${req.headers.host}`;

    const forwardResp = await fetch(`${origin}/api/request-times`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },

      // request-times expects: { name, phone, email, contact_method, address, appointment_type }
      body: JSON.stringify({
        name,
        phone,
        email,
        contact_method,
        address,
        appointment_type,

        // Optional: keep extra fields around for future expansion
        // (request-times currently ignores these, but you may later store them)
        entry_instructions: b.entry_instructions || "",
        dryer_symptoms: b.dryer_symptoms || "",
        home,
        no_one_home: b.no_one_home || null,
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
