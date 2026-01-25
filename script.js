// ==============================
// SUPABASE CONFIG
// ==============================
const SUPABASE_URL = "https://amuprwbuhcupxfklmyzn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtdXByd2J1aGN1cHhma2xteXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNzMzMTksImV4cCI6MjA4NDg0OTMxOX0.qop2LBQQ8z-iFhTWyj4dA-pIURfBCx6OtEmEfHYWAgY";

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

// ==============================
// FORM SUBMISSION
// ==============================
const bookingForm = document.getElementById("bookingForm");

if (bookingForm) {
  bookingForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    try {
      // Make sure Supabase is actually available
      if (!window.supabaseClient) {
        console.error("supabaseClient not found. Did init code run?");
        alert("Setup error: database connection not initialized.");
        return;
      }

      const fd = new FormData(bookingForm);

      const contactMethod = fd.get("contactMethod"); // text/email/both
      const fullName = fd.get("fullName");
      const phone = fd.get("phone");
      const email = fd.get("email");
      const entryInstructions = fd.get("entryInstructions");

      const address = fd.get("address");
      const city = fd.get("city");
      const state = fd.get("state");
      const zip = fd.get("zip");

      const issue = fd.get("issue");
      const homeRaw = fd.get("home"); // yes/no from your HTML

      // Map your HTML values -> the DB constraint values
      const willAnyoneBeHome =
        homeRaw === "yes" ? "adult_home" :
        homeRaw === "no"  ? "no_one_home" :
        null;

      // Payload MUST match your DB column names
      const payload = {
        status: "new",
        contact_method: contactMethod,
        customer_name: fullName,
        customer_phone: phone || null,
        customer_email: email || null,

        entry_instructions: entryInstructions || null,

        address_line1: address,
        city: city,
        state: state,
        zip: zip,

        dryer_symptoms: issue,
        will_anyone_be_home: willAnyoneBeHome,
      };

      console.log("Submitting payload:", payload);

      const { data, error } = await window.supabaseClient
        .from("requests")
        .insert([payload])
        .select()
        .single();

      if (error) {
        console.error("Supabase insert error:", error);
        alert("Submit failed: " + (error.message || "unknown error"));
        return;
      }

      console.log("Inserted row:", data);
      alert("Got it — we’ll text/email you 3 appointment options shortly.");
      bookingForm.reset();
    } catch (err) {
      console.error("Unexpected submit error:", err);
      alert("Submit crashed. Check console.");
  console.warn("bookingForm not found on page.");
}


    console.log("✅ Insert successful:", data);
    alert("Request received! We’ll text or email you shortly.");
    form.reset();


