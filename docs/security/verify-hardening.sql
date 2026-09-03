-- Run in the SQL editor as the project postgres role.
-- Read-only metadata assertions: no booking/slot/customer rows are changed.
begin read only;
do $test$
declare signature text; table_name text;
begin
  if has_table_privilege('anon','public.bookings','SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('anon','public.booking_requests','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Unexpected anonymous access to customer booking tables';
  end if;
  if has_table_privilege('authenticated','public.bookings','INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated','public.booking_requests','INSERT,UPDATE,DELETE') then
    raise exception 'Unexpected direct client writes; use the authenticated server endpoints';
  end if;
  foreach table_name in array array['bookings','booking_requests','schedule_slots'] loop
    if has_table_privilege('anon','public.'||table_name,'TRUNCATE')
       or has_table_privilege('authenticated','public.'||table_name,'TRUNCATE') then
      raise exception 'Unexpected client TRUNCATE privilege on %', table_name;
    end if;
    if not has_table_privilege('service_role','public.'||table_name,'SELECT')
       or not has_table_privilege('service_role','public.'||table_name,'INSERT')
       or not has_table_privilege('service_role','public.'||table_name,'UPDATE') then
      raise exception 'Backend access missing on %', table_name;
    end if;
  end loop;
  foreach table_name in array array['v_booking_offers_expanded','v_checkout_slot_validation'] loop
    if has_table_privilege('anon','public.'||table_name,'SELECT')
       or has_table_privilege('authenticated','public.'||table_name,'SELECT') then
      raise exception 'Unexpected direct client access to %', table_name;
    end if;
    if not has_table_privilege('service_role','public.'||table_name,'SELECT') then
      raise exception 'Backend view access missing on %', table_name;
    end if;
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and c.relname=table_name
                     and c.reloptions @> array['security_invoker=true']) then
      raise exception 'View is not security_invoker: %', table_name;
    end if;
  end loop;
  foreach signature in array array[
    'public.finalize_paid_booking(text,text,text,integer,text,text,text)',
    'public.schedule_return_visit(text,uuid)',
    'public.verify_offer_for_checkout(text)',
    'public.get_zone_for_point(double precision,double precision)',
    'public.tech_time_off_blocks_slot(uuid,date,integer,timestamptz,timestamptz)'
  ] loop
    if has_function_privilege('anon',signature,'EXECUTE')
       or has_function_privilege('authenticated',signature,'EXECUTE') then
      raise exception 'Unexpected direct client access to server function %', signature;
    end if;
    if not has_function_privilege('service_role',signature,'EXECUTE') then
      raise exception 'Backend function access missing: %', signature;
    end if;
  end loop;
  foreach signature in array array[
    'public.is_admin()',
    'public.get_my_property_manager_profile()',
    'public.get_my_property_manager_jobs()',
    'public.apply_time_off_to_offers(uuid,timestamptz,timestamptz,boolean)',
    'public.set_offers_active_for_slot(uuid,date,integer,boolean)'
  ] loop
    if has_function_privilege('anon',signature,'EXECUTE') then
      raise exception 'Portal function is callable anonymously: %', signature;
    end if;
    if not has_function_privilege('authenticated',signature,'EXECUTE') then
      raise exception 'Required portal function is unavailable: %', signature;
    end if;
  end loop;
  if has_schema_privilege('anon','private','USAGE')
     or has_schema_privilege('authenticated','private','USAGE') then
    raise exception 'Unexpected client access to private backup schema';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='public' and c.relkind in ('r','p')
               and c.relowner='postgres'::regrole and not c.relrowsecurity) then
    raise exception 'Application-owned public table is missing RLS';
  end if;
end
$test$;
select 'PASS: application database privilege assertions' as result;
rollback;
