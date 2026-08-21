const SERVICE_AREA_MESSAGE =
  "We are not currently servicing this address. To keep prices low and make online scheduling possible, we maintain a tight service area—but it covers nearly all of Medford and the surrounding cities.";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function cleanString(value) {
  return String(value || "").trim();
}

function isTruthy(value) {
  return (
    value === true ||
    value === "true" ||
    value === "allow" ||
    value === "on" ||
    value === "yes" ||
    value === 1 ||
    value === "1"
  );
}

function getOrigin(req) {
  const envOrigin = cleanString(process.env.SITE_ORIGIN).replace(/\/+$/, "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) return envOrigin;

  const proto = cleanString(req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();
  const host =
    cleanString(req.headers["x-forwarded-host"]).split(",")[0].trim() ||
    cleanString(req.headers.host);

  return `${proto}://${host}`;
}

function getBearerToken(req) {
  const header = cleanString(req.headers.authorization);
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function fetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    text,
  };
}

async function getUserFromToken({ supabaseUrl, serviceRole, accessToken }) {
  const result = await fetchJson(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  return result.ok && result.data?.id ? result.data : null;
}

async function getSingle({ supabaseUrl, serviceRole, table, filters, select = "*" }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", select);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  url.searchParams.set("limit", "1");

  const result = await fetchJson(url.toString(), {
    headers: sbHeaders(serviceRole),
  });

  if (!result.ok) {
    throw new Error(
      `Supabase lookup failed (${table}): ${result.status} ${result.text}`
    );
  }

  return Array.isArray(result.data) ? result.data[0] || null : null;
}

async function patchRows({ supabaseUrl, serviceRole, table, filters, patch }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, `eq.${value}`);
  }

  const result = await fetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...sbHeaders(serviceRole),
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  if (!result.ok) {
    throw new Error(
      `Supabase patch failed (${table}): ${result.status} ${result.text}`
    );
  }

  return result.data;
}

function escHtml(value) {
  return String(value ?? "").replace(/[<>&"]/g, (char) =>
    ({
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
    })[char]
  );
}

function fmtDateMDY(iso) {
  const match = cleanString(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return cleanString(iso);
  return `${Number(match[2])}/${Number(match[3])}/${Number(match[1])}`;
}

function fmtTime12h(value) {
  const raw = cleanString(value).slice(0, 5);
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) return raw;

  let hour = Number(match[1]);
  const minutes = match[2];
  const period = hour >= 12 ? "PM" : "AM";
  hour %= 12;
  if (hour === 0) hour = 12;

  return `${hour}:${minutes} ${period}`;
}

function formatSlotLine(slot) {
  const date = fmtDateMDY(slot?.service_date);
  const start = fmtTime12h(slot?.start_time);
  const end = fmtTime12h(slot?.end_time);
  const window =
    start && end
      ? `${start}–${end}`
      : cleanString(slot?.window_label) || "Arrival window";

  return `${date} • ${window}`;
}

function centsFromApprovalValue(raw) {
  const amount = Number(raw || 15000);

  if ([15000, 17500, 20000, 22500, 25000].includes(amount)) return amount;
  if ([150, 175, 200, 225, 250].includes(amount)) return amount * 100;

  return 15000;
}

function propertyManagerAddress(pm) {
  return [
    pm?.billing_address_line_1,
    pm?.billing_address_line_2,
    pm?.billing_city,
    pm?.billing_state,
    pm?.billing_zip,
  ]
    .map(cleanString)
    .filter(Boolean)
    .join(", ");
}

function todayIsoInTimeZone(timeZone = "America/Los_Angeles") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function collectErrorText(value, output = [], depth = 0) {
  if (depth > 5 || value == null) return output;

  if (typeof value === "string" || typeof value === "number") {
    output.push(String(value));
    return output;
  }

  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item) => collectErrorText(item, output, depth + 1));
    return output;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          "error",
          "message",
          "status",
          "details",
          "data",
          "formatted_address",
          "location_type",
          "partial_match",
          "zone_code",
        ].includes(key)
      ) {
        collectErrorText(child, output, depth + 1);
      }
    }
  }

  return output;
}

