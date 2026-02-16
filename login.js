import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing Supabase config on window.__SUPABASE_URL__ / __SUPABASE_ANON_KEY__");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const form = document.getElementById("loginForm");
const errEl = document.getElementById("error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.textContent = "";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    // 1) Authenticate
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error("AUTH: " + error.message);
    if (!data?.user?.id) throw new Error("AUTH: Missing user id");

    const uid = data.user.id;

    // 2) Load role (profile MUST exist)
    const { data: profile, error: profError } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", uid)
      .single(); // <-- IMPORTANT: fail if profile row doesn't exist

    if (profError) throw new Error("PROFILE: " + profError.message);

    const r = profile?.role;

    // 3) Route ONLY if role is explicitly known
    if (r === "admin") {
      window.location.href = "/admin.html";
      return;
    }

    if (r === "tech") {
      window.location.href = "/tech.html";
      return;
    }

    if (r === "property_manager") {
      window.location.href = "/pm.html";
      return;
    }

    // 4) Unknown / missing role => deny
    await supabase.auth.signOut();
    throw new Error("Your account is not assigned a valid role yet. Please contact support.");
  } catch (err) {
    console.error(err);

    // If we signed in but then failed downstream, ensure we don't leave a session hanging
    try { await supabase.auth.signOut(); } catch (_) {}

    errEl.textContent = String(err?.message || err);
  }
});
