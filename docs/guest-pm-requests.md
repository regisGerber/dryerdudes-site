# One-time property management requests

`pm-request.html` is linked from the existing property management page. It collects the billing party separately from tenant scheduling contacts. The manager must confirm an emailed, 24-hour verification link before tenant notifications or job creation.

The guest APIs use the existing server environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_SIGNING_SECRET`, `RESEND_API_KEY`, `SITE_ORIGIN`, and the existing Twilio / Google scheduling configuration. No additional provider is required.

The applied database migration allows a property manager billing contact without a login and adds a server-only authorization table with RLS and no browser grants. Raw verification tokens are never stored. Verification uses a POST review step followed by an explicit confirmation; email scanners cannot authorize work by opening the page. An atomic pending-to-processing transition prevents duplicate job creation. Ambiguous failures are not automatically retried.

Confirmed requests reuse `handlePmRequest`, the existing PM scheduling link, tenant email/text, authorized entry, appointment options, approval limits, and PM billing notices. Guest submissions never modify a portal account. Subsequent portal-access requests still follow existing owner approval; earlier guest jobs are not automatically imported into a new portal account.

Guest billing uses the existing Stripe secret key and signed checkout.session.completed webhook. When the technician submits billing, a versioned, itemized secure email link goes to the verified manager. Costs exceeding the approval limit require an explicit approval before checkout. Payment is a one-time card charge for the remaining balance; approval alone does not charge a card. Guest cards are not saved for future use.

The server-only pm_guest_bills table stores current bill snapshots. Revised bills invalidate earlier links and expire old unpaid checkout sessions. Transactional database functions record approval and settlement. Duplicate Stripe notifications do not increase collected funds twice. The bill page also reconciles directly against Stripe on return. Completion receipts go to the billing manager; tenants receive a completion notice without billing amounts. Support is info@dryerdudes.com.

If bill email delivery fails, the technician sees the secure manager link to share with the billing contact. Paid bills cannot be resubmitted as new charges. Links expire after 60 days; support can revise an unpaid bill to issue a fresh link. Declined repairs remain paused until the bill is revised.

Validation: 57 Node tests pass, covering guest requests, authentication, signed bill revisions, approval gating, exact Stripe amounts, checkout reuse, stale sessions, and settlement validation. Approval and duplicate payment settlement were also exercised against the database inside a rolled-back transaction. No real payment or test message was sent.
