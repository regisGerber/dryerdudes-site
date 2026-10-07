-- Guest billing contacts have no login. Existing account RLS still requires
-- user_id = auth.uid(), so guests do not gain portal access.
alter table public.property_managers alter column user_id drop not null;

create table public.pm_guest_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz,
  token_hash text not null unique,
  ip_hash text not null,
  manager_email text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','email_failed','processing','completed','failed')),
  property_manager_id uuid references public.property_managers(id),
  request_id uuid references public.booking_requests(id),
  result jsonb
);
create index pm_guest_requests_ip_created_idx on public.pm_guest_requests(ip_hash,created_at);
create index pm_guest_requests_email_created_idx on public.pm_guest_requests(manager_email,created_at);
create index pm_guest_requests_pm_idx on public.pm_guest_requests(property_manager_id);
create index pm_guest_requests_request_idx on public.pm_guest_requests(request_id);
alter table public.pm_guest_requests enable row level security;
revoke all on public.pm_guest_requests from public, anon, authenticated;
grant select, insert, update, delete on public.pm_guest_requests to service_role;
comment on table public.pm_guest_requests is 'Server-only guest authorization records. Raw verification tokens are never stored. No browser role has access.';
