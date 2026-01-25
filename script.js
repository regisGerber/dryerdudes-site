// ===============================
// Dryer Dudes - script.js (clean)
// ===============================

console.log("SCRIPT_JS_LOADED__v3"); // change this if you want to confirm new deploy

// 1) Supabase init (must be after supabase-js CDN script in HTML)
const SUPABASE_URL = "PASTE_YOUR_SUPABASE_URL_HERE";
const SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_KEY_HERE";

let supabaseClient = null;

try {
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error("Supabase library not found. Check the CDN <script> tag.");
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.supabaseClient = supabaseClient; // for console testing
  console.log("✅ Supabase client initialized");
} catch (err) {
  console.error("❌ Supabase init failed:", err);
}

// 2) Simple validation helper
function requireValid(formEl) {
  // Let browser show native validation UI
  if (!formEl.checkValidity()) {
    formEl.reportValidity();
    return false;
  }
  return true;
}

// 3) Booking form submit
const bookingForm = document.getElementById("bookingForm");

if (!bookingForm) {
  console.error("❌ bookingForm not found in DOM");
} else {
  console.log("✅ bookingForm detected");

  bookingForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    console.log("🚀 bookingForm submit fired");

    if (!requireValid(bookingForm)) return;

    if (!supabaseClient) {
      alert("Setup error: database connection not initialized.");
      console.error("❌ supabaseClient missing");
      return;
    }

    const fd = new FormData(bookingForm);

    // IMPORTANT:
    // These keys MUST match your Supabase table column names.
    // This list matches what you were testing in console.
    const payload = {
      contact_method: fd.get("contactMethod") || null,
      customer_name: fd.get("fullName") || null,
      customer_phone: fd.get("phone") || null,
      customer_email: fd.get("email") || null,
      entry_instructions: fd.get("entryInstructions") || null,
      address_line1: fd.get("address") || null,
      city: fd.get("city") || null,
      state: fd.get("state") || null,
      zip: fd.get("zip") || null,
      dryer_symptoms: fd.get("issue") || null,

      // Default to adult_home unless they explicitly choose "no"
      will_anyone_be_home:
        (fd.get("home") || "yes") === "no" ? "no_one_home" : "adult_home",

      status: "new",
    };

    console.log("📦 Payload:", payload);

    const { data, error } = await supabaseClient
      .from("requests")
      .insert([payload])
      .select();

    if (error) {
      console.error("❌ Supabase insert error:", error);
      alert("Submit failed: " + (error.message || "Unknown error"));
      return;
    }

    console.log("✅ Insert success:", data);
    alert("Got it — we'll text/email you 3 appointment options shortly.");
    bookingForm.reset();
  });
}

// 4) Existing job form submit (optional)
const existingJobForm = document.getElementById("existingJobForm");
if (existingJobForm) {
  existingJobForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!requireValid(existingJobForm)) return;
    alert("Thanks — we received your job reference. We'll follow up shortly.");
    existingJobForm.reset();
  });
}
