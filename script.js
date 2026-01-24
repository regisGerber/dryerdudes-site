document.getElementById("bookingForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Make sure supabase is available (from the CDN script in your HTML)
  if (!window.supabase) {
    alert("Supabase library not loaded. Check your <script> include in index.html.");
    return;
  }

  const form = e.target;
  const formData = new FormData(form);

  // IMPORTANT: your DB check constraint wants ONLY these values:
  // 'adult_home' or 'no_one_home'
  const rawHome = (formData.get("will_anyone_be_home") || "").toString().trim().toLowerCase();
  const willAnyoneBeHome = (rawHome === "adult_home" || rawHome === "yes")
    ? "adult_home"
    : "no_one_home";

  const payload = {
    status: "new",
    contact_method: (formData.get("contact_method") || "").toString(),
    customer_name: (formData.get("customer_name") || "").toString(),
    customer_phone: (formData.get("customer_phone") || "").toString(),
    customer_email: (formData.get("customer_email") || "").toString(),

    // These MUST exist because your DB is rejecting nulls for address_line1 (you saw that error)
    address_line1: (formData.get("address_line1") || "").toString(),
    city: (formData.get("city") || "").toString(),
    state: (formData.get("state") || "").toString(),
    zip: (formData.get("zip") || "").toString(),

    dryer_symptoms: (formData.get("dryer_symptoms") || "").toString(),
    will_anyone_be_home: willAnyoneBeHome,

    full_service_selected: (formData.get("full_service_selected") === "true" || formData.get("full_service_selected") === "on"),
  };

  // Quick guard so you don’t keep “successful” submits that insert nothing:
  if (!payload.address_line1) {
    alert("Address is required.");
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from("requests")
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    alert("Got it — we’ll text/email you 3 appointment options shortly.");
    form.reset();
    console.log("Inserted request:", data);
  } catch (err) {
    console.error("Supabase insert failed:", err);
    alert("Submit failed: " + (err?.message || err));
  }
});


document.getElementById("existingJobForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  alert("Thanks — we received your job reference. We’ll follow up by text/email.");
  e.target.reset();
});
// ===== Supabase: form -> requests table (TEST WRITE) =====
const SUPABASE_URL = "https://amuprwbuhcupxfklmyzn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtdXByd2J1aGN1cHhma2xteXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNzMzMTksImV4cCI6MjA4NDg0OTMxOX0.qop2LBQQ8z-iFhTWyj4dA-pIURfBCx6OtEmEfHYWAgY"; // anon key (safe for browser)

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const form = document.getElementById("bookingForm"); // make sure your <form id="bookingForm">
if (!form) {
  console.error("bookingForm not found. Confirm your form has id='bookingForm'.");
} else {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // grab contact method (text/email/both)
    const contactMethod =
      form.querySelector('input[name="contactMethod"]:checked')?.value || null;

    // Minimal insert (only fields we KNOW exist from your screenshot)
    const payload = {
      status: "new",
      contact_method: contactMethod,
    };

    console.log("Submitting to Supabase:", payload);

    const { data, error } = await supabaseClient
      .from("requests")
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      alert("Save failed. Open DevTools Console to see the error message.");
      return;
    }

    console.log("Saved request row:", data);
    alert("Success! Request saved to Supabase.");
  });
}
