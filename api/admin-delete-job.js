function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function clean(value) {
  return String(value || "").trim();
}

function getBearerToken(req) {
  const match = clean(req.headers.authorization).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function headers(serviceRole, extra = {}) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { ok: response.ok, status: response.status, data, text };
}

async function getSingle({ supabaseUrl, serviceRole, table, filters, select = "*" }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  url.searchParams.set("limit", "1");

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  const result = await requestJson(url.toString(), {
    headers: headers(serviceRole),
  });

  if (!result.ok) {
    throw new Error(`Could not load ${table}: ${result.status} ${result.text}`);
  }

  return Array.isArray(result.data) ? result.data[0] || null : null;
}

async function patchRows({ supabaseUrl, serviceRole, table, filters, patch }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  const result = await requestJson(url.toString(), {
    method: "PATCH",
    headers: headers(serviceRole, { Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });

  if (!result.ok) {
    throw new Error(`Could not update ${table}: ${result.status} ${result.text}`);
  }

  return result.data;
}

async function deleteRows({
  supabaseUrl,
  serviceRole,
  table,
  filters,
  optional = false,
}) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  const result = await requestJson(url.toString(), {
    method: "DELETE",
    headers: headers(serviceRole, { Prefer: "return=representation" }),
  });

  const missingOptionalResource =
    optional &&
    (result.status === 404 ||
      result.data?.code === "42P01" ||
      result.data?.code === "42703");

  if (!result.ok && !missingOptionalResource) {
    throw new Error(`Could not delete from ${table}: ${result.status} ${result.text}`);
  }

  return missingOptionalResource ? [] : result.data;
}

async function getUser({ supabaseUrl, serviceRole, accessToken }) {
  const result = await requestJson(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  return result.ok && result.data?.id ? result.data : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const SUPABASE_URL = requireEnv("SUPABASE_URL");
  const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  let slotSnapshot = null;
  let booking = null;
  let bookingDeleted = false;

  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "Missing auth token" });
    }

    const user = await getUser({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      accessToken,
    });

    if (!user?.id) {
      return res.status(401).json({ ok: false, error: "Invalid auth token" });
    }

    const profile = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "profiles",
      filters: { user_id: user.id },
      select: "user_id,role",
    });

    if (profile?.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Admin access is required." });
    }

    const jobRef = clean(req.body?.job_ref).toUpperCase();
    const confirmation = clean(req.body?.confirm_job_ref).toUpperCase();

    if (!/^DD-\d{6}$/.test(jobRef)) {
      return res.status(400).json({
        ok: false,
        error: "Enter a valid job reference in the format DD-123456.",
      });
    }

    if (confirmation !== jobRef) {
      return res.status(400).json({
        ok: false,
        error: "The confirmation job reference does not match.",
      });
    }

    booking = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { job_ref: jobRef },
      select:
        "id,job_ref,request_id,slot_id,status,payment_status,collected_cents,window_start,window_end",
    });

    if (!booking) {
      return res.status(404).json({ ok: false, error: "Job not found." });
    }

    if (
      Number(booking.collected_cents || 0) > 0 ||
      String(booking.payment_status || "").toLowerCase() === "paid"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Paid jobs cannot be permanently deleted from the admin tool. Use the refund/cancellation workflow so the payment record is preserved.",
      });
    }

    // Older bookings may be linked from schedule_slots even when bookings.slot_id is empty.
    // Resolve that relationship before reopening the slot so deleting an old test job cannot
    // leave the calendar blocked.
    if (!booking.slot_id) {
      const linkedSlot = await getSingle({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "schedule_slots",
        filters: { booking_id: booking.id },
        select: "id,is_booked,booking_id,booked_at",
      });

      if (linkedSlot?.id) {
        booking.slot_id = linkedSlot.id;
        slotSnapshot = linkedSlot;
      }
    }

    if (booking.slot_id) {
      if (!slotSnapshot) {
        slotSnapshot = await getSingle({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "schedule_slots",
          filters: { id: booking.slot_id },
          select: "id,is_booked,booking_id,booked_at",
        });
      }

      await patchRows({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "schedule_slots",
        filters: { id: booking.slot_id },
        patch: {
          is_booked: false,
          booking_id: null,
          booked_at: null,
        },
      });
    }

    // Clear secondary operational records that may reference the booking before
    // deleting the booking itself. These are optional so older deployments that do
    // not have one of the tables can still use the delete tool.
    await deleteRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "admin_new_booking_alerts",
      filters: { booking_id: booking.id },
      optional: true,
    });

    await deleteRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "sms_reminder_log",
      filters: { job_ref: jobRef },
      optional: true,
    });

    await deleteRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_events",
      filters: { booking_id: booking.id },
      optional: true,
    });

    await deleteRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "job_help_requests",
      filters: { booking_id: booking.id },
      optional: true,
    });

    await deleteRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "job_parts",
      filters: { booking_id: booking.id },
      optional: true,
    });

    await deleteRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_billing",
      filters: { booking_id: booking.id },
      optional: true,
    });

    await deleteRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "bookings",
      filters: { id: booking.id },
    });
    bookingDeleted = true;

    let requestDeleted = false;

    if (booking.request_id) {
      await deleteRows({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "job_help_requests",
        filters: { request_id: booking.request_id },
        optional: true,
      });

      await deleteRows({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "booking_request_offers",
        filters: { request_id: booking.request_id },
        optional: true,
      });

      try {
        await deleteRows({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "booking_requests",
          filters: { id: booking.request_id },
        });
        requestDeleted = true;
      } catch (requestDeleteError) {
        await patchRows({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "booking_requests",
          filters: { id: booking.request_id },
          patch: {
            status: "canceled",
            notes: `Linked booking ${jobRef} was permanently deleted by an admin.`,
          },
        }).catch(() => null);
      }
    }

    console.log("Admin permanently deleted job", {
      job_ref: jobRef,
      booking_id: booking.id,
      request_id: booking.request_id,
      admin_user_id: user.id,
      slot_id: booking.slot_id,
    });

    return res.status(200).json({
      ok: true,
      job_ref: jobRef,
      booking_id: booking.id,
      request_id: booking.request_id || null,
      request_deleted: requestDeleted,
      slot_reopened: !!booking.slot_id,
    });
  } catch (error) {
    if (!bookingDeleted && booking?.slot_id && slotSnapshot) {
      await patchRows({
        supabaseUrl: SUPABASE_URL,
        serviceRole: SERVICE_ROLE,
        table: "schedule_slots",
        filters: { id: booking.slot_id },
        patch: {
          is_booked: slotSnapshot.is_booked === true,
          booking_id: slotSnapshot.booking_id || booking.id,
          booked_at: slotSnapshot.booked_at || null,
        },
      }).catch(() => null);
    }

    console.error("admin-delete-job error:", error);
    return res.status(500).json({
      ok: false,
      error: "Could not delete the job.",
      message: error?.message || String(error),
    });
  }
};
