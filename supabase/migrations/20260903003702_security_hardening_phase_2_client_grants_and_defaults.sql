-- Preserve business rows. Only privileges, policy role scope and function settings change.
-- Keep anonymous availability reads separate from the authenticated administrator policy.
alter policy schedule_slots_admin_all on public.schedule_slots to authenticated;

-- The checked-in tech/admin clients read these tables, but mutations use authenticated
-- server endpoints with service-role credentials. Prevent bypassing those endpoints.
revoke insert, update, delete on table public.bookings, public.booking_requests from authenticated;
revoke all on table public.profiles, public.techs, public.tech_time_off, public.job_parts from anon;

-- Row-level security does not protect TRUNCATE. Browser/API roles must never have
-- destructive maintenance or schema-related privileges on application tables.
do $block$
declare v_table record;
begin
  for v_table in
    select n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relowner = 'postgres'::regrole
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
      )
  loop
    execute format(
      'revoke truncate, references, trigger, maintain on table %I.%I from public, anon, authenticated',
      v_table.nspname, v_table.relname
    );
  end loop;
end
$block$;

-- This helper is only called inside the two administrator-guarded definer RPCs.
revoke all on function public.tech_time_off_blocks_slot(uuid,date,integer,timestamptz,timestamptz)
  from public, anon, authenticated;
grant execute on function public.tech_time_off_blocks_slot(uuid,date,integer,timestamptz,timestamptz)
  to service_role;

-- Keep existing trusted namespaces available to legacy unqualified PostGIS references,
-- explicitly placing temporary schemas last. public/auth are not client-writable.
do $block$
declare v_function record;
begin
  for v_function in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as identity_args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proowner = 'postgres'::regrole and p.prokind = 'f'
      and exists (
        select 1 from unnest(p.proconfig) setting
        where setting like 'search_path=%public%' and setting not like '%pg_temp%'
      )
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = pg_catalog, public, auth, pg_temp',
      v_function.nspname, v_function.proname, v_function.identity_args
    );
  end loop;
end
$block$;

-- Future application objects created by postgres must receive deliberate client grants.
-- This does not change existing object access or Supabase-managed owners' defaults.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

notify pgrst, 'reload schema';
