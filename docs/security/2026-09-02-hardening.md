# Dryer Dudes — applied Supabase security changes

Audit date: September 2, 2026 (Pacific); migration timestamps use UTC.
Application reference inspected: `restor` at `ff85423b80700195854c1311960ed55a52c28a98`.

## Deployment status

**The database changes below are already applied in Supabase.** This GitHub change records them; merging this documentation does not apply them again. Reverting this pull request does not reverse live database permissions.

No production HTML, JavaScript, scheduling algorithm, payment configuration, or customer-message template was changed during this database-hardening pass. No booking, request, or schedule-slot row was intentionally inserted, updated, or deleted. The real active booking identified privately by the owner was verified separately; its reference and customer details are intentionally omitted from this public repository.

These migrations target the existing application database. They are not a complete initial schema and must not be used alone to rebuild or reset a project.

## Changes and files

| Area | Database objects / action | Record |
|---|---|---|
| Anonymous booking creation | Removed the obsolete unrestricted anonymous INSERT policy on `public.bookings`; removed anonymous table access to `bookings` and `booking_requests`. | Phase 1 migration |
| Sensitive views | `v_checkout_slot_validation` and `v_booking_offers_expanded` now use `security_invoker=true`; only the service role has direct view access. | Phase 1 migration |
| Historical backups | Moved `slot_blocks_backup`, `schedule_slots_backup`, `booking_request_offers_backup_20260304`, `bookings_backup_20260304`, and `zones_backup` from `public` to `private`. Revoked client schema/table access; retained service-role access. No backup rows were deleted. | Phase 1 migration |
| Internal tables | Enabled RLS where missing, revoked direct client table privileges, and added explicit `admin_only` policies to the 16 internal tables listed below. Existing deny-all tables were not opened to ordinary users. | Phase 1 migration |
| Database function execution | Restricted payment-finalization, return-visit, internal scheduling/geographic RPCs, and trigger functions to appropriate server roles. Preserved the authenticated PM and administrator RPC entry points required by the current portal. | Phase 1 migration; Phase 2 further restricts the internal time-off helper |
| Extension housekeeping | Moved the relocatable `btree_gist` extension to `extensions`; did not remove it or drop its dependencies. | Phase 1 migration |
| Browser writes and maintenance | Removed direct authenticated INSERT/UPDATE/DELETE on `bookings` and `booking_requests`; the existing authenticated server endpoints remain the write path. Removed TRUNCATE/REFERENCES/TRIGGER/MAINTAIN privileges from browser roles on application-owned public tables. | Phase 2 migration |
| Availability policy scope | Limited `schedule_slots_admin_all` to `authenticated`, preserving the existing separate anonymous available-slot read policy without requiring an anonymous `is_admin()` call. | Phase 2 migration |
| Search-path safety | Fixed the 18 initially flagged function search paths. Phase 2 puts `pg_temp` last for application-owned functions using the public namespace; existing empty paths remain unchanged. No untrusted role can CREATE in the trusted namespaces. | Both migrations |
| Future object defaults | New public tables, sequences and functions created by `postgres` no longer automatically grant access to anonymous/authenticated clients. Future migrations must grant intentional client access explicitly. Service-role defaults remain. | Phase 2 migration |

### Exact migration records

- `supabase/migrations/20260903003035_security_hardening_phase_1_permissions_views_functions.sql`
- `supabase/migrations/20260903003702_security_hardening_phase_2_client_grants_and_defaults.sql`

The authoritative deployed statements are also retained in `supabase_migrations.schema_migrations` under those version numbers.

### Internal tables covered

`admin_new_booking_alerts`, `booking_billing`, `booking_customer_actions`, `booking_events`, `booking_failure_events`, `booking_request_followup_log`, `booking_request_offers`, `job_help_requests`, `property_manager_requests`, `slot_templates`, `sms_reminder_log`, `zone_tech_assignments`, `slot_blocks`, `zones`, `territories`, `tech_work_patterns`.

An `admin_only` policy does not itself grant table access. These internal tables remain directly accessible to the server/service role, not to ordinary browser clients.

## Verification completed

- Compared the protected booking's status, payment, service selection, technician assignment, appointment window, request link, and reserved slot against the pre-migration snapshot.
- Compared full-table fingerprints of `bookings`, `booking_requests`, and `schedule_slots` before and after phase 2: all matched.
- Simulated authenticated administrator, assigned technician, and property-manager roles in read-only database transactions. Administrator and assigned technician can still see the protected booking; the unrelated PM cannot.
- Tested both PM read RPCs under the PM identity; they still return that account's records and do not expose the protected unrelated booking.
- Confirmed non-admin identities are rejected by both administrator time-off RPC guards.
- Confirmed anonymous clients cannot read bookings/requests/offer-token views or call the payment finalizer, while their existing available-slot read still works.
- Confirmed the backend/service role can read required tables/views, validate a saved offer, and execute the payment and return-visit functions.
- Executed an in-area and out-of-area geographic lookup under the service role; both behaved as expected.
- Checked that the job-photo bucket remains private and the existing profile-role escalation guard remains installed.
- Reran the Security Advisor. Remaining findings and provider/account follow-up are described in the private owner handoff, not this public repository.

These are database permission and read-path tests, not a live browser checkout, Stripe charge, or new customer appointment. No real payment or notification was sent as a test. No full database backup or restore was performed; the backup tables listed above predated this work.

## Regression checks and rollback

`docs/security/verify-hardening.sql` contains read-only permission checks for the SQL editor. It is not a migration and does not create or change jobs.

For an access regression, identify the failing endpoint and the exact role/object first. Use a narrowly scoped corrective migration instead of restoring broad grants or disabling RLS. Keep backend service-role access, PM account isolation, and the protected booking intact. Never add the service-role key to a browser file. Do not run a database reset or restore just to undo a permission change.

Changing source-control history alone does not undo the already-applied Supabase migrations. An actual rollback requires reviewed database DDL. In particular, restoring the old anonymous booking policy or public offer-token view would reopen vulnerabilities.

## References

- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/database/functions
- https://www.postgresql.org/docs/17/ddl-rowsecurity.html
- https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY
