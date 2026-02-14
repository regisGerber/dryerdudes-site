// login.js
import { supabase } from "./supabaseClient.js";

const $ = (id) => document.getElementById(id);

async function getMyRole() {
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr) throw userErr;
  const user = userData?.user;
  if (!user) return null;

  // profiles.user_id should match auth.uid()
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", user.id)
    .single();

  if (error) throw error;
  return profile?.role || null;
}

async function onLogin(e) {
  e.preventDefault();
  $("error").textContent = "";

  const email = $("email").value.trim();
  const password = $("password").value;

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    $("error").textContent = error.message;
    return;
  }

  const role = await getMyRole();

  // Redirect destinations (we’ll create these pages next)
  if (role === "admin") window.location.href = "/admin.html";
  else if (role === "tech") window.location.href = "/tech.html";
  else window.location.href = "/login.html";
}

async function init() {
  // If already logged in, bounce them
  const { data } = await supabase.auth.getSession();
  if (data?.session) {
    try {
      const role = await getMyRole();
      if (role === "admin") window.location.href = "/admin.html";
      if (role === "tech") window.location.href = "/tech.html";
    } catch (e) {
      // ignore; let them stay on login
    }
  }

  $("loginForm").addEventListener("submit", onLogin);
}

init().catch((e) => {
  console.error(e);
  $("error").textContent = e.message || "Login error";
});
