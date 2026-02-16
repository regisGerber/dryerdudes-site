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
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error("AUTH: " + error.message);

    const uid = data.user.id;

    const { data: profile, error: profError } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", uid)
      .maybeSingle();

    if (profError) throw new Error("PROFILE: " + profError.message);

    const r = profile?.role || "tech";

    if (r === "admin") window.location.href = "/admin.html";
    else if (r === "property_manager") window.location.href = "/pm.html";
    else window.location.href = "/tech.html";
  } catch (err) {
    console.error(err);
    errEl.textContent = String(err.message || err);
  }
});
