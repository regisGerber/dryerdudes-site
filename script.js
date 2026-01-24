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
const form = document.getElementById("bookingForm");

if (!form) {
  console.error("❌ bookingForm not found in DOM");
} else {
  console.log("✅ bookingForm detected");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    console.log("🚀 Submit handler running");

    const formData = new FormData(form);

    const payload = {
      contact_method: formData.get("contactMethod"),
      full_name: formData.get("fullName"),
      phone: formData.get("phone"),
      email: formData.get("email"),
      entry_instructions: formData.get("entryInstructions"),
      address: formData.get("address"),
      city: formData.get("city"),
      state: formData.get("state"),
      zip: formData.get("zip"),
      issue: formData.get("issue"),
      will_anyone_be_home:
        formData.get("home") === "yes"
          ? "adult_home"
          : "no_one_home",
    };

    console.log("📦 Payload:", payload);

    const { data, error } = await supabaseClient
      .from("requests")
      .insert([payload]);

    if (error) {
      console.error("❌ Supabase insert error:", error);
      alert("Something went wrong. Please try again.");
      return;
    }

    console.log("✅ Insert successful:", data);
    alert("Request received! We’ll text or email you shortly.");
    form.reset();
  });
}

