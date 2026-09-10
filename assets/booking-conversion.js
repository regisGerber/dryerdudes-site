/* Called only after the existing booking-status endpoint confirms an appointment. */
(function () {
  'use strict';
  let inFlight = false;
  let recorded = false;
  const activeStatuses = new Set(['scheduled', 'en_route', 'on_site', 'billing_pending', 'awaiting_payment', 'parts_approval_needed', 'parts_on_order', 'completed']);
  window.ddTrackConfirmedBooking = async function (booking) {
    if (inFlight || recorded || !booking || !activeStatuses.has(booking.booking_status)) return;
    // Preview visits and tests must not create production Ads conversions.
    if (!['www.dryerdudes.com', 'dryerdudes.com'].includes(window.location.hostname)) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id') || params.get('sessionId') || params.get('stripe_session_id') || params.get('checkout_session_id') || '';
    if (!/^cs_live_[A-Za-z0-9]{16,240}$/.test(sessionId)) return;
    inFlight = true;
    try {
      const response = await fetch('/api/ads-booking-conversion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ session_id: sessionId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return;
      const result = await response.json();
      if (!result.ok || !result.eligible || !/^[a-f0-9]{64}$/.test(result.transaction_id) ||
          !Number.isFinite(result.value) || result.value <= 0 || result.currency !== 'USD' ||
          typeof window.gtag !== 'function') return;
      // Google deduplicates revisits using the stable transaction ID. Do not permanently
      // suppress retries using localStorage: an ad blocker may have prevented delivery.
      window.gtag('event', 'conversion', {
        send_to: 'AW-17020127642/UcynCN2u9L0cEJqT6rM_',
        value: result.value,
        currency: result.currency,
        transaction_id: result.transaction_id,
        page_location: 'https://www.dryerdudes.com/payment-success.html',
        page_referrer: '',
      });
      recorded = true;
    } catch { /* Measurement is non-blocking; customer confirmation still works. */ }
    finally { inFlight = false; }
  };
})();
