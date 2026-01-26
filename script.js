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
  status: "new",
  contact_method: fd.get("contact_method"),

  customer_name: fd.get("customer_name"),
  phone: fd.get("phone"),       // ✅ column name in Supabase
  email: fd.get("email"),       // ✅ column name in Supabase

  address_line1: fd.get("address_line1"),
  city: fd.get("city"),
  state: fd.get("state"),
  zip: fd.get("zip"),

  entry_instructions: fd.get("entry_instructions"),
  dryer_symptoms: fd.get("issue") || fd.get("dryer_symptoms"),

  will_anyone_be_home: fd.get("home") === "no_one_home" ? "no_one_home" : "adult_home",
  no_one_home_details: fd.get("no_one_home_details") || ""
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
