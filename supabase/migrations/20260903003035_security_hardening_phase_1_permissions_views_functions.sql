-- Dryer Dudes security hardening, phase 1.
-- DDL and privileges only: this migration does not update or delete booking or slot rows.

-- 1. Remove the obsolete anonymous booking insertion path.
-- Production bookings are finalized server-side with the service role.
drop policy if exists "public can create bookings" on public.bookings;
revoke all on table public.bookings from anon;
revoke all on table public.booking_requests from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.schedule_slots from anon;

-- 2. Move historical backup tables out of the PostgREST-exposed public schema.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'slot_blocks_backup',
    'schedule_slots_backup',
    'booking_request_offers_backup_20260304',
    'bookings_backup_20260304',
    'zones_backup'
  ]
  loop
    if to_regclass(format('public.%I', v_table)) is not null then
      execute format('alter table public.%I set schema private', v_table);
    end if;
  end loop;
end
$block$;

revoke all on all tables in schema private from public, anon, authenticated;
grant all on all tables in schema private to service_role;

-- 3. Protect internal application tables that should only be reached through
-- server endpoints or tightly scoped RPCs. Explicit admin-only policies document
-- intent, while direct client table grants remain revoked.
do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'admin_new_booking_alerts',
    'booking_billing',
    'booking_customer_actions',
    'booking_events',
    'booking_failure_events',
    'booking_request_followup_log',
    'booking_request_offers',
    'job_help_requests',
    'property_manager_requests',
    'slot_templates',
    'sms_reminder_log',
    'zone_tech_assignments',
    'slot_blocks',
    'zones',
    'territories',
    'tech_work_patterns'
  ]
  loop
    if to_regclass(format('public.%I', v_table)) is not null then
      execute format('alter table public.%I enable row level security', v_table);
      execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
      execute format('grant all on table public.%I to service_role', v_table);

      if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = v_table
          and policyname = 'admin_only'
      ) then
        execute format(
          'create policy admin_only on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
          v_table
        );
      end if;
    end if;
  end loop;
end
$block$;

-- The btree_gist extension is relocatable and belongs in the existing extensions schema.
alter extension btree_gist set schema extensions;

-- 4. Views must use the querying role's permissions/RLS, not the view owner's.
alter view public.v_checkout_slot_validation set (security_invoker = true);
alter view public.v_booking_offers_expanded set (security_invoker = true);

revoke all on table public.v_checkout_slot_validation from public, anon, authenticated;
revoke all on table public.v_booking_offers_expanded from public, anon, authenticated;
grant select on table public.v_checkout_slot_validation to service_role;
grant select on table public.v_booking_offers_expanded to service_role;

-- 5. Pin search paths on the functions identified by the Security Advisor.
do $block$
declare
  v_function record;
begin
  for v_function in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as identity_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname = any(array[
        'mark_schedule_slot_booked',
        'set_booking_slot_code',
        'bookings_block_if_tech_off',
        'deactivate_offers_for_booked_slot',
        'get_zone_for_point',
        'sync_bookings_route_zone',
        'cleanup_old_booking_requests',
        'create_slot_blocks_for_time_off',
        'populate_schedule_slots',
        'bookings_set_tech',
        'is_tech',
        'verify_offer_for_checkout',
        'handle_new_user',
        'sync_booking_requests_zone',
        'get_zone_for_lonlat',
        'resolve_zone',
        'get_bookable_offers',
        'sync_booking_request_offers_zone'
      ])
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = pg_catalog, public, auth',
      v_function.nspname,
      v_function.proname,
      v_function.identity_args
    );
  end loop;
end
$block$;

-- 6. Server-only RPCs: callable only by the service role (and their owner).
do $block$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.finalize_paid_booking(text,text,text,integer,text,text,text)',
    'public.schedule_return_visit(text,uuid)',
    'public.verify_offer_for_checkout(text)',
    'public.get_bookable_offers(uuid)',
    'public.cleanup_old_booking_requests(integer)',
    'public.populate_schedule_slots(date,integer)',
    'public.create_my_property_manager_request(text,text,text,text,text,integer,boolean)',
    'public.get_zone_for_point(double precision,double precision)',
    'public.get_zone_for_lonlat(double precision,double precision)',
    'public.resolve_zone(double precision,double precision)'
  ]
  loop
    if to_regprocedure(v_signature) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', v_signature);
      execute format('grant execute on function %s to service_role', v_signature);
    end if;
  end loop;
end
$block$;

-- 7. Trigger-only functions must not be directly callable through PostgREST.
do $block$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.mark_schedule_slot_booked()',
    'public.set_booking_slot_code()',
    'public.bookings_block_if_tech_off()',
    'public.deactivate_offers_for_booked_slot()',
    'public.sync_bookings_route_zone()',
    'public.create_slot_blocks_for_time_off()',
    'public.bookings_set_tech()',
    'public.handle_new_user()',
    'public.sync_booking_requests_zone()',
    'public.sync_booking_request_offers_zone()',
    'public.normalize_booking_window_from_slot()',
    'public.set_booking_pm_ownership_from_request()',
    'public.tech_time_off_sync_schedule_slots()'
  ]
  loop
    if to_regprocedure(v_signature) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', v_signature);
      execute format('grant execute on function %s to service_role', v_signature);
    end if;
  end loop;
end
$block$;

-- 8. Authenticated-only helper/RPC functions must not be callable anonymously.
do $block$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.get_my_property_manager_jobs()',
    'public.get_my_property_manager_profile()',
    'public.is_admin()',
    'public.tech_time_off_blocks_slot(uuid,date,integer,timestamp with time zone,timestamp with time zone)'
  ]
  loop
    if to_regprocedure(v_signature) is not null then
      execute format('revoke all on function %s from public, anon', v_signature);
      execute format('grant execute on function %s to authenticated, service_role', v_signature);
    end if;
  end loop;
end
$block$;

-- Preserve the auth trigger's internal execution path while preventing API calls.
do $block$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and to_regprocedure('public.handle_new_user()') is not null then
    grant execute on function public.handle_new_user() to supabase_auth_admin;
  end if;
end
$block$;
