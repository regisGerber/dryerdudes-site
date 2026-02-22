// /api/request-appointment-options.js
// POST endpoint called by your front-end form.
// It calls /api/get-available-slots and returns JSON always.
// If upstream returns non-JSON, we return a JSON error with a body snippet.

const fetchFn = async (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  const mod = await import("node-fetch");
  return mod.default(...args);
};

function safeJsonParse(text) {
  try {
    return { ok: true, value: text ? JSON.parse(text) : null };
  } catch (e) {
    return { ok: false, error: e };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    // Vercel parses JSON body automatically for application/json
    const body = req.body || {};

    // Accept a few possible field names so small front-end mismatches don’t 500
    const zone =
      String(body.zone || body.home_location_code || body.zip_zone || "")
        .trim()
        .toUpperCase();

    const typeRaw = String(body.type || body.appointmentType || "standard").trim().toLowerCase();
    const appointmentType =
      typeRaw === "parts"
        ? "parts"
        : typeRaw === "no_one_home" || typeRaw === "no-one-home" || typeRaw === "noonehome"
        ? "no_one_home"
        : "standard";

    if (!["A", "B", "C", "D"].includes(zone)) {
      return res.status(400).json({ ok: false, error: "Invalid zone. Must be A, B, C, or D." });
    }

    // Build absolute URL to your own API (works on Vercel + local)
    const proto =
      (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim() || "https";
    const host =
      (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0].trim();

    if (!host) {
      return res.status(500).json({ ok: false, error: "Missing host header (cannot build upstream URL)." });
    }

    const upstreamUrl = new URL(`${proto}://${host}/api/get-available-slots`);
    upstreamUrl.searchParams.set("zone", zone);
    upstreamUrl.searchParams.set("type", appointmentType);

    // If you want to debug from the browser, set body.debug=1
    if (String(body.debug || "") === "1") upstreamUrl.searchParams.set("debug", "1");

    const upstreamResp = await fetchFn(upstreamUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const upstreamText = await upstreamResp.text();
    const parsed = safeJsonParse(upstreamText);

    if (!upstreamResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "Upstream get-available-slots failed",
        upstream_status: upstreamResp.status,
        upstream_body_snippet: upstreamText.slice(0, 1200),
      });
    }

    if (!parsed.ok) {
      return res.status(502).json({
        ok: false,
        error: "Upstream returned non-JSON",
        upstream_status: upstreamResp.status,
        upstream_body_snippet: upstreamText.slice(0, 1200),
      });
    }

    // Your front-end likely expects an "options" style payload.
    // We pass through what get-available-slots returns, but include ok:true.
    return res.status(200).json({
      ok: true,
      zone,
      appointmentType,
      ...parsed.value,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).slice(0, 1600) : null,
    });
  }
};
