import crypto from "crypto";

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

function decodeBase64UrlJson(value) {
  const raw = cleanString(value);

  const base64 =
    raw.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((raw.length + 3) % 4);

  return JSON.parse(
    Buffer.from(base64, "base64").toString("utf8")
  );
}

function verifyToken(token, secret) {
  const [payloadPart, signaturePart] =
    cleanString(token).split(".");

  if (!payloadPart || !signaturePart) {
    return {
      ok: false,
      message: "Bad token format",
    };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payloadPart)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const expectedBuffer =
    Buffer.from(expected);

  const receivedBuffer =
    Buffer.from(signaturePart);

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(
      expectedBuffer,
      receivedBuffer
    )
  ) {
    return {
      ok: false,
      message: "Invalid signature",
    };
  }

  let payload;

  try {
    payload =
      decodeBase64UrlJson(payloadPart);
  } catch {
    return {
      ok: false,
      message: "Invalid token payload",
    };
  }

  if (
    payload?.exp &&
    Date.now() > Number(payload.exp)
  ) {
    return {
      ok: false,
      message:
        "This booking link has expired.",
    };
  }

  return {
    ok: true,
    payload,
  };
}

function sbHeaders(serviceRole) {
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchJson(
  url,
  {
    method = "GET",
    headers = {},
    body,
  } = {}
) {
  const response =
    await fetch(url, {
      method,
      headers,
      body,
    });

  const text =
    await response.text();

  let data = {};

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text,
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    text,
  };
}

async function getSingle({
  supabaseUrl,
  serviceRole,
  table,
  filters,
  select = "*",
}) {
  const url =
    new URL(
      `${supabaseUrl}/rest/v1/${table}`
    );

  url.searchParams.set(
    "select",
    select
  );

  for (
    const [key, value]
    of Object.entries(filters || {})
  ) {
    url.searchParams.set(
      key,
      `eq.${value}`
    );
  }

  url.searchParams.set(
    "limit",
    "1"
  );

  const result =
    await fetchJson(
      url.toString(),
      {
        headers:
          sbHeaders(serviceRole),
      }
    );

  if (!result.ok) {
    throw new Error(
      `Supabase lookup failed (${table}): ${result.status} ${result.text}`
    );
  }

  return Array.isArray(result.data)
    ? result.data[0] || null
    : null;
}

async function getRows({
  supabaseUrl,
  serviceRole,
  table,
  filters,
  select = "*",
  order,
}) {
  const url =
    new URL(
      `${supabaseUrl}/rest/v1/${table}`
    );

  url.searchParams.set(
    "select",
    select
  );

  for (
    const [key, value]
    of Object.entries(filters || {})
  ) {
    url.searchParams.set(
      key,
      value
    );
  }

  if (order) {
    url.searchParams.set(
      "order",
      order
    );
  }

  const result =
    await fetchJson(
      url.toString(),
      {
        headers:
          sbHeaders(serviceRole),
      }
    );

  if (!result.ok) {
    throw new Error(
      `Supabase lookup failed (${table}): ${result.status} ${result.text}`
    );
  }

  return Array.isArray(result.data)
    ? result.data
    : [];
}

async function patchRows({
  supabaseUrl,
  serviceRole,
  table,
  filters,
  patch,
}) {
  const url =
    new URL(
      `${supabaseUrl}/rest/v1/${table}`
    );

  for (
    const [key, value]
    of Object.entries(filters || {})
  ) {
    url.searchParams.set(
      key,
      `eq.${value}`
    );
  }

  const result =
    await fetchJson(
      url.toString(),
      {
        method: "PATCH",

        headers: {
          ...sbHeaders(serviceRole),
          Prefer:
            "return=representation",
        },

        body:
          JSON.stringify(patch),
      }
    );

  if (!result.ok) {
    throw new Error(
      `Supabase patch failed (${table}): ${result.status} ${result.text}`
    );
  }

  return result.data;
}

function trimTo(
  value,
  maxLength
) {
  return cleanString(value)
    .slice(0, maxLength);
}