function classifySchedulingFailure(upstream, upstreamStatus) {
  const text = collectErrorText(upstream).join(" ").toLowerCase();

  const invalidAddress =
    text.includes("invalid address") ||
    text.includes("geocoding failed") ||
    text.includes("valid street address") ||
    text.includes("partial_match") ||
    text.includes("location_type");

  if (invalidAddress) {
    return {
      status: 400,
      error: "Invalid service address",
      message:
        "Please select a complete, valid street address from the dropdown suggestions.",
    };
  }

  const outsideServiceArea =
    text.includes("could not resolve zone for address") ||
    text.includes("outside service area") ||
    text.includes("address outside service area") ||
    (upstream?.error === "Could not resolve zone for address");

  if (outsideServiceArea) {
    return {
      status: 422,
      error: "Address outside service area",
      message: SERVICE_AREA_MESSAGE,
    };
  }

  return {
    status: upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502,
    error: "Could not generate appointment options",
    message:
      cleanString(upstream?.message) ||
      cleanString(upstream?.error) ||
      "Could not generate appointment options for this request.",
  };
}

function buildVacantUnitNotes({
  vacancyAccessMethod,
  vacancyEndsOn,
  keyPickupAddress,
  vacancyAccessInstructions,
  accessNotes,
}) {
  const lines = ["VACANT UNIT"];
  lines.push(`Vacancy ends: ${fmtDateMDY(vacancyEndsOn)}`);

  if (vacancyAccessMethod === "key_pickup") {
    lines.push("Access method: Key pickup required");
    lines.push(`Key pickup address: ${keyPickupAddress}`);
  } else {
    lines.push("Access method: Lockbox at the property");
  }

  lines.push(`Access instructions: ${vacancyAccessInstructions}`);

  if (accessNotes) {
    lines.push(`Additional property notes: ${accessNotes}`);
  }

  return lines.join("\n");
}

async function sendEmailResend({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;

  if (!key) {
    return { skipped: true, reason: "RESEND_API_KEY not set" };
  }

  if (!to) {
    return { skipped: true, reason: "Recipient email is missing" };
  }

  const result = await fetchJson("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Dryer Dudes <scheduling@dryerdudes.com>",
      reply_to: "scheduling@dryerdudes.com",
      to: [to],
      subject,
      html,
    }),
  });

  return {
    skipped: false,
    ok: result.ok,
    status: result.status,
    data: result.data,
  };
}

