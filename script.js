console.log("SCRIPT_JS_LOADED");

// 1) Supabase init (attach to window so ANY function can access it)
const SUPABASE_URL = "https://amuprwbuhcupxfklmyzn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtdXByd2J1aGN1cHhma2xteXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNzMzMTksImV4cCI6MjA4NDg0OTMxOX0.qop2LBQQ8z-iFhTWyj4dA-pIURfBCx6OtEmEfHYWAgY";

if (!window.supabase) {
  console.error("❌ Supabase library not loaded (window.supabase missing).");
  window.supabaseClient = null;
} else {
  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log("✅ Supabase client initialized");
}

// 2) Helper: force browser validation bubbles to show
function requireValid(form) {
  if (!form.checkValidity()) {
    form.reportValidity(); // shows the “invalid field above” messages again
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
    console.log("🟦 SUBMIT EVENT bookingForm");

    // bring back validation messages
    if (!requireValid(bookingForm)) return;

    if (!window.supabaseClient) {
      alert("Setup error: database connection not initialized.");
      console.error("❌ window.supabaseClient is null");
      return;
    }

    const fd = new FormData(bookingForm);

    const payload = {
      contact_method: fd.get("contactMethod"),
      customer_name: fd.get("fullName"),
      customer_phone: fd.get("phone"),
      customer_email: fd.get("email"),
      entry_instructions: fd.get("entryInstructions"),
      address_line1: fd.get("address"),
      city: fd.get("city"),
      state: fd.get("state"),
      zip: fd.get("zip"),
      dryer_symptoms: fd.get("issue"),
      will_anyone_be_home: fd.get("home") === "yes" ? "adult_home" : "no_one_home",
      status: "new",
    };

    console.log("📦 payload", payload);

    const { data, error } = await window.supabaseClient
      .from("requests")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase insert error:", error);
      alert("Database error. Check console.");
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

// 5) IMPORTANT: Remove any old button click “force submit” behavior
// If you had code like: submitBtn.addEventListener("click", () => requestSubmit())
// delete it. This file intentionally does NOT do that.

