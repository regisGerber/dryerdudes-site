# One-time property management requests

`pm-request.html` is linked from the existing property management page. It collects the billing party separately from tenant scheduling contacts. The manager must confirm an emailed, 24-hour verification link before tenant notifications or job creation.

The guest APIs use the existing server environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_SIGNING_SECRET`, `RESEND_API_KEY`, `SITE_ORIGIN`, and the existing Twilio / Google scheduling configuration. No additional provider is required.

The applied database migration allows a property manager billing contact without a login and adds a server-only authorization table with RLS and no browser grants. Raw verification tokens are never stored. Verification uses a POST review step followed by an explicit confirmation; email scanners cannot authorize work by opening the page. An atomic pending-to-processing transition prevents duplicate job creation. Ambiguous failures are not automatically retried.

Confirmed requests reuse `handlePmRequest`, the existing PM scheduling link, tenant email/text, authorized entry, appointment options, approval limits, and PM billing notices. Guest submissions never modify a portal account. Subsequent portal-access requests still follow existing owner approval; earlier guest jobs are not automatically imported into a new portal account.

Validation: 42 Node tests pass, including guest validation, email-only initial delivery, token privacy, expiry, replay/concurrent confirmation, existing PM authentication, and a mocked full guest-to-scheduling flow. Database RLS/grants verified directly. Browser QA and live delivery verification remain release checks if runtime/browser/deployment access is unavailable. Do not send test requests to real tenants.
