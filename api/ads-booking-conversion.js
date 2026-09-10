// Read-only measurement endpoint. Never creates a booking, charge, or database write.
const { createHash } = require('node:crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  // Accept only same-origin browser requests; never return customer or payment credentials.
  const origin = req.headers?.origin;
  const allowedOrigins = ['https://www.dryerdudes.com', 'https://dryerdudes.com'];
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ ok: false, error: 'forbidden_origin' });
  }
  const sessionId = req.body?.session_id;
  if (typeof sessionId !== 'string' || !/^cs_live_[A-Za-z0-9]{16,240}$/.test(sessionId)) {
    return res.status(400).json({ ok: false, error: 'invalid_session' });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'measurement_unavailable' });

  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const status = [400, 404].includes(response.status) ? 404 : 503;
      return res.status(status).json({ ok: false, error: 'measurement_unavailable' });
    }
    const session = await response.json();
    const meta = session.metadata || {};
    let expectedSuccessUrl = false;
    try {
      const url = new URL(session.success_url);
      expectedSuccessUrl = allowedOrigins.includes(url.origin) && url.pathname === '/payment-success.html';
    } catch { /* Not one of this site's booking sessions. */ }
    const jobRef = meta.job_ref || meta.jobRef;
    const eligible = session.id === sessionId && session.livemode === true &&
      session.mode === 'payment' && session.status === 'complete' && session.payment_status === 'paid' &&
      session.currency === 'usd' && Number.isSafeInteger(session.amount_total) && session.amount_total > 0 &&
      typeof meta.offer_token === 'string' && meta.offer_token.length > 0 &&
      ['standard', 'full_service'].includes(meta.appointment_type) &&
      typeof jobRef === 'string' && /^DD-\d{6}$/.test(jobRef) && session.client_reference_id === jobRef &&
      expectedSuccessUrl;
    if (!eligible) return res.status(200).json({ ok: true, eligible: false });

    return res.status(200).json({
      ok: true,
      eligible: true,
      // Send a stable, non-identifying, 64-character ID, not the bearer-like session ID.
      transaction_id: createHash('sha256').update(`dryerdudes:booking:${session.id}`).digest('hex'),
      value: session.amount_total / 100,
      currency: 'USD',
    });
  } catch {
    // Tracking failure must never interfere with booking confirmation or leak upstream details.
    return res.status(503).json({ ok: false, error: 'measurement_unavailable' });
  }
};
