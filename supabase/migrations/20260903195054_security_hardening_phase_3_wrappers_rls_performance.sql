-- Dryer Dudes security/performance hardening, phase 3.
-- This migration changes functions, policies, grants, and indexes only.
-- It does not insert, update, or delete booking, request, or schedule-slot rows.

-- ---------------------------------------------------------------------------
-- 1. Put privileged implementations in an unexposed schema.
-- ---------------------------------------------------------------------------
create schema if not exists app_private authorization postgres;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to authenticated, service_role;

create or replace function app_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role = 'admin'
  );
$function$;

revoke all on function app_private.is_admin() from public, anon, authenticated;
grant execute on function app_private.is_admin() to authenticated, service_role;

-- Keep the existing public helper signature for policies and application code,
-- but make the exposed function an invoker wrapper rather than a definer function.
create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select app_private.is_admin();
$function$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

create or replace function app_private.get_my_property_manager_profile_impl()
returns table(
  id uuid,
  company_name text,
  contact_name text,
  email text,
  phone text,
  default_job_approval_limit_cents integer,
  billing_address_line_1 text,
  billing_address_line_2 text,
  billing_city text,
  billing_state text,
  billing_zip text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    pm.id,
    pm.company_name,
    pm.contact_name,
    pm.email,
    pm.phone,
    pm.default_job_approval_limit_cents,
    pm.billing_address_line_1,
    pm.billing_address_line_2,
    pm.billing_city,
    pm.billing_state,
    pm.billing_zip
  from public.property_managers pm
  join public.profiles p
    on p.user_id = pm.user_id
  where pm.user_id = auth.uid()
    and p.role = 'property_manager'
  limit 1;
$function$;

revoke all on function app_private.get_my_property_manager_profile_impl()
  from public, anon, authenticated;
grant execute on function app_private.get_my_property_manager_profile_impl()
  to authenticated, service_role;

create or replace function public.get_my_property_manager_profile()
returns table(
  id uuid,
  company_name text,
  contact_name text,
  email text,
  phone text,
  default_job_approval_limit_cents integer,
  billing_address_line_1 text,
  billing_address_line_2 text,
  billing_city text,
  billing_state text,
  billing_zip text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from app_private.get_my_property_manager_profile_impl();
$function$;

revoke all on function public.get_my_property_manager_profile() from public, anon;
grant execute on function public.get_my_property_manager_profile()
  to authenticated, service_role;

create or replace function app_private.get_my_property_manager_jobs_impl()
returns table(
  record_type text,
  request_id uuid,
  booking_id uuid,
  job_ref text,
  created_at timestamptz,
  tenant_name text,
  tenant_phone text,
  tenant_email text,
  service_address text,
  notes text,
  status text,
  appointment_type text,
  window_start timestamptz,
  window_end timestamptz,
  request_source text,
  property_manager_id uuid,
  total_job_approval_limit_cents integer,
  addon_preapproved boolean,
  authorized_entry boolean,
  scheduling_link_sent_at timestamptz,
  scheduling_link_opened_at timestamptz,
  selected_slot_at timestamptz,
  payment_status text,
  base_fee_cents integer,
  full_service_cents integer,
  collected_cents integer,
  zone_code text,
  route_zone_code text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    case
      when b.id is null then 'request'::text
      else 'booking'::text
    end as record_type,
    br.id as request_id,
    b.id as booking_id,
    b.job_ref,
    coalesce(b.created_at, br.created_at) as created_at,
    br.name as tenant_name,
    br.phone as tenant_phone,
    br.email as tenant_email,
    br.address as service_address,
    br.notes,
    case
      when b.id is not null then b.status
      when br.status = 'sent' then 'pending_scheduling'
      else br.status
    end as status,
    coalesce(b.appointment_type, br.appointment_type) as appointment_type,
    b.window_start,
    b.window_end,
    coalesce(b.request_source, br.request_source) as request_source,
    br.property_manager_id,
    br.total_job_approval_limit_cents,
    br.addon_preapproved,
    br.authorized_entry,
    br.scheduling_link_sent_at,
    br.scheduling_link_opened_at,
    br.selected_slot_at,
    b.payment_status,
    b.base_fee_cents,
    b.full_service_cents,
    b.collected_cents,
    br.zone_code,
    b.route_zone_code
  from public.property_managers pm
  join public.booking_requests br
    on br.property_manager_id = pm.id
  left join public.bookings b
    on b.request_id = br.id
  where pm.user_id = auth.uid()
  order by coalesce(b.window_start, br.created_at) desc;
$function$;

revoke all on function app_private.get_my_property_manager_jobs_impl()
  from public, anon, authenticated;
grant execute on function app_private.get_my_property_manager_jobs_impl()
  to authenticated, service_role;

create or replace function public.get_my_property_manager_jobs()
returns table(
  record_type text,
  request_id uuid,
  booking_id uuid,
  job_ref text,
  created_at timestamptz,
  tenant_name text,
  tenant_phone text,
  tenant_email text,
  service_address text,
  notes text,
  status text,
  appointment_type text,
  window_start timestamptz,
  window_end timestamptz,
  request_source text,
  property_manager_id uuid,
  total_job_approval_limit_cents integer,
  addon_preapproved boolean,
  authorized_entry boolean,
  scheduling_link_sent_at timestamptz,
  scheduling_link_opened_at timestamptz,
  selected_slot_at timestamptz,
  payment_status text,
  base_fee_cents integer,
  full_service_cents integer,
  collected_cents integer,
  zone_code text,
  route_zone_code text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from app_private.get_my_property_manager_jobs_impl();
$function$;

revoke all on function public.get_my_property_manager_jobs() from public, anon;
grant execute on function public.get_my_property_manager_jobs()
  to authenticated, service_role;

create or replace function app_private.set_offers_active_for_slot_impl(
  p_tech_id uuid,
  p_service_date date,
  p_slot_index integer,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not app_private.is_admin()
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
  then
    raise exception 'Administrator access required'
      using errcode = '42501';
  end if;

  update public.booking_request_offers bro
  set is_active = p_is_active
  from public.schedule_slots ss
  where bro.slot_id = ss.id
    and ss.tech_id = p_tech_id
    and ss.service_date = p_service_date
    and ss.slot_index = p_slot_index
    and (
      p_is_active = false
      or (
        ss.booking_id is null
        and not exists (
          select 1
          from public.bookings b
          where b.slot_id = ss.id
            and lower(coalesce(b.status, ''))
                not in ('cancelled', 'canceled', 'no_show')
        )
        and not public.tech_time_off_blocks_slot(
          ss.tech_id,
          ss.service_date,
          ss.slot_index,
          ((ss.service_date::timestamp + ss.start_time) at time zone 'America/Los_Angeles'),
          ((ss.service_date::timestamp + ss.end_time) at time zone 'America/Los_Angeles')
        )
      )
    );

  if p_is_active = false then
    update public.schedule_slots ss
    set
      is_booked = true,
      booked_at = coalesce(ss.booked_at, now())
    where ss.tech_id = p_tech_id
      and ss.service_date = p_service_date
      and ss.slot_index = p_slot_index
      and ss.booking_id is null;
  else
    update public.schedule_slots ss
    set
      is_booked = false,
      booked_at = null
    where ss.tech_id = p_tech_id
      and ss.service_date = p_service_date
      and ss.slot_index = p_slot_index
      and ss.booking_id is null
      and not exists (
        select 1
        from public.bookings b
        where b.slot_id = ss.id
          and lower(coalesce(b.status, ''))
              not in ('cancelled', 'canceled', 'no_show')
      )
      and not public.tech_time_off_blocks_slot(
        ss.tech_id,
        ss.service_date,
        ss.slot_index,
        ((ss.service_date::timestamp + ss.start_time) at time zone 'America/Los_Angeles'),
        ((ss.service_date::timestamp + ss.end_time) at time zone 'America/Los_Angeles')
      );
  end if;
end;
$function$;

revoke all on function app_private.set_offers_active_for_slot_impl(uuid,date,integer,boolean)
  from public, anon, authenticated;
grant execute on function app_private.set_offers_active_for_slot_impl(uuid,date,integer,boolean)
  to authenticated, service_role;

create or replace function public.set_offers_active_for_slot(
  p_tech_id uuid,
  p_service_date date,
  p_slot_index integer,
  p_is_active boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform app_private.set_offers_active_for_slot_impl(
    p_tech_id,
    p_service_date,
    p_slot_index,
    p_is_active
  );
end;
$function$;

revoke all on function public.set_offers_active_for_slot(uuid,date,integer,boolean)
  from public, anon;
grant execute on function public.set_offers_active_for_slot(uuid,date,integer,boolean)
  to authenticated, service_role;

create or replace function app_private.apply_time_off_to_offers_impl(
  p_tech_id uuid,
  p_start_ts timestamptz,
  p_end_ts timestamptz,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not app_private.is_admin()
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
  then
    raise exception 'Administrator access required'
      using errcode = '42501';
  end if;

  update public.booking_request_offers bro
  set is_active = p_is_active
  from public.schedule_slots ss
  where bro.slot_id = ss.id
    and ss.tech_id = p_tech_id
    and ((ss.service_date::timestamp + ss.start_time) at time zone 'America/Los_Angeles') < p_end_ts
    and ((ss.service_date::timestamp + ss.end_time) at time zone 'America/Los_Angeles') > p_start_ts
    and (
      p_is_active = false
      or (
        ss.booking_id is null
        and not exists (
          select 1
          from public.bookings b
          where b.slot_id = ss.id
            and lower(coalesce(b.status, ''))
                not in ('cancelled', 'canceled', 'no_show')
        )
        and not public.tech_time_off_blocks_slot(
          ss.tech_id,
          ss.service_date,
          ss.slot_index,
          ((ss.service_date::timestamp + ss.start_time) at time zone 'America/Los_Angeles'),
          ((ss.service_date::timestamp + ss.end_time) at time zone 'America/Los_Angeles')
        )
      )
    );

  if p_is_active = false then
    update public.schedule_slots ss
    set
      is_booked = true,
      booked_at = coalesce(ss.booked_at, now())
    where ss.tech_id = p_tech_id
      and ss.booking_id is null
      and ((ss.service_date::timestamp + ss.start_time) at time zone 'America/Los_Angeles') < p_end_ts
      and ((ss.service_date::timestamp + ss.end_time) at time zone 'America/Los_Angeles') > p_start_ts;
  else
    update public.schedule_slots ss
    set
      is_booked = false,
      booked_at = null
    where ss.tech_id = p_tech_id
      and ss.booking_id is null
      and ((ss.service_date::timestamp + ss.start_time) at time zone 'America/Los_Angeles') < p_end_ts
      and ((ss.service_date::timestamp + ss.end_time) at time zone 'America/Los_Angeles') > p_start_ts
      and not exists (
        select 1
        from public.bookings b
        where b.slot_id = ss.id
          and lower(coalesce(b.status, ''))
              not in ('cancelled', 'canceled', 'no_show')
      )
      and not public.tech_time_off_blocks_slot(
        ss.tech_id,
        ss.service_date,
        ss.slot_index,
        ((ss.service_date::timestamp + ss.start_time) at time zone 'America/Los_Angeles'),
        ((ss.service_date::timestamp + ss.end_time) at time zone 'America/Los_Angeles')
      );
  end if;
end;
$function$;

revoke all on function app_private.apply_time_off_to_offers_impl(uuid,timestamptz,timestamptz,boolean)
  from public, anon, authenticated;
grant execute on function app_private.apply_time_off_to_offers_impl(uuid,timestamptz,timestamptz,boolean)
  to authenticated, service_role;

create or replace function public.apply_time_off_to_offers(
  p_tech_id uuid,
  p_start_ts timestamptz,
  p_end_ts timestamptz,
  p_is_active boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform app_private.apply_time_off_to_offers_impl(
    p_tech_id,
    p_start_ts,
    p_end_ts,
    p_is_active
  );
end;
$function$;

revoke all on function public.apply_time_off_to_offers(uuid,timestamptz,timestamptz,boolean)
  from public, anon;
grant execute on function public.apply_time_off_to_offers(uuid,timestamptz,timestamptz,boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Consolidate RLS policies and cache auth/helper calls once per statement.
-- ---------------------------------------------------------------------------

drop policy if exists "profiles_select_self" on public.profiles;
drop policy if exists "profiles_select_self_or_admin" on public.profiles;
drop policy if exists "profiles_insert_admin_only" on public.profiles;
drop policy if exists "profiles_update_self_no_role" on public.profiles;
drop policy if exists "profiles_update_self_or_admin" on public.profiles;

create policy profiles_select_self_or_admin
on public.profiles
for select
to authenticated
using (
  (select app_private.is_admin())
  or user_id = (select auth.uid())
);

create policy profiles_insert_admin_only
on public.profiles
for insert
to authenticated
with check ((select app_private.is_admin()));

create policy profiles_update_self_or_admin
on public.profiles
for update
to authenticated
using (
  (select app_private.is_admin())
  or user_id = (select auth.uid())
)
with check (
  (select app_private.is_admin())
  or user_id = (select auth.uid())
);

drop policy if exists "Tech can view assigned bookings" on public.bookings;
drop policy if exists "bookings_select_tech_or_admin" on public.bookings;
drop policy if exists "Tech can update own bookings" on public.bookings;
drop policy if exists "bookings_update_tech_or_admin" on public.bookings;

create policy bookings_select_tech_or_admin
on public.bookings
for select
to authenticated
using (
  (select app_private.is_admin())
  or assigned_tech_id = (select auth.uid())
);

-- Browser roles no longer have UPDATE privileges on bookings; all mutations use
-- authenticated server endpoints. Do not recreate a direct-client UPDATE policy.

drop policy if exists "Tech can view related booking requests" on public.booking_requests;
drop policy if exists "booking_requests_select_for_portal" on public.booking_requests;

create policy booking_requests_select_for_portal
on public.booking_requests
for select
to authenticated
using (
  (select app_private.is_admin())
  or exists (
    select 1
    from public.bookings b
    where b.request_id = booking_requests.id
      and b.assigned_tech_id = (select auth.uid())
  )
);

drop policy if exists "job_parts_select_admin_or_self" on public.job_parts;
drop policy if exists "job_parts_write_admin" on public.job_parts;

create policy job_parts_select_admin_or_self
on public.job_parts
for select
to authenticated
using (
  (select app_private.is_admin())
  or tech_id = (select auth.uid())
);

create policy job_parts_insert_admin
on public.job_parts
for insert
to authenticated
with check ((select app_private.is_admin()));

create policy job_parts_update_admin
on public.job_parts
for update
to authenticated
using ((select app_private.is_admin()))
with check ((select app_private.is_admin()));

create policy job_parts_delete_admin
on public.job_parts
for delete
to authenticated
using ((select app_private.is_admin()));

drop policy if exists "admin can manage tech_time_off" on public.tech_time_off;
drop policy if exists "tech_time_off_delete_admin" on public.tech_time_off;
drop policy if exists "tech_time_off_insert_admin" on public.tech_time_off;
drop policy if exists "tech_time_off_select_admin_or_self" on public.tech_time_off;
drop policy if exists "tech_time_off_update_admin" on public.tech_time_off;

create policy tech_time_off_select_admin_or_self
on public.tech_time_off
for select
to authenticated
using (
  (select app_private.is_admin())
  or tech_id = (select auth.uid())
);

create policy tech_time_off_insert_admin
on public.tech_time_off
for insert
to authenticated
with check ((select app_private.is_admin()));

create policy tech_time_off_update_admin
on public.tech_time_off
for update
to authenticated
using ((select app_private.is_admin()))
with check ((select app_private.is_admin()));

create policy tech_time_off_delete_admin
on public.tech_time_off
for delete
to authenticated
using ((select app_private.is_admin()));

drop policy if exists "techs selectable by admin or owner" on public.techs;
create policy "techs selectable by admin or owner"
on public.techs
for select
to authenticated
using (
  (select app_private.is_admin())
  or user_id = (select auth.uid())
);

drop policy if exists "property managers and admins can read accounts" on public.property_managers;
create policy "property managers and admins can read accounts"
on public.property_managers
for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select app_private.is_admin())
);

-- All public booking and return-visit pages use server endpoints with service-role
-- credentials, so the raw schedule table no longer needs anonymous Data API access.
drop policy if exists "schedule_slots_public_read_available" on public.schedule_slots;
revoke select on table public.schedule_slots from anon;

alter policy schedule_slots_admin_all
on public.schedule_slots
to authenticated
using ((select app_private.is_admin()))
with check ((select app_private.is_admin()));

-- Normalize the internal admin-only policies created in phase 1.
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
    'slot_blocks',
    'slot_templates',
    'sms_reminder_log',
    'tech_work_patterns',
    'territories',
    'zone_tech_assignments',
    'zones'
  ]
  loop
    if exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = v_table
        and policyname = 'admin_only'
    ) then
      execute format(
        'alter policy admin_only on public.%I to authenticated using ((select app_private.is_admin())) with check ((select app_private.is_admin()))',
        v_table
      );
    end if;
  end loop;
end
$block$;

-- ---------------------------------------------------------------------------
-- 3. Add covering indexes for foreign keys flagged by the Performance Advisor.
-- ---------------------------------------------------------------------------
create index if not exists booking_billing_request_id_idx
  on public.booking_billing (request_id);

create index if not exists booking_customer_actions_request_id_idx
  on public.booking_customer_actions (request_id);

create index if not exists booking_request_offers_slot_id_idx
  on public.booking_request_offers (slot_id);

create index if not exists bookings_tech_id_idx
  on public.bookings (tech_id);

create index if not exists job_help_requests_request_id_idx
  on public.job_help_requests (request_id);

create index if not exists schedule_slots_territory_id_idx
  on public.schedule_slots (territory_id);

-- ---------------------------------------------------------------------------
-- 4. Remove confirmed duplicate indexes while preserving constraint-backed ones.
-- ---------------------------------------------------------------------------
drop index if exists public.booking_request_offers_request_id_idx;
drop index if exists public.uniq_booking_request_offers_token;
drop index if exists public.booking_requests_created_idx;
drop index if exists public.idx_bookings_window_start;
drop index if exists public.ix_bookings_window_start;
alter table public.profiles drop constraint if exists profiles_user_id_key;
drop index if exists public.zones_zone_code_uniq;

notify pgrst, 'reload schema';
