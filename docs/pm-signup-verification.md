# PM signup verification setup

Configure before merging/deploying this change. The PM signup endpoint rejects submissions when verification is not configured or unavailable.

1. In Cloudflare Turnstile, create a Managed widget for dryerdudes.com and www.dryerdudes.com. Hosting/DNS can remain on Vercel.
2. In Vercel project dryerdudes-site, add TURNSTILE_SITE_KEY (public site key) and TURNSTILE_SECRET_KEY (secret, server only) to Production. Never commit the secret or paste it into a public issue.
3. To test a preview, add its exact hostname to the widget's allowed hostnames and set the keys in Preview, plus TURNSTILE_ALLOWED_HOSTNAMES as a comma-separated list of allowed production and preview hostnames. Avoid wildcard preview domains and do not use production test/bypass keys.
4. Redeploy after setting environment variables. The form fetches only the public site key, renders Turnstile with action pm_signup, and resets the token after each submission attempt. The server verifies the token, action and allowed hostname before saving anything.
5. Submit one clearly labeled test request. Confirm it appears once in the admin portal and the owner email arrives. Reject the test through the admin portal; do not activate it.

Validation: 13 mocked server scenarios passed, including missing/malformed/oversized tokens, expired or replayed tokens rejected by Siteverify, wrong hostname/action, provider failures, missing configuration and secret-free public configuration. Inline browser JS parses and git diff --check passes. Live widget and end-to-end email delivery still need verification after account setup.

Turnstile is a bot barrier, not an absolute volume cap. A Vercel Firewall per-IP rate limit scoped only to POST /api/request-property-manager-setup is an additional layer to consider (for example, 5 requests per 10 minutes). Do not apply that limit to bookings or tenant scheduling.
