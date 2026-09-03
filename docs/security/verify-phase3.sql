-- Read-only metadata assertions for Supabase hardening phase 3.
-- Safe to run in the SQL editor. This script does not create, update, or delete business rows.

do $verify$
declare
  v_count integer;
begin
  -- Exposed application entry points must be invoker functions.
  select count(*)
  into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = any(array[
      'is_admin',
      'get_my_property_manager_jobs',
      'get_my_property_manager_profile',
      'apply_time_off_to_offers',
      'set_offers_active_for_slot'
    ])
    and p.prosecdef = true;

  if v_count <> 0 then
    raise exception 'Phase 3 failed: an exposed application wrapper is still SECURITY DEFINER';
  end if;

  if has_table_privilege('anon', 'public.schedule_slots', 'SELECT') then
    raise exception 'Phase 3 failed: anon still has raw schedule_slots SELECT';
  end if;

  if has_table_privilege('anon', 'public.bookings', 'SELECT') then
    raise exception 'Phase 3 failed: anon can read bookings';
  end if;

  if has_table_privilege('anon', 'public.booking_requests', 'SELECT') then
    raise exception 'Phase 3 failed: anon can read booking_requests';
  end if;

  if has_function_privilege('anon', 'public.is_admin()', 'EXECUTE') then
    raise exception 'Phase 3 failed: anon can execute is_admin';
  end if;

  if has_function_privilege('anon', 'public.get_my_property_manager_jobs()', 'EXECUTE') then
    raise exception 'Phase 3 failed: anon can execute PM jobs RPC';
  end if;

  if has_schema_privilege('anon', 'app_private', 'USAGE') then
    raise exception 'Phase 3 failed: anon can use app_private';
  end if;

  -- Covering indexes added for the six foreign keys flagged before phase 3.
  select count(*)
  into v_count
  from pg_class i
  join pg_namespace n on n.oid = i.relnamespace
  where n.nspname = 'public'
    and i.relkind = 'i'
    and i.relname = any(array[
      'booking_billing_request_id_idx',
      'booking_customer_actions_request_id_idx',
      'booking_request_offers_slot_id_idx',
      'bookings_tech_id_idx',
      'job_help_requests_request_id_idx',
      'schedule_slots_territory_id_idx'
    ]);

  if v_count <> 6 then
    raise exception 'Phase 3 failed: expected six covering indexes, found %', v_count;
  end if;

  -- Confirm the redundant indexes/constraint removed by phase 3 did not return.
  select count(*)
  into v_count
  from pg_class i
  join pg_namespace n on n.oid = i.relnamespace
  where n.nspname = 'public'
    and i.relname = any(array[
      'booking_request_offers_request_id_idx',
      'uniq_booking_request_offers_token',
      'booking_requests_created_idx',
      'idx_bookings_window_start',
      'ix_bookings_window_start',
      'zones_zone_code_uniq'
    ]);

  if v_count <> 0 then
    raise exception 'Phase 3 failed: one or more removed duplicate indexes returned';
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_user_id_key'
  ) then
    raise exception 'Phase 3 failed: duplicate profiles unique constraint returned';
  end if;
end
$verify$;

select 'PASS: Supabase hardening phase 3 metadata assertions' as result;
