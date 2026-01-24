document.getElementById("bookingForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  alert("Got it — we’ll text/email you 3 appointment options shortly.");
  e.target.reset();
});

document.getElementById("existingJobForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  alert("Thanks — we received your job reference. We’ll follow up by text/email.");
  e.target.reset();
});
// ===== Supabase: form -> requests table (TEST WRITE) =====
const SUPABASE_URL = "https://amuprwbuhcupxfklmyzn.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY_GOES_HERE"; // anon key (safe for browser)

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