function buildAuthorizedEntryNotes(
  existingNotes,
  details
) {
  const marker =
    "TENANT AUTHORIZED ENTRY";

  const current =
    cleanString(existingNotes);

  const markerIndex =
    current.indexOf(marker);

  const base =
    markerIndex >= 0
      ? current
          .slice(0, markerIndex)
          .trim()
      : current;

  const lines = [
    marker,
  ];

  lines.push(
    `How to enter: ${details.entryInstructions}`
  );

  lines.push(
    `Dryer location: ${details.dryerLocation}`
  );

  if (
    details.breakerLocation
  ) {
    lines.push(
      `Breaker location: ${details.breakerLocation}`
    );
  }

  if (details.petNotes) {
    lines.push(
      `Pet / safety notes: ${details.petNotes}`
    );
  }

  lines.push(
    "Tenant authorized entry during the selected appointment window."
  );

  lines.push(
    "Tenant confirmed pets will be secured away from the service area."
  );

  return [
    base,
    lines.join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function loadRequestContext({
  requestId,
  supabaseUrl,
  serviceRole,
}) {
  const request =
    await getSingle({
      supabaseUrl,
      serviceRole,

      table:
        "booking_requests",

      filters: {
        id: requestId,
      },

     select:
  "id,name,address,status,appointment_type,zone_code,home_location_code,property_manager_id,request_source,authorized_entry,notes,selected_slot_at",
    });

  if (!request) {
    return {
      error: {
        status: 404,
        message:
          "Booking request not found.",
      },
    };
  }

  if (
    request.request_source !==
      "property_manager" ||
    !request.property_manager_id
  ) {
    return {
      error: {
        status: 403,
        message:
          "This is not a property-manager booking request.",
      },
    };
  }

  const propertyManager =
    await getSingle({
      supabaseUrl,
      serviceRole,

      table:
        "property_managers",

      filters: {
        id:
          request.property_manager_id,
      },

      select:
        "id,company_name,contact_name",
    });

  const booking =
    await getSingle({
      supabaseUrl,
      serviceRole,

      table:
        "bookings",

      filters: {
        request_id:
          request.id,
      },

      select:
        "id,job_ref,window_start,window_end,status,appointment_type,payment_status",
    });

  return {
    request,
    propertyManager,
    booking,
  };
}

const ROUTE_DAY_ZONE_BY_DOW = {
  1: "B",
  2: "D",
  3: "X",
  4: "A",
  5: "C",
};

const ADJACENT_ROUTE_ZONES = {
  A: ["B"],
  B: ["A", "C"],
  C: ["B", "D"],
  D: ["C"],
};

const AM_SLOT_INDEXES = new Set([1, 2, 3, 4]);
const PM_SLOT_INDEXES = new Set([5, 6, 7, 8]);
const FLEX_AM_SLOT_INDEXES = new Set([3, 4]);
const FLEX_PM_SLOT_INDEXES = new Set([7, 8]);

function serviceDateDayOfWeek(serviceDate) {
  const match = cleanString(serviceDate).match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (!match) {
    return -1;
  }

  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    )
  ).getUTCDay();
}

function isAllowedServiceDate(serviceDate) {
  const day = serviceDateDayOfWeek(serviceDate);
  return day >= 1 && day <= 5;
}

const SERVICE_TIME_ZONE =
  process.env.SERVICE_TIME_ZONE || "America/Los_Angeles";

function getNowInServiceTimeZone() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SERVICE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function isSlotStartStillAvailable(serviceDate, startTime) {
  const slotDate = cleanString(serviceDate);

  const timeMatch = cleanString(startTime).match(
    /^(\d{2}):(\d{2})(?::(\d{2}))?/
  );

  if (!slotDate || !timeMatch) {
    return false;
  }

  const slotTime =
    `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3] || "00"}`;

  const now = getNowInServiceTimeZone();

  if (slotDate > now.date) {
    return true;
  }

  if (slotDate < now.date) {
    return false;
  }

  // At the exact start time, the slot is no longer available.
  return slotTime > now.time;
}

