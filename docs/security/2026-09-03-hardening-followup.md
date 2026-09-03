# Supabase security/performance hardening follow-up

Audit date: September 3, 2026 (Pacific); migration timestamp uses UTC.

## Deployment status

**The phase 3 migration described here is already applied to the live Dryer Dudes Supabase project.** This GitHub branch records the exact SQL for version control. Merging this documentation does not apply the migration again, and reverting the GitHub commit would not reverse the live database changes.

No application HTML or JavaScript was changed. The migration changes database functions, RLS policies, grants, and indexes only. It does not contain booking, request, or schedule-slot data updates.

## Files

- `supabase/migrations/20260903195054_security_hardening_phase_3_wrappers_rls_performance.sql`
- `docs/security/2026-09-03-hardening-followup.md`
- `docs/security/verify-phase3.sql`

## Changes by advisor finding

| Advisor area | Database objects changed | Action |
|---|---|---|
| Exposed `SECURITY DEFINER` application functions | `is_admin`, `get_my_property_manager_jobs`, `get_my_property_manager_profile`, `apply_time_off_to_offers`, `set_offers_active_for_slot` | Privileged implementations moved to the unexposed `app_private` schema. Existing public signatures remain as `SECURITY INVOKER` wrappers so the current PM/admin portals continue to work without a frontend code change. |
| Duplicate and per-row RLS evaluation | `profiles`, `bookings`, `booking_requests`, `job_parts`, `tech_time_off`, `techs`, `property_managers`, `schedule_slots`, and internal `admin_only` policies | Consolidated overlapping policies and wrapped `auth.uid()` / administrator checks in scalar subqueries so they are initialized once per statement. |
| Raw anonymous slot-table access | `schedule_slots` | Removed anonymous table access. Public booking and return-visit pages already use server endpoints with service-role credentials rather than querying the raw table from a browser. |
| Unindexed foreign keys | `booking_billing.request_id`, `booking_customer_actions.request_id`, `booking_request_offers.slot_id`, `bookings.tech_id`, `job_help_requests.request_id`, `schedule_slots.territory_id` | Added covering indexes. |
| Duplicate indexes | `booking_request_offers`, `booking_requests`, `bookings`, `profiles`, `zones` | Removed only confirmed duplicates while preserving the constraint-backed or primary index in each set. |

## Verification completed

- Full-table fingerprints of `bookings`, `booking_requests`, and `schedule_slots` matched before and after phase 3.
- The owner's protected real booking, linked request, and reserved schedule slot matched their pre-migration fingerprints.
- The public application functions listed above are now `SECURITY INVOKER` wrappers.
- An authenticated administrator can still read the protected booking/request/slot and retains access to the two administrator time-off wrapper functions.
- The assigned technician can still read the assigned booking and linked customer request.
- The property-manager account can still load its profile and job list and cannot see the unrelated protected booking/request.
- Anonymous access to bookings, requests, raw schedule slots, PM RPCs, `is_admin`, and the `app_private` schema is denied.
- Security Advisor application-owned definer warnings were cleared.
- Performance Advisor now reports zero WARN-level findings. The unindexed-FK, RLS init-plan, multiple-policy, and duplicate-index findings were cleared.

No live checkout, Stripe charge, customer notification, new appointment, time-off mutation, or return-visit booking was performed as a test.

## Findings intentionally still open

### Supabase-managed PostGIS objects

The remaining security ERROR and six of the remaining warnings concern `public.spatial_ref_sys`, the `postgis` extension, and three `st_estimatedextent` overloads. Those objects are owned by Supabase's managed `supabase_admin` role. The project migration role is not a member of that role and cannot safely alter the objects or their grants.

Do not drop/reinstall PostGIS on the live project merely to clear the dashboard. Service-area geometry depends on it. Ask Supabase Support to move the extension to an unexposed schema and correct the managed table/function grants without dropping dependent geometry data.

### Leaked-password protection

One warning remains because leaked-password protection is disabled. Supabase documents this feature as available on the Pro plan and above. The project is currently on the Free plan; clearing that warning requires a plan upgrade and enabling the setting in Auth configuration.

### Performance INFO notices

The remaining Performance Advisor items are informational, primarily:

- private historical backup tables without primary keys;
- indexes with no recorded use yet in this low-volume/new database.

The backup tables are not application-facing, and adding artificial keys provides no operational benefit. Newly created foreign-key indexes can initially appear unused until representative traffic exercises them. Existing unused indexes should be observed under real traffic before removal rather than deleted solely to make the advisor list empty.

## Rollback guidance

A GitHub revert alone does not change the live database. Any rollback must be a reviewed follow-up migration. Do not restore duplicate policies, anonymous schedule-table access, or exposed privileged implementations. For an access regression, identify the affected role and endpoint and restore only the minimum required permission.
