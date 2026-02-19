import { createClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";

// You already have these in Vercel env (same ones get_options.js uses)
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY   (server only)
// OFFER_TOKEN_SECRET          (server only)  <-- whatever secret you used to sign offer_token in get_options.js

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    requireEnv("SUPABASE_URL");
    requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const OFFER_TOKEN_SECRET = requireEnv("OFFER_TOKEN_SECRET");

    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    // Verify caller user from Supabase JWT
    const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userRes?.user) return res.status(401).json({ error: "Invalid session" });

    const userId = userRes.user.id;

    // Confirm admin role
    const { data: profile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", userId)
      .single();

    if (profErr) return res.status(403).json({ error: profErr.message });
    if (profile?.role !== "admin") return res.status(403).json({ error: "Not admin" });

    const { request_id, days_out = 120 } = req.body || {};
    if (!request_id) return res.status(400).json({ error: "request_id is required" });

    // Load the request so we know whatever inputs your get_options logic needs (zone/home/etc)
    const { data: reqRow, error: reqLoadErr } = await supabaseAdmin
      .from("booking_requests")
      .select("*")
      .eq("id", request_id)
      .single();

    if (reqLoadErr) return res.status(400).json({ error: `Request not found: ${reqLoadErr.message}` });

    // ----------------------------
    // IMPORTANT:
    // Reuse your EXACT get_options.js logic here
    // to compute the candidate slots and their zone_code / route_zone_code / appointment_type / offer_role / offer_group.
    //
    // Below is a placeholder “generate all 8 slots per business day” example.
    // Replace buildSlotsForDay(...) + zone mapping with your real logic.
    // ----------------------------

    function buildSlotsForDay(serviceDateStr) {
      // slot_index 1..8, labels A..H (you use D/E/etc in the UI)
      return [
        { slot_index: 1, window_label: "A", start_time: "08:00:00", end_time: "10:00:00" },
        { slot_index: 2, window_label: "B", start_time: "08:30:00", end_time: "10:30:00" },
        { slot_index: 3, window_label: "C", start_time: "09:30:00", end_time: "11:30:00" },
        { slot_index: 4, window_label: "D", start_time: "10:00:00", end_time: "12:00:00" },
        { slot_index: 5, window_label: "E", start_time: "13:00:00", end_time: "15:00:00" },
        { slot_index: 6, window_label: "F", start_time: "13:30:00", end_time: "15:30:00" },
        { slot_index: 7, window_label: "G", start_time: "14:30:00", end_time: "16:30:00" },
        { slot_index: 8, window_label: "H", start_time: "15:00:00", end_time: "17:00:00" },
      ];
    }

    // Example: generate for business days only (Mon–Fri)
    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const upserts = [];

    for (let i = 0; i < Number(days_out); i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dow = d.getDay(); // 0 Sun..6 Sat
      if (dow === 0 || dow === 6) continue;

      const service_date = d.toISOString().slice(0, 10); // YYYY-MM-DD

      // TODO: zone_code/route_zone_code must come from YOUR logic
      const zone_code = reqRow.zone_code || reqRow.route_zone_code || "C";
      const route_zone_code = reqRow.route_zone_code || zone_code;

      for (const s of buildSlotsForDay(service_date)) {
        // offer_group/offer_role should match what your UI expects (“primary” vs “more”, etc)
        const offer_group = "seed";
        const offer_role = "primary";
        const appointment_type = "standard";

        // Create a signed token (same format as your existing one)
        const offer_token = jwt.sign(
          {
            request_id,
            appointment_type,
            zone: zone_code,
            service_date,
            slot_index: s.slot_index,
            exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 // 1y
          },
          OFFER_TOKEN_SECRET
        );

        upserts.push({
          request_id,
          offer_group,
          service_date,
          slot_index: s.slot_index,
          zone_code,
          offer_token,
          window_label: s.window_label,
          start_time: s.start_time,
          end_time: s.end_time,
          is_active: true,
          appointment_type,
          offer_role,
          route_zone_code
        });
      }
    }

    // Upsert to avoid duplicates
    // We need a unique constraint to upsert properly.
    // If you don't have one yet, add it (see SQL below).
    const { data: upserted, error: upErr } = await supabaseAdmin
      .from("booking_request_offers")
      .upsert(upserts, { onConflict: "request_id,service_date,slot_index,zone_code,appointment_type,offer_role" })
      .select("id");

    if (upErr) return res.status(400).json({ error: upErr.message });

    return res.status(200).json({ ok: true, upserted: upserted?.length || 0 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
