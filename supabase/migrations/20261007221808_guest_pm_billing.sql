create table public.pm_guest_bills (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  request_id uuid not null references public.booking_requests(id) on delete cascade,
  property_manager_id uuid not null references public.property_managers(id),
  revision integer not null default 0,
  snapshot jsonb not null default '{}'::jsonb,
  amount_due_cents integer not null default 0 check (amount_due_cents >= 0),
  status text not null default 'editing' check (status in ('editing','pending_approval','ready','denied','payment_pending','paid')),
  expires_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  paid_at timestamptz,
  stripe_session_id text unique,
  stripe_url text,
  checkout_attempt integer not null default 0,
  lock_id uuid,
  lock_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pm_guest_bills_request_idx on public.pm_guest_bills(request_id);
create index pm_guest_bills_manager_idx on public.pm_guest_bills(property_manager_id);
alter table public.pm_guest_bills enable row level security;
revoke all on public.pm_guest_bills from public,anon,authenticated;
grant select,insert,update,delete on public.pm_guest_bills to service_role;

create function public.decide_pm_guest_bill(p_bill_id uuid,p_revision integer,p_lock_id uuid,p_approve boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare bill public.pm_guest_bills%rowtype; job public.bookings%rowtype;
begin
  select * into bill from public.pm_guest_bills where id=p_bill_id for update;
  if not found or bill.revision<>p_revision or bill.lock_id is distinct from p_lock_id or bill.status<>'pending_approval' then
    raise exception 'This approval request is no longer current';
  end if;
  select * into job from public.bookings where id=bill.booking_id for update;
  if job.status in ('cancelled','no_show','completed') then raise exception 'This job is no longer available for approval'; end if;
  update public.booking_billing set
    pm_approval_status=case when p_approve then 'approved' else 'denied' end,
    status=case when not p_approve then 'pm_approval_needed' when (bill.snapshot->>'parts_on_order')::boolean then 'parts_on_order' else 'sent_to_customer' end,
    updated_at=now()
  where booking_id=bill.booking_id;
  if not found then raise exception 'Billing record is missing'; end if;
  update public.bookings set status=case when not p_approve then 'parts_approval_needed' when (bill.snapshot->>'parts_on_order')::boolean then 'parts_on_order' else 'billing_pending' end where id=job.id;
  update public.pm_guest_bills set status=case when p_approve then 'ready' else 'denied' end,approved_at=case when p_approve then now() else null end,denied_at=case when p_approve then null else now() end,updated_at=now() where id=bill.id returning * into bill;
  return to_jsonb(bill);
end;
$$;
revoke all on function public.decide_pm_guest_bill(uuid,integer,uuid,boolean) from public,anon,authenticated;
grant execute on function public.decide_pm_guest_bill(uuid,integer,uuid,boolean) to service_role;

create function public.record_pm_guest_bill_payment(p_bill_id uuid,p_revision integer,p_session_id text,p_amount_cents integer,p_payment_intent_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare bill public.pm_guest_bills%rowtype; job public.bookings%rowtype; charges public.booking_billing%rowtype;
begin
  select * into bill from public.pm_guest_bills where id=p_bill_id for update;
  if not found or bill.revision<>p_revision or bill.stripe_session_id is distinct from p_session_id or bill.amount_due_cents<>p_amount_cents or p_amount_cents<=0 then
    raise exception 'Payment does not match the current guest bill';
  end if;
  if bill.status='paid' then return jsonb_build_object('duplicate',true,'booking_id',bill.booking_id); end if;
  if bill.status<>'payment_pending' then raise exception 'Guest bill is not awaiting payment'; end if;
  select * into job from public.bookings where id=bill.booking_id for update;
  select * into charges from public.booking_billing where booking_id=bill.booking_id for update;
  if not found or charges.total_job_cents<>(bill.snapshot->>'total_cents')::integer then raise exception 'Billing total changed'; end if;
  update public.booking_billing set
    payment_status='paid',stripe_payment_intent_id=p_payment_intent_id,paid_at=now(),remaining_due_cents=0,payment_url=null,
    status=case when job.status='completed' then 'completed' when charges.status='parts_on_order' then 'parts_on_order' else 'paid' end,
    part_paid_at=case when (bill.snapshot->>'parts_on_order')::boolean then coalesce(charges.part_paid_at,now()) else charges.part_paid_at end,
    part_status=case when charges.part_status='awaiting_payment' then case when charges.part_delivery_destination='customer' then 'customer_receiving' else 'tech_receiving' end else charges.part_status end,
    updated_at=now()
  where id=charges.id;
  update public.bookings set
    payment_status='paid',collected_cents=(bill.snapshot->>'collected_cents')::integer+p_amount_cents,
    status=case when job.status in ('completed','cancelled','no_show','parts_on_order','return_visit_needed') then job.status when (bill.snapshot->>'parts_on_order')::boolean then 'parts_on_order' else 'billing_pending' end
  where id=job.id;
  update public.pm_guest_bills set status='paid',paid_at=now(),updated_at=now() where id=bill.id;
  return jsonb_build_object('duplicate',false,'booking_id',job.id,'paid_cents',p_amount_cents);
end;
$$;
revoke all on function public.record_pm_guest_bill_payment(uuid,integer,text,integer,text) from public,anon,authenticated;
grant execute on function public.record_pm_guest_bill_payment(uuid,integer,text,integer,text) to service_role;
