// /api/request-appointment-options.js
// Frontend POSTs here; we forward to /api/request-times and return its response.
// This wrapper normalizes responses to { ok: true/false, ... } and preserves upstream errors.

function isTruthy(v) {
  return v === true || v === "true" || v === "on" || v === 1 || v === "1";
}

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;

  const proto = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host =
    String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim() ||
    String(req?.headers?.host || "").trim();

  return `${proto}://${host}`;
}

function makeReqId() {
  return `rao_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function safeReadJson(resp) {
  const text = await resp.text();
  try {
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, data: { ok: false, error: "Upstream returned non-JSON", raw: text } };
  }
}

function looksLikeSchemaCacheError(upstream) {
  const msg = String(upstream?.message || upstream?.error || "");
  return msg.includes("PGRST204") && msg.toLowerCase().includes("schema cache");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const reqId = makeReqId();

  try {
    const b = req.body || {};

    const contact_method = String(b.contact_method || "email").toLowerCase();
    const name = String(b.customer_name || b.name || "").trim();
    const phone = String(b.phone || "").trim();
    const email = String(b.email || "").trim();

    const address_line1 = String(b.address_line1 || "").trim();
    const city = String(b.city || "").trim();
    const state = String(b.state || "").trim();
    const zip = String(b.zip || "").trim();

    const address = [address_line1, city, state, zip].filter(Boolean).join(", ");

    // HOME CHOICE (accept multiple variants)
    let home = String(b.home_choice_required || b.home || "").trim();

    const homeAdult = isTruthy(b.home_adult);
    const homeNoOne = isTruthy(b.home_noone);

    if (!home) {
      home = homeNoOne ? "no_one_home" : homeAdult ? "adult_home" : "";
    }

    // normalize
    if (home === "adult_home" || home === "adult") home = "adult_home";
    if (home === "no_one_home" || home === "noone" || home === "authorized") home = "no_one_home";

    // enforce exactly one
    if (homeAdult && homeNoOne) {
      return res.status(400).json({ ok: false, error: "Choose only one: adult_home OR no_one_home", reqId });
    }
    if (!home) {
      return res.status(400).json({ ok: false, error: "home choice is required", reqId });
    }

    const full_service = isTruthy(b.full_service);

    // appointment type mapping
    let appointment_type = "standard";
    if (home === "no_one_home") appointment_type = "no_one_home";
    else if (full_service) appointment_type = "full_service";

    // Minimal validation
    if (!address) return res.status(400).json({ ok: false, error: "address is required", reqId });
    if ((contact_method === "text" || contact_method === "both") && !phone) {
      return res.status(400).json({ ok: false, error: "phone is required for text/both", reqId });
    }
    if ((contact_method === "email" || contact_method === "both") && !email) {
      return res.status(400).json({ ok: false, error: "email is required for email/both", reqId });
    }

    const origin = getOrigin(req);

    // Only pass fields request-times should care about (keep it clean)
    const forwardPayload = {
      name,
      phone,
      email,
      contact_method,
      address,
      appointment_type,

      // Optional extras
      entry_instructions: b.entry_instructions || "",
      dryer_symptoms: b.dryer_symptoms || "",
      home,
      no_one_home: b.no_one_home || null,
      full_service: !!full_service,

      // tracing
      req_id: reqId,
    };

    const forwardUrl = `${origin}/api/request-times`;

    // Timeout protection (Vercel functions can hang if upstream stalls)
    const controller = new AbortController();
    const timeoutMs = Number(process.env.REQUEST_TIMES_TIMEOUT_MS || 12000);
    const t = setTimeout(() => controller.abort(), timeoutMs);

    let forwardResp;
    try {
      forwardResp = await fetch(forwardUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": reqId,
        },
        body: JSON.stringify(forwardPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }

    const parsed = await safeReadJson(forwardResp);
    const data = parsed.data || {};
    if (typeof data?.ok !== "boolean") data.ok = forwardResp.ok;

    if (!forwardResp.ok || !data.ok) {
      // If this is the specific Supabase schema-cache issue, return a clearer message
      if (looksLikeSchemaCacheError(data)) {
        return res.status(500).json({
          ok: false,
          error: "Supabase schema cache is stale (missing end_time in REST cache). Reload Supabase API schema cache, then retry.",
          reqId,
          upstream: data,
        });
      }

      return res.status(forwardResp.status || 500).json({
        ok: false,
        error: data?.error || data?.message || `Upstream request-times failed (${forwardResp.status})`,
        reqId,
        upstream: data,
      });
    }

    return res.status(200).json({ ...data, reqId });
  } catch (err) {
    const msg = err?.name === "AbortError"
      ? "request-times timed out"
      : (err?.message || String(err));

    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: msg,
      reqId,
    });
  }
}
