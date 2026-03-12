// /api/get-request-offers.js

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function sbFetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body });
  const text = await resp.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { ok: resp.ok, status: resp.status, data, text };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({ ok: false, error: "Missing Supabase env vars" });
    }

    const requestId = String(req.query.request || "").trim();

    if (!requestId) {
      return res.status(400).json({ ok: false, error: "request is required" });
    }

    // 1) Fetch active offers for this request
    const offersUrl =
      `${SUPABASE_URL}/rest/v1/booking_request_offers` +
      `?request_id=eq.${encodeURIComponent(requestId)}` +
      `&is_active=eq.true` +
      `&select=offer_group,slot_id,offer_token,created_at` +
      `&order=offer_group.asc,created_at.asc`;

    const offersResp = await sbFetchJson(offersUrl, {
      headers: sbHeaders(SERVICE_ROLE),
    });

    if (!offersResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Failed to load offers from Supabase",
        status: offersResp.status,
        details: offersResp.text?.slice(0, 1500),
      });
    }

    const offers = Array.isArray(offersResp.data) ? offersResp.data : [];

    if (offers.length === 0) {
      return res.status(200).json({
        ok: true,
        primary: [],
        more: [],
      });
    }

    // 2) Fetch matching schedule slots
    const slotIds = [...new Set(
      offers.map((o) => String(o.slot_id || "").trim()).filter(Boolean)
    )];

    if (slotIds.length === 0) {
      return res.status(200).json({
        ok: true,
        primary: [],
        more: [],
      });
    }

    // PostgREST in() wants quoted uuid values
    const slotIdsCsv = slotIds.map((id) => `"${id}"`).join(",");

    const slotsUrl =
      `${SUPABASE_URL}/rest/v1/schedule_slots` +
      `?id=in.(${encodeURIComponent(slotIdsCsv)})` +
      `&select=id,service_date,slot_index,window_label,start_time,end_time,zone_code`;

    const slotsResp = await sbFetchJson(slotsUrl, {
      headers: sbHeaders(SERVICE_ROLE),
    });

    if (!slotsResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "Failed to load schedule slots from Supabase",
        status: slotsResp.status,
        details: slotsResp.text?.slice(0, 1500),
      });
    }

    const slots = Array.isArray(slotsResp.data) ? slotsResp.data : [];
    const slotMap = new Map(slots.map((s) => [String(s.id), s]));

    // 3) Merge offer + slot
    const merged = offers
      .map((offer) => {
        const slot = slotMap.get(String(offer.slot_id || ""));
        if (!slot) return null;

        return {
          offer_group: String(offer.offer_group || ""),
          offer_token: offer.offer_token,
          slot_id: offer.slot_id,
          service_date: slot.service_date,
          slot_index: slot.slot_index,
          window_label: slot.window_label,
          start_time: slot.start_time,
          end_time: slot.end_time,
          zone_code: slot.zone_code,
          created_at: offer.created_at || null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const groupCmp = String(a.offer_group).localeCompare(String(b.offer_group));
        if (groupCmp !== 0) return groupCmp;

        const dateCmp = String(a.service_date).localeCompare(String(b.service_date));
        if (dateCmp !== 0) return dateCmp;

        return Number(a.slot_index) - Number(b.slot_index);
      });

    const primary = merged.filter((o) => o.offer_group === "primary").slice(0, 3);
    const more = merged.filter((o) => o.offer_group === "more").slice(0, 2);

    return res.status(200).json({
      ok: true,
      primary,
      more,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
