-- =============================================================================
-- 0002 Accounts: profiles, owners (+ company profile / branding), customers,
-- subscription plans, settings, login attempts, and the RLS helper functions.
--
-- Identity model: auth.users holds credentials (Supabase Auth, bcrypt). The auth
-- email is synthetic ({username}@users.rentdesk.invalid); real contact emails live
-- in owners / customers. owners.id and customers.id ARE the profile id (1:1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles  (SERVER-WRITE-ONLY: created by app.provision_account, changed by server code)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null,
  -- Tenant: null for ADMIN, own id for OWNER, the owner's id for CUSTOMER.
  owner_id uuid,
  username text not null,
  full_name text not null default '',
  must_change_password boolean not null default true,
  status public.account_status not null default 'ACTIVE',
  created_by uuid references public.profiles (id),
  last_login_at timestamptz,
  failed_login_count integer not null default 0 check (failed_login_count >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_key unique (username),
  constraint profiles_username_format check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  constraint profiles_role_owner check (
    (role = 'ADMIN' and owner_id is null)
    or (role = 'OWNER' and owner_id = id)
    or (role = 'CUSTOMER' and owner_id is not null and owner_id <> id)
  ),
  constraint profiles_id_owner_key unique (id, owner_id)
);
comment on table public.profiles is
  'One row per auth user: role, tenant, account status, login security. SERVER-WRITE-ONLY.';
create index profiles_owner_id_idx on public.profiles (owner_id);
create index profiles_created_by_idx on public.profiles (created_by);

-- role, owner_id and id never change after creation.
create function app.protect_profile_identity() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.role <> old.role or new.owner_id is distinct from old.owner_id then
    raise exception using errcode = 'RD400', message = 'Profile id, role and owner cannot be changed';
  end if;
  return new;
end;
$$;

create trigger profiles_protect_identity before update on public.profiles
  for each row execute function app.protect_profile_identity();
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function app.set_updated_at();
create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function app.audit_row_change('all');

-- -----------------------------------------------------------------------------
-- subscription_plans (optional, ADM-07)  SERVER-WRITE-ONLY
-- -----------------------------------------------------------------------------
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  price_cents bigint not null default 0 check (price_cents >= 0),
  max_customers integer check (max_customers > 0),
  max_machines integer check (max_machines > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscription_plans_set_updated_at before update on public.subscription_plans
  for each row execute function app.set_updated_at();

-- -----------------------------------------------------------------------------
-- owners  (SERVER-WRITE-ONLY: admin manages owners through server code)
-- -----------------------------------------------------------------------------
create table public.owners (
  id uuid primary key references public.profiles (id),
  business_name text not null check (length(btrim(business_name)) > 0),
  contact_person text not null default '',
  phone text,
  email text,
  address text,
  plan_id uuid references public.subscription_plans (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.owners is 'Tenant (rental business). id = the owner profile id. SERVER-WRITE-ONLY.';
create index owners_plan_id_idx on public.owners (plan_id);

-- The tenant reference on profiles is deferred so a new owner's profile (owner_id = id)
-- and owners row can be inserted in the same transaction.
alter table public.profiles
  add constraint profiles_owner_id_fkey foreign key (owner_id)
  references public.owners (id) deferrable initially deferred;

create function app.assert_owner_profile() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles p where p.id = new.id and p.role = 'OWNER') then
    raise exception using errcode = 'RD400', message = 'owners.id must be an OWNER profile';
  end if;
  return new;
end;
$$;

create trigger owners_assert_profile before insert on public.owners
  for each row execute function app.assert_owner_profile();
create trigger owners_set_updated_at before update on public.owners
  for each row execute function app.set_updated_at();
create trigger owners_audit after insert or update or delete on public.owners
  for each row execute function app.audit_row_change('all');

-- -----------------------------------------------------------------------------
-- owner_company_profiles (spec 17, BRD-01..07). Owner writes directly (RLS).
-- onboarding_completed_at is set by server code only (no column grant).
-- -----------------------------------------------------------------------------
create table public.owner_company_profiles (
  owner_id uuid primary key references public.owners (id),
  company_name text not null check (length(btrim(company_name)) > 0),
  logo_path text,
  address text,
  phone text,
  email text,
  bank_name text,
  bank_branch text,
  bank_account_name text,
  bank_account_no text,
  letterhead_path text,
  letterhead_layout jsonb not null default '{}'::jsonb check (jsonb_typeof(letterhead_layout) = 'object'),
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Files live in the private `branding` bucket under the owner's own prefix.
  constraint owner_company_profiles_logo_path check (logo_path is null or logo_path like owner_id::text || '/%'),
  constraint owner_company_profiles_letterhead_path check (letterhead_path is null or letterhead_path like owner_id::text || '/%')
);
comment on table public.owner_company_profiles is
  'Owner branding used on invoices, emails and portals (spec 17). Missing row = not onboarded.';
create trigger owner_company_profiles_set_updated_at before update on public.owner_company_profiles
  for each row execute function app.set_updated_at();
create trigger owner_company_profiles_audit after insert or update or delete on public.owner_company_profiles
  for each row execute function app.audit_row_change('all');

-- -----------------------------------------------------------------------------
-- customers  (insert SERVER-WRITE-ONLY; owner may update contact columns)
-- -----------------------------------------------------------------------------
create table public.customers (
  id uuid primary key,
  owner_id uuid not null references public.owners (id),
  name text not null check (length(btrim(name)) > 0),
  business_name text,
  phone text,
  email text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_not_owner check (id <> owner_id),
  -- The customer's profile must belong to the same tenant.
  constraint customers_profile_fkey foreign key (id, owner_id) references public.profiles (id, owner_id),
  constraint customers_id_owner_key unique (id, owner_id)
);
comment on table public.customers is 'Renting customer. id = the customer profile id. Status lives in profiles.';
create index customers_owner_id_idx on public.customers (owner_id);

create trigger customers_set_updated_at before update on public.customers
  for each row execute function app.set_updated_at();
create trigger customers_audit after insert or update or delete on public.customers
  for each row execute function app.audit_row_change('all');

-- -----------------------------------------------------------------------------
-- Settings: global defaults (single row) + per-owner overrides (null = inherit).
-- Defaults follow spec 5.4 / 8.3 / 7.3.
-- -----------------------------------------------------------------------------
create table public.platform_settings (
  id boolean primary key default true check (id),
  default_cycle_length_days integer not null default 30 check (default_cycle_length_days between 1 and 366),
  meter_deadline_days integer not null default 5 check (meter_deadline_days > 0),
  meter_reminder_days integer[] not null default '{2,4}',
  review_deadline_hours integer not null default 48 check (review_deadline_hours > 0),
  review_reminder_hours integer[] not null default '{24,48}',
  review_escalation_hours integer not null default 72 check (review_escalation_hours > 0),
  payment_due_days integer not null default 7 check (payment_due_days >= 0),
  payment_reminder_before_days integer[] not null default '{3}',
  payment_reminder_on_due boolean not null default true,
  payment_overdue_reminder_days integer[] not null default '{1,7,14}',
  slip_review_deadline_hours integer not null default 48 check (slip_review_deadline_hours > 0),
  slip_review_reminder_hours integer[] not null default '{24,48}',
  slip_review_escalation_hours integer not null default 72 check (slip_review_escalation_hours > 0),
  max_meter_rejections integer not null default 3 check (max_meter_rejections > 0),
  rejected_photo_retention_days integer not null default 7 check (rejected_photo_retention_days >= 0),
  payment_slip_retention_days integer not null default 2555 check (payment_slip_retention_days >= 0),
  grace_period_days integer not null default 7 check (grace_period_days >= 0),
  late_fee_enabled boolean not null default false,
  late_fee_cents bigint not null default 0 check (late_fee_cents >= 0),
  estimated_billing_enabled boolean not null default false,
  service_ack_hours_urgent integer not null default 4 check (service_ack_hours_urgent > 0),
  service_ack_hours_normal integer not null default 24 check (service_ack_hours_normal > 0),
  service_admin_escalation_hours_urgent integer not null default 8 check (service_admin_escalation_hours_urgent > 0),
  service_admin_escalation_hours_normal integer not null default 48 check (service_admin_escalation_hours_normal > 0),
  weekly_summary_dow smallint not null default 1 check (weekly_summary_dow between 0 and 6),
  updated_at timestamptz not null default now()
);
comment on table public.platform_settings is 'Global defaults (single row). Admin may update (ADM-06).';
insert into public.platform_settings (id) values (true);

create table public.owner_settings (
  owner_id uuid primary key references public.owners (id),
  default_cycle_length_days integer check (default_cycle_length_days between 1 and 366),
  meter_deadline_days integer check (meter_deadline_days > 0),
  meter_reminder_days integer[],
  review_deadline_hours integer check (review_deadline_hours > 0),
  review_reminder_hours integer[],
  review_escalation_hours integer check (review_escalation_hours > 0),
  payment_due_days integer check (payment_due_days >= 0),
  payment_reminder_before_days integer[],
  payment_reminder_on_due boolean,
  payment_overdue_reminder_days integer[],
  slip_review_deadline_hours integer check (slip_review_deadline_hours > 0),
  slip_review_reminder_hours integer[],
  slip_review_escalation_hours integer check (slip_review_escalation_hours > 0),
  max_meter_rejections integer check (max_meter_rejections > 0),
  rejected_photo_retention_days integer check (rejected_photo_retention_days >= 0),
  payment_slip_retention_days integer check (payment_slip_retention_days >= 0),
  grace_period_days integer check (grace_period_days >= 0),
  late_fee_enabled boolean,
  late_fee_cents bigint check (late_fee_cents >= 0),
  estimated_billing_enabled boolean,
  service_ack_hours_urgent integer check (service_ack_hours_urgent > 0),
  service_ack_hours_normal integer check (service_ack_hours_normal > 0),
  service_admin_escalation_hours_urgent integer check (service_admin_escalation_hours_urgent > 0),
  service_admin_escalation_hours_normal integer check (service_admin_escalation_hours_normal > 0),
  weekly_summary_dow smallint check (weekly_summary_dow between 0 and 6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.owner_settings is 'Per-owner overrides; null columns inherit platform_settings.';

create trigger platform_settings_set_updated_at before update on public.platform_settings
  for each row execute function app.set_updated_at();
create trigger platform_settings_audit after update on public.platform_settings
  for each row execute function app.audit_row_change('all');
create trigger owner_settings_set_updated_at before update on public.owner_settings
  for each row execute function app.set_updated_at();
create trigger owner_settings_audit after insert or update on public.owner_settings
  for each row execute function app.audit_row_change('all');

-- Effective settings per owner (owner override, else global default).
-- security_invoker: callers see only the owners their RLS allows.
create view public.owner_settings_effective
with (security_invoker = true) as
select
  o.id as owner_id,
  coalesce(s.default_cycle_length_days, p.default_cycle_length_days) as default_cycle_length_days,
  coalesce(s.meter_deadline_days, p.meter_deadline_days) as meter_deadline_days,
  coalesce(s.meter_reminder_days, p.meter_reminder_days) as meter_reminder_days,
  coalesce(s.review_deadline_hours, p.review_deadline_hours) as review_deadline_hours,
  coalesce(s.review_reminder_hours, p.review_reminder_hours) as review_reminder_hours,
  coalesce(s.review_escalation_hours, p.review_escalation_hours) as review_escalation_hours,
  coalesce(s.payment_due_days, p.payment_due_days) as payment_due_days,
  coalesce(s.payment_reminder_before_days, p.payment_reminder_before_days) as payment_reminder_before_days,
  coalesce(s.payment_reminder_on_due, p.payment_reminder_on_due) as payment_reminder_on_due,
  coalesce(s.payment_overdue_reminder_days, p.payment_overdue_reminder_days) as payment_overdue_reminder_days,
  coalesce(s.slip_review_deadline_hours, p.slip_review_deadline_hours) as slip_review_deadline_hours,
  coalesce(s.slip_review_reminder_hours, p.slip_review_reminder_hours) as slip_review_reminder_hours,
  coalesce(s.slip_review_escalation_hours, p.slip_review_escalation_hours) as slip_review_escalation_hours,
  coalesce(s.max_meter_rejections, p.max_meter_rejections) as max_meter_rejections,
  coalesce(s.rejected_photo_retention_days, p.rejected_photo_retention_days) as rejected_photo_retention_days,
  coalesce(s.payment_slip_retention_days, p.payment_slip_retention_days) as payment_slip_retention_days,
  coalesce(s.grace_period_days, p.grace_period_days) as grace_period_days,
  coalesce(s.late_fee_enabled, p.late_fee_enabled) as late_fee_enabled,
  coalesce(s.late_fee_cents, p.late_fee_cents) as late_fee_cents,
  coalesce(s.estimated_billing_enabled, p.estimated_billing_enabled) as estimated_billing_enabled,
  coalesce(s.service_ack_hours_urgent, p.service_ack_hours_urgent) as service_ack_hours_urgent,
  coalesce(s.service_ack_hours_normal, p.service_ack_hours_normal) as service_ack_hours_normal,
  coalesce(s.service_admin_escalation_hours_urgent, p.service_admin_escalation_hours_urgent) as service_admin_escalation_hours_urgent,
  coalesce(s.service_admin_escalation_hours_normal, p.service_admin_escalation_hours_normal) as service_admin_escalation_hours_normal,
  coalesce(s.weekly_summary_dow, p.weekly_summary_dow) as weekly_summary_dow
from public.owners o
cross join public.platform_settings p
left join public.owner_settings s on s.owner_id = o.id;

-- -----------------------------------------------------------------------------
-- login_attempts (AUTH-08 rate limiting)  SERVER-ONLY: no client grants at all.
-- -----------------------------------------------------------------------------
create table public.login_attempts (
  id bigint generated always as identity primary key,
  username text not null,
  user_id uuid references public.profiles (id) on delete set null,
  ip inet,
  success boolean not null,
  reason text,
  created_at timestamptz not null default now()
);
create index login_attempts_username_idx on public.login_attempts (username, created_at desc);
create index login_attempts_ip_idx on public.login_attempts (ip, created_at desc);
create index login_attempts_user_id_idx on public.login_attempts (user_id);

-- -----------------------------------------------------------------------------
-- RLS helper functions. SECURITY DEFINER (they read profiles without triggering
-- profiles' own RLS, so policies never recurse), STABLE, fixed search_path.
-- Each returns NULL unless the caller's account is ACTIVE and, for customers,
-- their owner is ACTIVE too. Every policy therefore fails closed for suspended
-- or deactivated users and for customers of a suspended owner (AUTH-10).
-- -----------------------------------------------------------------------------
create function app.current_user_role() returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  left join public.profiles o on o.id = p.owner_id
  where p.id = auth.uid()
    and p.status = 'ACTIVE'
    and (p.owner_id is null or o.status = 'ACTIVE');
$$;

-- Tenant of the caller: own id for an OWNER, the owner's id for a CUSTOMER, null for ADMIN.
create function app.current_owner_id() returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.owner_id
  from public.profiles p
  join public.profiles o on o.id = p.owner_id
  where p.id = auth.uid()
    and p.status = 'ACTIVE'
    and o.status = 'ACTIVE';
$$;

create function app.current_customer_id() returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  join public.profiles o on o.id = p.owner_id
  where p.id = auth.uid()
    and p.role = 'CUSTOMER'
    and p.status = 'ACTIVE'
    and o.status = 'ACTIVE';
$$;

create function app.is_admin() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(app.current_user_role() = 'ADMIN', false);
$$;
