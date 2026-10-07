begin;
do $$
declare pm uuid; job uuid; invoice uuid; lease uuid:=gen_random_uuid(); result jsonb; collected integer;
begin
insert into public.property_managers(company_name,email) values('Rollback billing verification','billing@example.invalid') returning id into pm;
select id into job from public.bookings b where b.status not in ('cancelled','no_show','completed') and not exists(select 1 from public.pm_guest_bills g where g.booking_id=b.id) limit 1;
update public.bookings set property_manager_id=pm,request_source='property_manager',paid_by_property_manager=true,status='parts_approval_needed',collected_cents=0 where id=job;
if job is null then raise exception 'No fixture booking available'; end if;
insert into public.booking_billing(booking_id,issue_code,total_job_cents,remaining_due_cents,parts_cost_cents,pm_approval_required,pm_approval_status,status)
values(job,'other',17500,17500,9500,true,'pending','pm_approval_needed') on conflict(booking_id) do update set total_job_cents=17500,remaining_due_cents=17500,pm_approval_required=true,pm_approval_status='pending',status='pm_approval_needed';
insert into public.pm_guest_bills(booking_id,request_id,property_manager_id,revision,snapshot,amount_due_cents,status,lock_id)
select job,request_id,pm,1,'{"total_cents":17500,"collected_cents":0,"parts_on_order":false}'::jsonb,17500,'pending_approval',lease from public.bookings where id=job returning id into invoice;
result:=public.decide_pm_guest_bill(invoice,1,lease,true);
if result->>'status'<>'ready' then raise exception 'Approval failed'; end if;
update public.pm_guest_bills set status='payment_pending',stripe_session_id='cs_rollback_verification' where id=invoice;
result:=public.record_pm_guest_bill_payment(invoice,1,'cs_rollback_verification',17500,'pi_rollback_verification');
if (result->>'duplicate')::boolean then raise exception 'First payment incorrectly duplicate'; end if;
result:=public.record_pm_guest_bill_payment(invoice,1,'cs_rollback_verification',17500,'pi_rollback_verification');
if not (result->>'duplicate')::boolean then raise exception 'Replay not detected'; end if;
select collected_cents into collected from public.bookings where id=job;
if collected<>17500 then raise exception 'Payment counted incorrectly'; end if;
if not exists(select 1 from public.booking_billing where booking_id=job and remaining_due_cents=0 and payment_status='paid') then raise exception 'Billing not settled'; end if;
begin
perform public.record_pm_guest_bill_payment(invoice,1,'cs_rollback_verification',17501,'pi_invalid');
raise exception 'Wrong payment was accepted';
exception when others then
if sqlerrm='Wrong payment was accepted' then raise; end if;
end;
end $$;
rollback;