function schedulerOfferRank(offer, homeZoneRaw) {
  const homeZone = cleanString(
    homeZoneRaw
  ).toUpperCase();

  const routeDayZone =
    ROUTE_DAY_ZONE_BY_DOW[
      serviceDateDayOfWeek(
        offer?.service_date
      )
    ] || "";

  const slotZone = cleanString(
    offer?.zone_code
  ).toUpperCase();

  const slotIndex = Number(
    offer?.slot_index
  );

  // Keep Wednesday behind regular route-day choices
  // even for an older request that lacks a stored zone.
  if (!homeZone) {
    return routeDayZone === "X"
      ? 99
      : 50;
  }

  // These rankings mirror get-available-slots.js:
  // o1, o2, o3, o4, then Wednesday o5.

  if (
    routeDayZone === homeZone &&
    slotZone === homeZone &&
    AM_SLOT_INDEXES.has(slotIndex)
  ) {
    return 1;
  }

  if (
    routeDayZone === homeZone &&
    slotZone === homeZone &&
    PM_SLOT_INDEXES.has(slotIndex)
  ) {
    return 2;
  }

  if (
    (
      ADJACENT_ROUTE_ZONES[homeZone] ||
      []
    ).includes(routeDayZone) &&
    slotZone === routeDayZone &&
    FLEX_AM_SLOT_INDEXES.has(slotIndex)
  ) {
    return 3;
  }

  if (
    (
      ADJACENT_ROUTE_ZONES[homeZone] ||
      []
    ).includes(routeDayZone) &&
    slotZone === routeDayZone &&
    FLEX_PM_SLOT_INDEXES.has(slotIndex)
  ) {
    return 4;
  }

  if (
    routeDayZone === "X" &&
    slotZone === "X"
  ) {
    return 5;
  }

  return 90;
}

function compareInSchedulerOrder(
  a,
  b,
  homeZone
) {
  const aRank = schedulerOfferRank(
    a,
    homeZone
  );

  const bRank = schedulerOfferRank(
    b,
    homeZone
  );

  if (aRank !== bRank) {
    return aRank - bRank;
  }

  const dateComparison = String(
    a.service_date
  ).localeCompare(
    String(b.service_date)
  );

  if (dateComparison !== 0) {
    return dateComparison;
  }

  const slotPriorities = {
    1: [1, 2, 3, 4],
    2: [5, 6, 7, 8],
    3: [4, 3],
    4: [8, 7],
    5: [1, 2, 3, 4, 5, 6, 7, 8],
  };

  const priority =
    slotPriorities[aRank] || [];

  const aPosition =
    priority.indexOf(
      Number(a.slot_index)
    );

  const bPosition =
    priority.indexOf(
      Number(b.slot_index)
    );

  if (aPosition !== bPosition) {
    return (
      (
        aPosition < 0
          ? 99
          : aPosition
      ) -
      (
        bPosition < 0
          ? 99
          : bPosition
      )
    );
  }

  return String(
    a.start_time || ""
  ).localeCompare(
    String(b.start_time || "")
  );
}

async function loadOffers({
  requestId,
  homeZone,
  supabaseUrl,
  serviceRole,
}) {
  const offers =
    await getRows({
      supabaseUrl,
      serviceRole,

      table:
        "booking_request_offers",

      filters: {
        request_id:
          `eq.${requestId}`,

        is_active:
          "eq.true",
      },

      select:
        "id,request_id,offer_group,offer_token,is_active,appointment_type,route_zone_code,slot_id,created_at",
    });

  const slotIds = [
    ...new Set(
      offers
        .map((offer) =>
          cleanString(
            offer.slot_id
          )
        )
        .filter(Boolean)
    ),
  ];

  if (!slotIds.length) {
    return {
      primary: [],
      more: [],
    };
  }

  const slots =
    await getRows({
      supabaseUrl,
      serviceRole,

      table:
        "schedule_slots",

      filters: {
        id:
          `in.(${slotIds.join(",")})`,
      },

      select:
        "id,service_date,slot_index,zone_code,window_label,start_time,end_time,is_booked",
    });

  const slotMap =
    new Map(
      slots.map((slot) => [
        String(slot.id),
        slot,
      ])
    );

  const merged =
    offers
      .map((offer) => {
        const slot =
          slotMap.get(
            String(
              offer.slot_id || ""
            )
          );

    if (
  !slot ||
  slot.is_booked === true ||
  !isAllowedServiceDate(slot.service_date) ||
  !isSlotStartStillAvailable(
    slot.service_date,
    slot.start_time
  )
) {
  return null;
}

        return {
          offer_id:
            offer.id,

          offer_group:
            cleanString(
              offer.offer_group
            ),

          offer_token:
            offer.offer_token,

          appointment_type:
            offer.appointment_type ||
            null,

          route_zone_code:
            offer.route_zone_code ||
            null,

          slot_id:
            slot.id,

          service_date:
            slot.service_date,

          slot_index:
            slot.slot_index,

          zone_code:
            slot.zone_code,

          window_label:
            slot.window_label,

          start_time:
            slot.start_time,

          end_time:
            slot.end_time,

          created_at:
            offer.created_at ||
            null,
        };
      })
      .filter(Boolean)
.sort((a, b) =>
  compareInSchedulerOrder(
    a,
    b,
    homeZone
  )
);

  return {
    primary:
      merged
        .filter(
          (offer) =>
            offer.offer_group ===
            "primary"
        )
        .slice(0, 3),

    more:
      merged
        .filter(
          (offer) =>
            offer.offer_group ===
            "more"
        )
        .slice(0, 2),
  };
}

