// --- ZONE LOOKUP (call Supabase RPC directly) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars" });
}

const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/get_zone_for_lonlat`;

const rpcBody = {
  p_lon: parseFloat(lon),
  p_lat: parseFloat(lat),
};

const zoneResp = await fetch(rpcUrl, {
  method: "POST",
  headers: {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(rpcBody),
});

const zoneData = await zoneResp.json();

// If your RPC returns a row like { zone_code, zone_name }:
let zone_code = null;
let zone_name = null;

if (zoneResp.ok && zoneData) {
  // Depending on your RPC return type, it might be object or array.
  const row = Array.isArray(zoneData) ? zoneData[0] : zoneData;
  zone_code = row?.zone_code ?? null;
  zone_name = row?.zone_name ?? null;
}
