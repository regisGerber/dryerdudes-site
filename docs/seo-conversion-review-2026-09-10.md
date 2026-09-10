# SEO and booking conversion review — 2026-09-10

## Scope

This is a review branch, not a statement that production or Google Ads settings have been changed. No database migrations, booking writes, schedule changes, checkout creation changes, webhook changes, reminder changes, ad-budget changes, or customer communications are included.

## Changes

- Replace the success page's unconditional $1 conversion with a hook after booking confirmation and a separate read-only Stripe Checkout verification endpoint.
- Measure the initial amount paid at checkout; later parts invoices, profit, and later refunds are NOT included. Refund adjustments and offline revenue reconciliation remain separate work.
- Include a stable per-payment, non-customer transaction identifier, suppress repeated calls within a page, and suppress production conversions on preview hosts. Google-side deduplication and receipt still require Tag Assistant verification.
- Keep session credentials and job references out of the success-page analytics URL. Return only measurement fields, not customer data, from the new endpoint.
- Add noindex and same-origin referrer handling to the success page.
- Add a homepage H1, canonical URL, consistent local service markup, and clearer price/service-area messaging.
- Move the existing booking form before About/How content; preserve form names, option values, required permissions, and external booking scripts. Add accessible label associations and autofill hints.
- Remove the unsupported 'Most customers choose this option' assertion; preserve the optional $20 add-on.
- Retain all 10 marketing sitemap URLs and omit modification dates that were not verified.

## Automated checks performed

`node --test tests/marketing-conversion.test.cjs`

32 mocked unit tests passed. They cover paid $80/$100 bookings, unpaid and test sessions, unrelated sessions, invalid inputs, read-only upstream requests, duplicate calls, excluded booking statuses, preview suppression, and tracking outages. Static HTML/JSON checks passed; uploaded homepage and success-page blob hashes match the tested local files.

These tests do not prove Google received an event or that the full live checkout works. Browser navigation was blocked by the execution environment. The Vercel connector denied project access. No live payment, email, SMS, booking, or tracking event was generated for testing.

## Release gates still required

1. Inspect the preview with the existing styles, images, Maps autocomplete, and booking scripts on mobile and desktop. Test normal and authorized-entry form behavior, validation, appointment offers, and the existing checkout path in an isolated staging setup without messaging real customers.
2. Verify the Vercel build and the existing Stripe secret's availability to the new read-only endpoint; never print secrets. Check that project firewall rules allow legitimate measurement requests and enforce suitable abuse controls.
3. In Google Ads, confirm the existing tag destination is active, the paid-booking goal is primary, and other page-view/codeless/imported goals do not duplicate it. Audit any legacy success-page URL rules rather than assuming their current settings.
4. After approved deployment, verify the actual conversion value, unique transaction identifier, privacy-safe URL, and Google receipt in Tag Assistant. Reopening a bare success URL must not fire a purchase. Conversion failures must not block confirmation.
5. Verify the production canonical, success-page noindex, and sitemap response. Review indexing and search performance in Search Console; no ranking or conversion improvement is guaranteed.

## References

- https://support.google.com/google-ads/answer/6386790
- https://support.google.com/google-ads/answer/16560108
- https://docs.stripe.com/api/checkout/sessions/retrieve
- https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
