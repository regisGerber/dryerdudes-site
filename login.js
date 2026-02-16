import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const form = document.getElementById("loginForm");
const errEl = document.getElementById("error");
const resetLink = document.getElementById("resetLink");

function showError(msg) {
  errEl.textContent = msg || "";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);

    const uid = data.user.id;

    const { data: profile, error: profError } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", uid)
      .maybeSingle();

    if (profError) throw new Error("Profile lookup failed: " + profError.message);

    const r = profile?.role || null;

    // Only allow explicitly-assigned roles (NO default-to-tech)
    if (r === "admin") window.location.href = "/admin.html";
    else if (r === "tech") window.location.href = "/tech.html";
    else if (r === "property_manager") window.location.href = "/pm.html";
    else {
      // Immediately sign out so they can't retain a session token
      await supabase.auth.signOut();
      throw new Error("Your account is not assigned a portal role yet. Please contact DryerDudes.");
    }
  } catch (err) {
    console.error(err);
    showError(String(err?.message || err));
  }
});

resetLink?.addEventListener("click", async (e) => {
  e.preventDefault();
  showError("");

  const email = document.getElementById("email").value.trim();
  if (!email) {
    showError("Enter your email first, then click password reset.");
    return;
  }

  try {
    // IMPORTANT: set this to your real hosted reset page if/when you add one
    const redirectTo = `${window.location.origin}/login.html`;

    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new Error(error.message);

    showError("Password reset sent. Check your inbox (and spam).");
  } catch (err) {
    console.error(err);
    showError(String(err?.message || err));
  }
});
