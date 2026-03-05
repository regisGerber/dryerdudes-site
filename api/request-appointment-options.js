function isTruthy(v) {
  return v === true || v === "true" || v === "on" || v === 1 || v === "1";
}

function getOrigin(req) {
  const envOrigin = String(process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
  if (envOrigin) return envOrigin;

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;

  return `${proto}://${host}`;
}

function makeReqId() {
  return `rao_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok:false,error:"Method Not Allowed"});
  }

  const reqId = makeReqId();

  try {

    const b = req.body || {};

    const name = String(b.customer_name || b.name || "").trim();
    const phone = String(b.phone || "").trim();
    const email = String(b.email || "").trim();

    const address_line1 = String(b.address_line1 || "").trim();
    const city = String(b.city || "").trim();
    const state = String(b.state || "").trim();
    const zip = String(b.zip || "").trim();

    const address = [address_line1,city,state,zip].filter(Boolean).join(", ");

    const homeAdult = isTruthy(b.home_adult);
    const homeNoOne = isTruthy(b.home_noone);

    let appointment_type = "standard";

    if (homeNoOne) appointment_type = "no_one_home";
    if (isTruthy(b.full_service)) appointment_type = "full_service";

    const origin = getOrigin(req);

    const forwardPayload = {
      name,
      phone,
      email,
      contact_method: b.contact_method || "email",
      address,
      appointment_type,
    };

    const forwardResp = await fetch(`${origin}/api/request-times`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify(forwardPayload)
    });

    const data = await forwardResp.json();

    if (!forwardResp.ok) {
      return res.status(500).json({
        ok:false,
        reqId,
        upstream:data
      });
    }

    return res.json({
      ...data,
      reqId
    });

  } catch (err) {

    return res.status(500).json({
      ok:false,
      error:"Server error",
      message:err.message,
      reqId
    });

  }
}