export default async function handler(req, res) {
  // Appointment availability must always be checked live.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (
    !["GET", "POST"].includes(
      req.method
    )
  ) {
    res.setHeader(
      "Allow",
      "GET, POST"
    );

    return res
      .status(405)
      .json({
        ok: false,
        error:
          "Method Not Allowed",
      });
  }

  try {
    const SUPABASE_URL =
      requireEnv(
        "SUPABASE_URL"
      );

    const SERVICE_ROLE =
      requireEnv(
        "SUPABASE_SERVICE_ROLE_KEY"
      );

    const TOKEN_SECRET =
      requireEnv(
        "TOKEN_SIGNING_SECRET"
      );

    const requestToken =
      req.method === "GET"
        ? cleanString(
            req.query?.token
          )
        : cleanString(
            req.body?.request_token
          );

    if (!requestToken) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Missing secure booking token",
        });
    }

    const verifiedRequestToken =
      verifyToken(
        requestToken,
        TOKEN_SECRET
      );

    if (
      !verifiedRequestToken.ok
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            verifiedRequestToken.message,
        });
    }

    const requestPayload =
      verifiedRequestToken.payload ||
      {};

    const requestId =
      cleanString(
        requestPayload.request_id
      );

    if (
      requestPayload.kind !==
        "request" ||
      !requestId
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "This is not a valid PM booking-page link.",
        });
    }

    const context =
      await loadRequestContext({
        requestId,

        supabaseUrl:
          SUPABASE_URL,

        serviceRole:
          SERVICE_ROLE,
      });

    if (context.error) {
      return res
        .status(
          context.error.status
        )
        .json({
          ok: false,
          error:
            context.error.message,
        });
    }

    const {
      request,
      propertyManager,
      booking,
    } = context;

    const propertyManagerName =
      cleanString(
        propertyManager?.company_name
      ) ||
      cleanString(
        propertyManager?.contact_name
      ) ||
      "Your property manager";

    if (req.method === "GET") {
      if (booking) {
        return res
          .status(200)
          .json({
            ok: true,

            already_scheduled:
              true,

            property_manager_name:
              propertyManagerName,

            request: {
              id:
                request.id,

              name:
                request.name ||
                null,

              address:
                request.address ||
                null,

              status:
                request.status ||
                null,

              appointment_type:
                request.appointment_type ||
                "standard",

              authorized_entry:
                request.authorized_entry ===
                true,
            },

            booking,

            primary: [],
            more: [],
          });
      }

      if (
        [
          "canceled",
          "cancelled",
        ].includes(
          cleanString(
            request.status
          ).toLowerCase()
        )
      ) {
        return res
          .status(410)
          .json({
            ok: false,
            error:
              "This service request has been canceled.",
          });
      }

      const offers =
  await loadOffers({
    requestId:
      request.id,

    homeZone:
      request.zone_code ||
      request.home_location_code,

    supabaseUrl:
      SUPABASE_URL,

    serviceRole:
      SERVICE_ROLE,
  });

      if (
        !offers.primary.length &&
        !offers.more.length
      ) {
        return res
          .status(409)
          .json({
            ok: false,

            error:
              "These appointment options are no longer available. Please contact your property manager for new options.",
          });
      }

      return res
        .status(200)
        .json({
          ok: true,

          already_scheduled:
            false,

          property_manager_name:
            propertyManagerName,

          request: {
            id:
              request.id,

            name:
              request.name ||
              null,

            address:
              request.address ||
              null,

            status:
              request.status ||
              null,

            appointment_type:
              request.appointment_type ||
              "standard",

            authorized_entry:
              request.authorized_entry ===
              true,
          },

          primary:
            offers.primary,

          more:
            offers.more,
        });
    }

    if (booking) {
      return res
        .status(409)
        .json({
          ok: false,

          error:
            "This request already has a scheduled appointment.",

          booking,
        });
    }

    const offerToken =
      cleanString(
        req.body?.offer_token
      );

    if (!offerToken) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Choose an appointment before confirming.",
        });
    }

    const verifiedOfferToken =
      verifyToken(
        offerToken,
        TOKEN_SECRET
      );

    if (
      !verifiedOfferToken.ok
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            verifiedOfferToken.message,
        });
    }

    if (
      cleanString(
        verifiedOfferToken
          .payload?.request_id
      ) !== request.id
    ) {
      return res
        .status(403)
        .json({
          ok: false,

          error:
            "That appointment option does not belong to this request.",
        });
    }

    const offer =
      await getSingle({
        supabaseUrl:
          SUPABASE_URL,

        serviceRole:
          SERVICE_ROLE,

        table:
          "booking_request_offers",

        filters: {
          offer_token:
            offerToken,
        },

        select:
          "id,request_id,is_active,slot_id",
      });

    if (
      !offer ||
      offer.request_id !==
        request.id
    ) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Appointment option not found.",
        });
    }

    if (!offer.is_active) {
      return res
        .status(409)
        .json({
          ok: false,

          error:
            "That appointment option is no longer available.",
        });
    }

    const authorizedEntry =
      isTruthy(
        req.body?.authorized_entry
      );

    if (authorizedEntry) {
      const entryInstructions =
        trimTo(
          req.body
            ?.entry_instructions,
          1800
        );

      const dryerLocation =
        trimTo(
          req.body
            ?.dryer_location,
          500
        );

      const breakerLocation =
        trimTo(
          req.body
            ?.breaker_location,
          500
        );

      const petNotes =
        trimTo(
          req.body?.pet_notes,
          800
        );

      const agreeEntry =
        isTruthy(
          req.body?.agree_entry
        );

      const agreePets =
        isTruthy(
          req.body?.agree_pets
        );

      if (!entryInstructions) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "Entry instructions are required for Authorized Entry.",
          });
      }

      if (!dryerLocation) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "Dryer location is required for Authorized Entry.",
          });
      }

      if (!agreeEntry) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Entry authorization is required.",
          });
      }

      if (!agreePets) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "Please confirm that pets will be secured.",
          });
      }

      const updatedNotes =
        buildAuthorizedEntryNotes(
          request.notes,
          {
            entryInstructions,
            dryerLocation,
            breakerLocation,
            petNotes,
          }
        );

      await patchRows({
        supabaseUrl:
          SUPABASE_URL,

        serviceRole:
          SERVICE_ROLE,

        table:
          "booking_requests",

        filters: {
          id:
            request.id,
        },

        patch: {
          authorized_entry:
            true,

          notes:
            updatedNotes,
        },
      });
    }

    const origin =
      getOrigin(req);

    const confirmation =
      await fetchJson(
        `${origin}/api/pm-confirm-offer`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              token:
                offerToken,
            }),
        }
      );

    if (
      !confirmation.ok ||
      !confirmation.data?.ok
    ) {
      return res
        .status(
          confirmation.status ||
          500
        )
        .json({
          ok: false,

          error:
            cleanString(
              confirmation.data
                ?.error
            ) ||
            cleanString(
              confirmation.data
                ?.message
            ) ||
            "Could not confirm the appointment.",

          upstream:
            confirmation.data,
        });
    }

    return res
      .status(200)
      .json({
        ...confirmation.data,

        ok: true,

        property_manager_name:
          propertyManagerName,

        authorized_entry:
          authorizedEntry,
      });
  } catch (error) {
    console.error(
      "pm-scheduling error:",
      error
    );

    return res
      .status(500)
      .json({
        ok: false,
        error:
          "Server error",

        message:
          error?.message ||
          String(error),
      });
  }
}
