import crypto from "crypto";

function base64urlToJson(b64url) {
  const b64 =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((b64url.length + 3) % 4);
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
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

async function supabaseGet({ url, serviceRole }) {
  const resp = await fetch(url, {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      Accept: "application/json",
    },
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`Supabase get failed: ${resp.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function supabaseGetSingle({ table, match, select, serviceRole, supabaseUrl }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  Object.entries(match).forEach(([k, v]) => url.searchParams.set(k, `eq.${v}`));
  url.searchParams.set("limit", "1");

  const data = await supabaseGet({ url: url.toString(), serviceRole });
  return Array.isArray(data) ? data[0] : null;
}

async function supabasePatch({ table, match, patch, serviceRole, supabaseUrl }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  Object.entries(match).forEach(([k, v]) => url.searchParams.set(k, `eq.${v}`));

  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`Supabase patch failed: ${resp.status} ${JSON.stringify(data)}`);
  }

  return data;
}

function makeLocalTs(service_date, hhmmss, offset) {
  if (!service_date || !hhmmss) return null;
  const t = String(hhmmss).trim().slice(0, 8);
  const m = t.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = m[1];
  const mm = m[2];
  const ss = m[3] ?? "00";
  return `${service_date}T${hh}:${mm}:${ss}${offset}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method Not Allowed" });
  }

  try {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, message: "Missing token" });
    }

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const TOKEN_SECRET = requireEnv("TOKEN_SIGNING_SECRET");
    const TZ_OFFSET = String(process.env.LOCAL_TZ_OFFSET || "-08:00");

    const verified = verifyToken(token, TOKEN_SECRET);
    if (!verified.ok) {
      return res.status(400).json({ ok: false, message: verified.message });
    }

    // Fetch offer and enforce is_active
    const offer = await supabaseGetSingle({
      table: "booking_request_offers",
      match: { offer_token: token },
      select: "id, request_id, service_date, slot_index, zone_code, start_time, end_time, is_active",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
    });

    if (!offer) {
      return res.status(404).json({ ok: false, message: "Offer not found" });
    }

    if (!offer.is_active) {
      return res.status(409).json({
        ok: false,
        message: "This time slot is no longer available. Please request new times.",
      });
    }

    // Resolve zone -> tech (so we can check time off)
    const zta = await supabaseGetSingle({
      table: "zone_tech_assignments",
      match: { zone_code: offer.zone_code },
      select: "zone_code, tech_id",
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
    });

    // If you don’t have a mapping yet, we allow selection (but bookings later may still need assignment logic)
    if (zta?.tech_id) {
      const windowStart = makeLocalTs(offer.service_date, offer.start_time, TZ_OFFSET);
      const windowEnd = makeLocalTs(offer.service_date, offer.end_time, TZ_OFFSET);

      if (windowStart && windowEnd) {
        // Any overlapping time off row?
        const url = new URL(`${SUPABASE_URL}/rest/v1/tech_time_off`);
        url.searchParams.set(
          "select",
          "id"
        );
        url.searchParams.set("tech_id", `eq.${zta.tech_id}`);
        url.searchParams.set("start_ts", `lt.${windowEnd}`); // start < end
        url.searchParams.set("end_ts", `gt.${windowStart}`); // end > start
        url.searchParams.set("limit", "1");

        const offRows = await supabaseGet({ url: url.toString(), serviceRole: SERVICE_ROLE });
        if (Array.isArray(offRows) && offRows.length) {
          return res.status(409).json({
            ok: false,
            message: "That slot just became unavailable. Please request new times.",
          });
        }
      }
    }

    // Record selection on the request
    await supabasePatch({
      table: "booking_requests",
      match: { id: offer.request_id },
      patch: {
        selected_option_id: offer.id,
        status: "selected",
      },
      serviceRole: SERVICE_ROLE,
      supabaseUrl: SUPABASE_URL,
    });

    return res.status(200).json({
      ok: true,
      request_id: offer.request_id,
      selected: {
        service_date: offer.service_date,
        slot_index: offer.slot_index,
        zone_code: offer.zone_code,
      },
      message: "Option selected. Proceed to checkout.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || String(err),
    });
  }
}
