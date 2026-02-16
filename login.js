// /login.js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = globalThis.__SUPABASE_URL__;
const SUPABASE_ANON_KEY = globalThis.__SUPABASE_ANON_KEY__;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing Supabase URL or ANON KEY. Check login.html window.__SUPABASE_URL__/__SUPABASE_ANON_KEY__.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const form = document.getElementById("loginForm");
const errorEl = document.getElementById("error");

function showError(msg) {
  errorEl.textContent = msg || "";
}

function redirectForRole(role) {
  const r = (role || "").toLowerCase();


  else if (r === "property_manager") window.location.href = "/pm.html";
  else window.location.href = "/tech.html"; // default
}

async function getMyRole(userId) {
  // This requires an RLS policy that allows the logged-in user to SELECT their own profile row
  // (user_id = auth.uid()).
  const { data, error, status } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  // maybeSingle(): returns null data if no rows, without throwing "multiple rows" errors
  if (error) throw error;

  if (!data) {
    // No profile row found — common if the "create profile on signup" trigger wasn’t set up.
    return null;
  }

  return data.role || null;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const user = data?.user;
    if (!user) throw new Error("Login succeeded but no user returned.");

    // Fetch role from profiles
    const role = await getMyRole(user.id);

    if (!role) {
      // Don’t silently route wrong; show a useful message
      showError(
        "Logged in, but no profile/role row was found for this user. " +
        "Open Supabase → Table Editor → public.profiles and confirm a row exists for this user_id."
      );
      return;
    }

    redirectForRole(role);
  } catch (err) {
    console.error(err);
    showError(err?.message || "Login failed.");
  }
});
