console.log("✅ SCRIPT LOADED (diagnostic)");

function requireValid(formEl) {
  if (!formEl.checkValidity()) {
    formEl.reportValidity();
    return false;
  }
  return true;
}

document.addEventListener(
  "submit",
  (e) => {
    console.log("✅ A SUBMIT EVENT HAPPENED (captured)", e.target);
  },
  true // capture mode catches submits even if something stops bubbling
);

const bookingForm = document.getElementById("bookingForm");
const bookingSubmitBtn = document.getElementById("bookingSubmitBtn");

if (bookingForm && bookingSubmitBtn) {
  bookingSubmitBtn.addEventListener("click", async (e) => {
    e.preventDefault();

    console.log("✅ bookingSubmitBtn CLICK handler fired");

    // Use browser validation UI
    if (!requireValid(bookingForm)) {
      console.log("⛔ Form invalid (browser blocked submission).");
      return;
    }

    const fd = new FormData(bookingForm);

    const payload = {
      status: "new",
      contact_method: (fd.get("contact_method") || "").toString().trim(),
      customer_name: (fd.get("customer_name") || "").toString().trim(),
      phone: (fd.get("phone") || "").toString().trim(),
      email: (fd.get("email") || "").toString().trim(),
      address_line1: (fd.get("address_line1") || "").toString().trim(),
      city: (fd.get("city") || "").toString().trim(),
      state: (fd.get("state") || "").toString().trim(),
      zip: (fd.get("zip") || "").toString().trim(),
      entry_instructions: (fd.get("entry_instructions") || "").toString().trim(),
      dryer_symptoms: (fd.get("dryer_symptoms") || "").toString().trim(),
      will_anyone_be_home: (fd.get("will_anyone_be_home") || "adult_home").toString().trim(),
    };

    console.log("📦 Payload about to insert:", payload);

    if (!window.supabaseClient) {
      console.error("❌ window.supabaseClient missing");
      alert("Supabase client missing.");
      return;
    }

   const { error } = await supabaseClient
  .from("requests")
  .insert(payload);

if (error) {
  console.error(error);
  alert("Something went wrong");
  return;
}


    alert("Got it — we'll text/email you 3 appointment options shortly.");
    bookingForm.reset();
  });
}


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


if (bookingForm) {
  bookingForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    console.log("✅ bookingForm SUBMIT handler fired");

    try {
      const fd = new FormData(bookingForm);

      // IMPORTANT: these keys MUST match your Supabase column names
      const payload = {
        status: "new",
        contact_method: (fd.get("contact_method") || "").toString().trim(),
        customer_name: (fd.get("customer_name") || "").toString().trim(),
        phone: (fd.get("phone") || "").toString().trim(),
        email: (fd.get("email") || "").toString().trim(),
        address_line1: (fd.get("address_line1") || "").toString().trim(),
        city: (fd.get("city") || "").toString().trim(),
        state: (fd.get("state") || "").toString().trim(),
        zip: (fd.get("zip") || "").toString().trim(),
        entry_instructions: (fd.get("entry_instructions") || "").toString().trim(),
        dryer_symptoms: (fd.get("dryer_symptoms") || "").toString().trim(),
        will_anyone_be_home: (fd.get("will_anyone_be_home") || "adult_home").toString().trim(),
      };

      console.log("📦 Payload about to insert:", payload);

      if (!window.supabaseClient) {
        console.error("❌ window.supabaseClient is missing");
        alert("Supabase client missing.");
        return;
      }

      const { data, error } = await window.supabaseClient
        .from("requests")
        .insert([payload])
        .select();

      console.log("🧾 Insert result:", { data, error });

      if (error) {
        alert("Submit failed: " + error.message);
        return;
      }

      alert("Got it — we'll text/email you 3 appointment options shortly.");
      bookingForm.reset();
    } catch (err) {
      console.error("❌ Submit handler crashed:", err);
      alert("Submit failed (JS error). Check console.");
    }
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
