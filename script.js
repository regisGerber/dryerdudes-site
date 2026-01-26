// ===============================
// Dryer Dudes - script.js (clean)
// ===============================

// ===== Supabase init (single source of truth) =====
const SUPABASE_URL = "https://amuprwbuhcupxfklmyzn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtdXByd2J1aGN1cHhma2xteXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNzMzMTksImV4cCI6MjA4NDg0OTMxOX0.qop2LBQQ8z-iFhTWyj4dA-pIURfBCx6OtEmEfHYWAgY";

console.log("DEBUG SUPABASE_URL =", SUPABASE_URL);
console.log("DEBUG SUPABASE_KEY starts =", SUPABASE_ANON_KEY.slice(0, 12));

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

window.supabaseClient = supabaseClient;
console.log("✅ Supabase client initialized");

// 3) Booking form submit
const bookingForm = document.getElementById("bookingForm");

if (bookingForm) {
  console.log("✅ bookingForm detected");

  bookingForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    console.log("✅ SUBMIT FIRED");

    if (!window.supabaseClient) {
      console.error("❌ supabaseClient missing");
      alert("Supabase client not loaded.");
      return;
    }

    // grab form fields
    const fd = new FormData(bookingForm);

    const payload = {
      status: "new",
      contact_method: fd.get("contact_method") || null,

      customer_name: fd.get("customer_name") || null,
      phone: fd.get("phone") || null,
      email: fd.get("email") || null,

      address_line1: fd.get("address_line1") || null,
      city: fd.get("city") || null,
      state: fd.get("state") || null,
      zip: fd.get("zip") || null,

      entry_instructions: fd.get("entry_instructions") || null,
      dryer_symptoms: fd.get("issue") || fd.get("dryer_symptoms") || null,

      will_anyone_be_home:
        (fd.get("home") === "no_one_home" ? "no_one_home" : "adult_home"),

      no_one_home_details: fd.get("no_one_home_details") || null,
    };

    console.log("🧾 PAYLOAD:", payload);

    const { data, error } = await window.supabaseClient
      .from("requests")
      .insert([payload])
      .select();

    console.log("📦 INSERT RESULT:", { data, error });

    if (error) {
      alert("Submit failed: " + error.message);
      return;
    }

    alert("Submitted! We’ll text/email you appointment options shortly.");
    bookingForm.reset();
  });
} else {
  console.warn("⚠️ bookingForm NOT found on page");
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
