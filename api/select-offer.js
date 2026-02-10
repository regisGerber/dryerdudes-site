// /api/select-offer.js
import crypto from "crypto";

function base64urlToJson(b64url) {
  const b64 =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((b64url.length + 3) % 4);
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}

function verifyToken(token, secret) {
  const [payloadB64, sigB64] = String(token || "").split(".");
  if (!payloadB64 || !sigB64) return { ok: false, message: "Bad token format" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  if (expected !== sigB64) return { ok: false, message: "Invalid signature" };

  const payload = base64urlToJson(payloadB64);
  if (payload?.exp && Date.now() > Number(payload.exp)) {
    return { ok: false, message: "Token expired" };
  }

  return { ok: true, payload };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function supabaseFetch({ url, method = "GET", serviceRole, body }) {
  const resp = await fetch(url, {
    method,
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!resp.ok) {
    const err = new Error(
      typeof data === "string" ? data : JSON.stringify(data)
    );
    err.status = resp.status;
    err.supabase = data;
    throw err;
  }

  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method Not Allowed" });
  }

  try {
    const { token = "" } = req.body || {};
    const cleanToken = String(token).trim();
    if (!cleanToken) {
      return res.status(400).json({ ok: false, message: "Missing token" });
    }

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");

    const v = verifyToken(cleanToken, TOKEN_SECRET);
    if (!v.ok) {
      return res.status(400).json({ ok: false, message: v.message });
    }

    // 1) Load the offer
    const offerUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?offer_token=eq.${encodeURIComponent(cleanToken)}` +
      `&select=id,request_id,service_date,slot_index,slot_code,zone_code`;

    const offers = await supabaseFetch({
      url: offerUrl,
      serviceRole: SERVICE_ROLE,
    });

    const offer = offers?.[0];
    if (!offer) {
      return res.status(404).json({ ok: false, message: "Offer not found" });
    }

    // 2) Attempt to create the booking (this is where the UNIQUE index protects you)
    try {
      await supabaseFetch({
        url: `${SUPABASE_URL}/rest/v1/bookings`,
        method: "POST",
        serviceRole: SERVICE_ROLE,
        body: {
          request_id: offer.request_id,
          selected_option_id: offer.id,
          zone_code: offer.zone_code,
          slot_code: offer.slot_code,
          appointment_type: "standard",
          status: "pending_payment",
        },
      });
    } catch (err) {
      // 🔒 Slot already taken (unique constraint)
      if (
        err.supabase?.code === "23505" ||
        String(err.message).includes("duplicate key")
      ) {
        return res.status(409).json({
          ok: false,
          message:
            "That appointment window was just booked by someone else. Please choose another option.",
        });
      }
      throw err;
    }

    // 3) Mark request as selected (safe after booking insert)
    await supabaseFetch({
      url:
        `${SUPABASE_URL}/rest/v1/booking_requests` +
        `?id=eq.${offer.request_id}`,
      method: "PATCH",
      serviceRole: SERVICE_ROLE,
      body: { status: "selected" },
    });

    return res.status(200).json({
      ok: true,
      request_id: offer.request_id,
      selected: {
        service_date: offer.service_date,
        slot_index: offer.slot_index,
        zone_code: offer.zone_code,
      },
      message: "Slot reserved. Proceed to payment.",
    });
  } catch (err) {
    console.error("select-offer error:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error",
      detail: err?.message || String(err),
    });
  }
}
