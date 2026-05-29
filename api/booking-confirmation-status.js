function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { ok: resp.ok, status: resp.status, data, text };
}

function normalizeJobRef(jobRef) {
  let s = String(jobRef || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (/^\d{6}$/.test(s)) {
    s = `DD-${s}`;
  }

  const compact = s.match(/^DD(\d{6})$/);
  if (compact) {
    s = `DD-${compact[1]}`;
  }

  return s;
}

function getInput(req) {
  if (req.method === "GET") {
    return {
      session_id:
        req.query?.session_id ||
        req.query?.sessionId ||
        req.query?.stripe_session_id ||
        req.query?.checkout_session_id ||
        "",
      job_ref:
        req.query?.job_ref ||
        req.query?.jobRef ||
        req.query?.job ||
        req.query?.ref ||
        "",
    };
  }

  return {
    session_id:
      req.body?.session_id ||
      req.body?.sessionId ||
      req.body?.stripe_session_id ||
      req.body?.checkout_session_id ||
      "",
    job_ref:
      req.body?.job_ref ||
      req.body?.jobRef ||
      req.body?.job ||
      req.body?.ref ||
      "",
  };
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();

  if (s === "scheduled") return "scheduled";
  if (s === "en_route") return "en route";
  if (s === "on_site") return "on site";
  if (s === "billing_pending") return "billing pending";
  if (s === "awaiting_payment") return "awaiting payment";
  if (s === "parts_approval_needed") return "approval needed";
  if (s === "parts_on_order") return "parts on order";
  if (s === "completed") return "completed";
  if (s === "cancelled") return "cancelled";
  if (s === "no_show") return "no show";

  return s || "scheduled";
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const input = getInput(req);

    const sessionId = String(input.session_id || "").trim();
    const jobRef = normalizeJobRef(input.job_ref);

    if (!sessionId && !jobRef) {
      return res.status(200).json({
        ok: true,
        confirmed: false,
        status: "missing_lookup",
        message: "No session ID or job number was provided.",
      });
    }

    const select = [
      "id",
      "job_ref",
      "status",
      "window_start",
      "window_end",
      "stripe_checkout_session_id",
      "created_at",
    ].join(",");

    let booking = null;

    if (sessionId) {
      const url = new URL(`${SUPABASE_URL}/rest/v1/bookings`);
      url.searchParams.set("select", select);
      url.searchParams.set("stripe_checkout_session_id", `eq.${sessionId}`);
      url.searchParams.set("limit", "1");

      const r = await sbFetchJson(url.toString(), {
        headers: sbHeaders(SERVICE_ROLE),
      });

      if (!r.ok) {
        return res.status(500).json({
          ok: false,
          confirmed: false,
          error: "Could not check booking status.",
          details: r.data,
        });
      }

      booking = Array.isArray(r.data) ? r.data[0] || null : null;
    }

    if (!booking && jobRef) {
      const url = new URL(`${SUPABASE_URL}/rest/v1/bookings`);
      url.searchParams.set("select", select);
      url.searchParams.set("job_ref", `eq.${jobRef}`);
      url.searchParams.set("limit", "1");

      const r = await sbFetchJson(url.toString(), {
        headers: sbHeaders(SERVICE_ROLE),
      });

      if (!r.ok) {
        return res.status(500).json({
          ok: false,
          confirmed: false,
          error: "Could not check booking status.",
          details: r.data,
        });
      }

      booking = Array.isArray(r.data) ? r.data[0] || null : null;
    }

    if (!booking) {
      return res.status(200).json({
        ok: true,
        confirmed: false,
        status: "pending",
        message: "Payment was received, but the appointment is still being finalized.",
      });
    }

    return res.status(200).json({
      ok: true,
      confirmed: true,
      status: "confirmed",
      booking: {
        booking_id: booking.id,
        job_ref: booking.job_ref,
        booking_status: booking.status,
        booking_status_label: statusLabel(booking.status),
        window_start: booking.window_start,
        window_end: booking.window_end,
        created_at: booking.created_at,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      confirmed: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
};