async function autoScheduleFirstEligible({
  origin,
  options,
  vacancyEndsOn,
}) {
  const eligible = options.filter((option) => {
    const serviceDate = cleanString(option?.service_date);
    return serviceDate && serviceDate <= vacancyEndsOn && option?.offer_token;
  });

  if (!eligible.length) {
    return {
      ok: false,
      status: 409,
      error: "No appointment before vacancy ends",
      message:
        `No available appointment falls on or before ${fmtDateMDY(vacancyEndsOn)}. ` +
        "Extend the vacancy-end date or submit this as a tenant-scheduled request.",
    };
  }

  const conflicts = [];

  for (const option of eligible) {
    const result = await fetchJson(`${origin}/api/pm-confirm-offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: option.offer_token }),
    });

    if (result.ok && result.data?.ok) {
      return {
        ok: true,
        selected_offer: option,
        confirmation: result.data,
      };
    }

    const text = collectErrorText(result.data).join(" ").toLowerCase();
    const retryableConflict =
      result.status === 409 &&
      (text.includes("just taken") ||
        text.includes("no longer available") ||
        text.includes("not active"));

    if (retryableConflict) {
      conflicts.push({ option, response: result.data });
      continue;
    }

    return {
      ok: false,
      status: result.status || 500,
      error: cleanString(result.data?.error) || "Could not schedule vacant unit",
      message:
        cleanString(result.data?.message) ||
        cleanString(result.data?.error) ||
        "The vacant unit request was created, but the appointment could not be confirmed.",
      details: result.data,
    };
  }

  return {
    ok: false,
    status: 409,
    error: "Appointment options were taken",
    message:
      "The available appointment options were taken while this request was being scheduled. Please submit the request again to generate fresh options.",
    conflicts,
  };
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const SERVICE_TIME_ZONE =
      process.env.SERVICE_TIME_ZONE || "America/Los_Angeles";

    const accessToken = getBearerToken(req);
    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "Missing auth token" });
    }

    const user = await getUserFromToken({
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

    if (profile?.role !== "property_manager") {
      return res.status(403).json({
        ok: false,
        error: "Not authorized for property manager requests",
      });
    }

    const pm = await getSingle({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "property_managers",
      filters: { user_id: user.id },
      select: "*",
    });

    if (!pm?.id) {
      return res.status(403).json({
        ok: false,
        error: "No property manager account found",
      });
    }

    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        profile: {
          id: pm.id,
          company_name: pm.company_name || null,
          contact_name: pm.contact_name || null,
          email: pm.email || user.email || null,
          phone: pm.phone || null,
          default_job_approval_limit_cents:
            pm.default_job_approval_limit_cents || 15000,
          billing_address_line_1: pm.billing_address_line_1 || null,
          billing_address_line_2: pm.billing_address_line_2 || null,
          billing_city: pm.billing_city || null,
          billing_state: pm.billing_state || null,
          billing_zip: pm.billing_zip || null,
        },
      });
    }

    const body = req.body || {};
    const vacantUnit = isTruthy(body.vacant_unit);
    const fullServiceRequested =
      isTruthy(body.full_service_requested) || isTruthy(body.addon_preapproved);

    const tenantName = cleanString(body.tenant_name);
    const tenantPhone = cleanString(body.tenant_phone);
    const tenantEmail = cleanString(body.tenant_email).toLowerCase();
    const serviceAddress = cleanString(body.service_address);
    const addressLine1 = cleanString(body.address_line1);
    const addressCity = cleanString(body.address_city);
    const addressState = cleanString(body.address_state);
    const addressZip = cleanString(body.address_zip);
    const accessNotes = cleanString(body.access_notes);

    const vacancyAccessMethod = cleanString(body.vacancy_access_method);
    const vacancyEndsOn = cleanString(body.vacancy_ends_on);
    const vacancyAccessInstructions = cleanString(
      body.vacancy_access_instructions
    );
    const vacantEntryAuthorized = isTruthy(body.vacant_entry_authorized);
    const keyPickupAddress =
      cleanString(body.key_pickup_address) || propertyManagerAddress(pm);

    const totalJobApprovalLimitCents = centsFromApprovalValue(
      body.total_job_approval_limit_cents ||
        body.parts_approval_limit ||
        pm.default_job_approval_limit_cents
    );

    if (!serviceAddress) {
      return res.status(400).json({
        ok: false,
        error: "Service address is required",
        message: "Enter and select the service address from the dropdown suggestions.",
      });
    }

    if (!addressLine1 || !addressCity || !addressState || !addressZip) {
      return res.status(400).json({
        ok: false,
        error: "Invalid service address",
        message:
          "Please select a complete, valid street address from the dropdown suggestions.",
      });
    }

    const verifiedServiceAddress =
      `${addressLine1}, ${addressCity}, ${addressState} ${addressZip}`;

    if (!vacantUnit && (!tenantName || !tenantPhone || !tenantEmail)) {
      return res.status(400).json({
        ok: false,
        error: "Missing tenant contact information",
        message: "Tenant name, phone, and email are required.",
      });
    }

    if (vacantUnit) {
      if (!["lockbox", "key_pickup"].includes(vacancyAccessMethod)) {
        return res.status(400).json({
          ok: false,
          error: "Vacant-unit access method is required",
          message: "Choose lockbox access or key pickup.",
        });
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(vacancyEndsOn)) {
        return res.status(400).json({
          ok: false,
          error: "Vacancy-end date is required",
          message: "Enter the date the vacancy ends.",
        });
      }

      if (vacancyEndsOn < todayIsoInTimeZone(SERVICE_TIME_ZONE)) {
        return res.status(400).json({
          ok: false,
          error: "Vacancy-end date is in the past",
          message: "The vacancy-end date cannot be in the past.",
        });
      }

      if (vacancyAccessMethod === "key_pickup" && !keyPickupAddress) {
        return res.status(400).json({
          ok: false,
          error: "Key pickup address is required",
          message: "Enter the address where the technician should pick up the key.",
        });
      }

      if (!vacancyAccessInstructions) {
        return res.status(400).json({
          ok: false,
          error: "Vacant-unit access instructions are required",
          message: "Enter the lockbox or key-pickup instructions.",
        });
      }

      if (!vacantEntryAuthorized) {
        return res.status(400).json({
          ok: false,
          error: "Vacant-unit entry authorization is required",
          message: "Authorize Dryer Dudes to enter the vacant unit.",
        });
      }
    }

    const requestName = vacantUnit
      ? cleanString(pm.contact_name || pm.company_name || "Property manager")
      : tenantName;
    const requestPhone = vacantUnit
      ? cleanString(pm.phone || tenantPhone)
      : tenantPhone;
    const requestEmail = vacantUnit
      ? cleanString(pm.email || user.email || tenantEmail).toLowerCase()
      : tenantEmail;

    if (!requestEmail) {
      return res.status(400).json({
        ok: false,
        error: "Property manager email is missing",
        message:
          "This property manager account needs an email address before a vacant unit can be scheduled.",
      });
    }

    const appointmentType = fullServiceRequested ? "full_service" : "standard";
    const vacancyNotes = vacantUnit
      ? buildVacantUnitNotes({
          vacancyAccessMethod,
          vacancyEndsOn,
          keyPickupAddress,
          vacancyAccessInstructions,
          accessNotes,
        })
      : accessNotes;

    const origin = getOrigin(req);

    // Generate the same ordered options a tenant would receive, but suppress
    // the public booking email until the PM-specific flow decides what to do.
    const schedulingResult = await fetchJson(`${origin}/api/request-times`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: requestName,
        phone: requestPhone,
        email: requestEmail,
        contact_method: "email",
        address: verifiedServiceAddress,
        appointment_type: appointmentType,
        suppress_delivery: true,
        entry_instructions: accessNotes,
        authorized_entry: vacantUnit,
        home_choice: vacantUnit ? "no_one_home" : "adult_home",
        noh_entry_instructions: vacantUnit ? vacancyNotes : "",
      }),
    });

    if (!schedulingResult.ok || !schedulingResult.data?.ok) {
      const friendly = classifySchedulingFailure(
        schedulingResult.data,
        schedulingResult.status
      );

      return res.status(friendly.status).json({
        ok: false,
        error: friendly.error,
        message: friendly.message,
        upstream: schedulingResult.data,
      });
    }

    const scheduling = schedulingResult.data;

    if (!scheduling.request_id) {
      return res.status(409).json({
        ok: false,
        error: "No appointment options available",
        message:
          "No appointment options are currently available for this address. Please try again after additional schedule openings are added.",
        upstream: scheduling,
      });
    }

    const requestId = scheduling.request_id;

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: requestId },
      patch: {
        property_manager_id: pm.id,
        request_source: "property_manager",
        total_job_approval_limit_cents: totalJobApprovalLimitCents,
        addon_preapproved: fullServiceRequested,
        authorized_entry: vacantUnit,
        notes: vacancyNotes || null,
        status: "pending_scheduling",
        contact_method: "email",
      },
    });

    const primary = Array.isArray(scheduling.primary) ? scheduling.primary : [];
    const more = Array.isArray(scheduling.more?.options)
      ? scheduling.more.options
      : [];
    const options = [...primary, ...more].filter((option) => option?.offer_token);

    if (!options.length) {
      return res.status(409).json({
        ok: false,
        error: "No valid appointment options were returned",
        message:
          "Appointment options were generated, but none could be prepared for scheduling.",
        request_id: requestId,
      });
    }

    if (vacantUnit) {
      const autoSchedule = await autoScheduleFirstEligible({
        origin,
        options,
        vacancyEndsOn,
      });

      if (!autoSchedule.ok) {
        // Do not leave a duplicate, active request behind when automatic
        // scheduling cannot be completed. The PM can correct the date/access
        // information and submit a fresh request.
        await patchRows({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "booking_requests",
          filters: { id: requestId },
          patch: {
            status: "canceled",
            notes:
              `${vacancyNotes}\nAUTO-SCHEDULING NOT COMPLETED: ` +
              `${autoSchedule.message}`,
          },
        }).catch(() => null);

        await patchRows({
          supabaseUrl: SUPABASE_URL,
          serviceRole: SERVICE_ROLE,
          table: "booking_request_offers",
          filters: { request_id: requestId },
          patch: { is_active: false },
        }).catch(() => null);

        return res.status(autoSchedule.status || 409).json({
          ok: false,
          error: autoSchedule.error,
          message: autoSchedule.message,
          request_id: requestId,
          upstream: autoSchedule.details || autoSchedule.conflicts || null,
        });
      }

      return res.status(200).json({
        ok: true,
        auto_scheduled: true,
        vacant_unit: true,
        request_id: requestId,
        property_manager_id: pm.id,
        email_sent: false,
        selected_offer: autoSchedule.selected_offer,
        primary,
        more: scheduling.more || { options: more },
        ...autoSchedule.confirmation,
      });
    }

    const items = options
      .map((slot, index) => {
        const label = escHtml(formatSlotLine(slot));
        const link = `${origin}/pm-schedule.html?token=${encodeURIComponent(
          slot.offer_token
        )}`;

        return (
          `<li style="margin:12px 0;">` +
          `<strong>Option ${index + 1}: ${label}</strong><br/>` +
          `<a href="${link}">Select this appointment time</a>` +
          `</li>`
        );
      })
      .join("");

    const fullServiceLine = fullServiceRequested
      ? "<p><strong>Full Service is approved:</strong> interior lint cleanup, a safety-focused inspection, and lubrication where applicable will be provided for an additional $20.</p>"
      : "";

    const emailResult = await sendEmailResend({
      to: tenantEmail,
      subject: "Choose your Dryer Dudes appointment time",
      html:
        `<p>Hi ${escHtml(tenantName)},</p>` +
        `<p>Your property manager requested Dryer Dudes service for your dryer.</p>` +
        fullServiceLine +
        `<p>Please choose one of the appointment windows below. You will <strong>not</strong> be asked to pay at checkout.</p>` +
        `<ol>${items}</ol>` +
        `<p style="opacity:.85;">The technician can arrive any time within the selected arrival window.</p>` +
        `<p>— Dryer Dudes</p>`,
    });

    const emailSent = emailResult?.ok === true;

    await patchRows({
      supabaseUrl: SUPABASE_URL,
      serviceRole: SERVICE_ROLE,
      table: "booking_requests",
      filters: { id: requestId },
      patch: {
        status: emailSent ? "sent" : "pending_scheduling",
        scheduling_link_sent_at: emailSent ? new Date().toISOString() : null,
      },
    });

    return res.status(200).json({
      ok: true,
      request_id: requestId,
      property_manager_id: pm.id,
      email_sent: emailSent,
      delivery: { emailResult },
      primary,
      more: scheduling.more || { options: more },
    });
  } catch (error) {
    console.error("pm-request-times error:", error);

    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: error?.message || String(error),
    });
  }
}
