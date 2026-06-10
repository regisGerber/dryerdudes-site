// /api/request-appointment-options.js
// CommonJS version for Vercel.
// Validates the public booking form, then forwards to /api/request-times.

function isTruthy(v) {
  return (
    v === true ||
    v === "true" ||
    v === "on" ||
    v === 1 ||
    v === "1" ||
    v === "yes"
  );
}

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "")
    .trim()
    .replace(/\/+$/, "");

  if (envOrigin && /^https?:\/\//i.test(envOrigin)) {
    return envOrigin;
  }

  const proto = String(req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();

  const host =
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req.headers.host || "").trim();

  return `${proto}://${host}`;
}

function makeReqId() {
  return `rao_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function readBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function cleanString(v) {
  return String(v || "").trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  const reqId = makeReqId();

  try {
    const b = readBody(req);

    const name = cleanString(b.customer_name || b.name);
    const phone = cleanString(b.phone);
    const email = cleanString(b.email);

    const addressLine1 = cleanString(b.address_line1);
    const city = cleanString(b.city);
    const state = cleanString(b.state);
    const zip = cleanString(b.zip);

    const addressParts = [addressLine1, city, state, zip].filter(Boolean);
    const address = addressParts.join(", ");

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Missing name",
        message: "Name is required.",
        reqId,
      });
    }

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone",
        message: "Mobile number is required.",
        reqId,
      });
    }

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "Missing email",
        message: "Email is required.",
        reqId,
      });
    }

    if (!isTruthy(b.sms_consent)) {
      return res.status(400).json({
        ok: false,
        error: "Missing SMS consent",
        message: "SMS consent is required to request appointment options.",
        reqId,
      });
    }

    if (!addressLine1) {
      return res.status(400).json({
        ok: false,
        error: "Invalid address",
        message: "Please select a valid street address from the address suggestions.",
        reqId,
      });
    }

    if (!city || !state || !zip) {
      return res.status(400).json({
        ok: false,
        error: "Incomplete address",
        message: "Please select the full address from the address suggestions.",
        reqId,
      });
    }

    const homeChoice = cleanString(b.home).toLowerCase();
    const hiddenHomeChoice = cleanString(b.home_choice_required).toLowerCase();

    const homeAdult =
      isTruthy(b.home_adult) ||
      homeChoice === "adult_home" ||
      hiddenHomeChoice === "adult_home";

    const homeNoOne =
      isTruthy(b.home_noone) ||
      homeChoice === "no_one_home" ||
      hiddenHomeChoice === "no_one_home";

    if (!homeAdult && !homeNoOne) {
      return res.status(400).json({
        ok: false,
        error: "Missing visit flexibility",
        message: "Please choose whether an adult will be home or authorized entry is needed.",
        reqId,
      });
    }

    /*
      Keep existing appointment_type behavior:
      - no_one_home when Authorized Entry is selected
      - full_service when Full Service was selected
      Extra access fields are also forwarded so /api/request-times can store tech-facing notes.
    */
    let appointmentType = "standard";

    if (homeNoOne) {
      appointmentType = "no_one_home";
    }

    if (isTruthy(b.full_service)) {
      appointmentType = "full_service";
    }

    const authorizedEntry = homeNoOne;

    const entryInstructions = cleanString(b.entry_instructions);

    const nohEntryInstructions = cleanString(
      b.noh_entry_instructions ||
      b.authorized_entry_instructions ||
      b.access_instructions
    );

    const nohDryerLocation = cleanString(
      b.noh_dryer_location ||
      b.dryer_location
    );

    const nohBreakerLocation = cleanString(
      b.noh_breaker_location ||
      b.breaker_location
    );

    const nohPetNotes = cleanString(
      b.noh_pet_notes ||
      b.pet_notes
    );

    const origin = getOrigin(req);

    const forwardPayload = {
      name,
      phone,
      email,

      // Email + text are required now.
      // Appointment option links are handled by email / on-page display.
      // Text is kept for confirmation, reminders, en route, billing, and follow-up.
      contact_method: "both",

      address,
      appointment_type: appointmentType,

      // Main booking details
      dryer_symptoms: cleanString(b.dryer_symptoms),
      sms_consent: true,
      full_service_requested: isTruthy(b.full_service),

      // Visit flexibility / Authorized Entry
      home_choice: authorizedEntry ? "no_one_home" : "adult_home",
      authorized_entry: authorizedEntry,

      // Standard entry/access instructions
      entry_instructions: entryInstructions,

      // Authorized Entry details for tech-facing notes
      noh_entry_instructions: nohEntryInstructions,
      noh_dryer_location: nohDryerLocation,
      noh_breaker_location: nohBreakerLocation,
      noh_pet_notes: nohPetNotes,

      // Alternate names too, in case downstream code checks these
      dryer_location: nohDryerLocation,
      breaker_location: nohBreakerLocation,
      pet_notes: nohPetNotes,

      // Permission acknowledgements
      agree_entry: isTruthy(b.agree_entry),
      agree_parts_hold: isTruthy(b.agree_parts_hold),
      agree_pets: isTruthy(b.agree_pets),
    };

    const forwardResp = await fetch(`${origin}/api/request-times`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(forwardPayload),
    });

    const text = await forwardResp.text();

    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!forwardResp.ok) {
      return res.status(forwardResp.status || 500).json({
        ok: false,
        reqId,
        error: data?.error || "Could not request appointment options.",
        message:
          data?.message ||
          data?.error ||
          "Could not request appointment options.",
        upstream: data,
      });
    }

    return res.status(200).json({
      ...data,
      ok: data?.ok !== false,
      reqId,
    });
  } catch (err) {
    console.error("request-appointment-options failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
      reqId,
    });
  }
};
