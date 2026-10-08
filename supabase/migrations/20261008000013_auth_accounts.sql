-- =============================================================================
-- 0013 Authentication and account management (AUTH-01..11, ADM-01..03, CUS-01..03,
-- BRD-01..03).
--
--   * platform_settings: login lockout / rate limit and session timeout settings.
--   * Audit trigger: records an optional reason (app.audit_reason) with the change.
--   * Atomic account functions (service role only, through public.rpc_* wrappers):
--       login_gate_state, record_login_attempt, session_state, set_account_status,
--       reset_account_password, complete_password_change, update_owner,
--       update_customer, save_company_profile.
--   * public.custom_access_token_hook: Supabase Auth hook that refuses tokens to
--     blocked accounts, so the rules hold even when someone calls Supabase Auth
--     directly with the public anon key. Enabled in the dashboard (docs/database.md).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings (AUTH-08, AUTH-09). The spec gives no numbers; these defaults were agreed.
-- -----------------------------------------------------------------------------
alter table public.platform_settings
  add column login_max_failures integer not null default 5 check (login_max_failures > 0),
  add column login_lockout_minutes integer not null default 15 check (login_lockout_minutes > 0),
  add column login_ip_max_failures integer not null default 30 check (login_ip_max_failures > 0),
  add column login_ip_window_minutes integer not null default 15 check (login_ip_window_minutes > 0),
  add column session_idle_minutes integer not null default 30 check (session_idle_minutes > 0),
  add column session_max_hours integer not null default 12 check (session_max_hours > 0);

grant update (login_max_failures, login_lockout_minutes, login_ip_max_failures, login_ip_window_minutes,
              session_idle_minutes, session_max_hours)
  on public.platform_settings to authenticated;

-- Failed-login lookups by username since a point in time.
create index login_attempts_failures_idx on public.login_attempts (username, created_at desc)
  where success = false and reason = 'invalid_credentials';

-- -----------------------------------------------------------------------------
-- Audit trigger: same as 0001, plus the optional transaction-local reason
-- (`app.audit_reason`) set by the account functions below.
-- -----------------------------------------------------------------------------
create or replace function app.audit_row_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text := coalesce(tg_argv[0], 'all');
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_action text;
  v_details jsonb;
  v_actor uuid := app.resolve_actor();
  v_entity_id text := coalesce(v_row ->> 'id', v_row ->> 'owner_id');
  v_reason text := nullif(current_setting('app.audit_reason', true), '');
begin
  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key not in ('updated_at', 'failed_login_count')
         and (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_array(v_old -> v_key, v_new -> v_key));
      end if;
    end loop;

    if v_changes = '{}'::jsonb then
      return null;
    end if;
    if v_mode = 'status' and not (v_changes ? 'status') then
      return null;
    end if;

    v_action := case
      when v_changes ? 'status' then 'STATUS_CHANGE'
      when tg_table_name = 'profiles' and v_changes ? 'locked_until' and v_new ->> 'locked_until' is not null then 'LOCKOUT'
      when tg_table_name = 'profiles' and v_changes ? 'must_change_password'
           and (v_new ->> 'must_change_password')::boolean = false then 'PASSWORD_CHANGED'
      when tg_table_name = 'profiles' and v_changes ? 'must_change_password' then 'PASSWORD_RESET'
      when tg_table_name = 'profiles' and v_changes ? 'last_login_at' then 'LOGIN'
      else 'UPDATE'
    end;
    v_details := jsonb_build_object('changes', v_changes);
  elsif tg_op = 'INSERT' then
    v_action := 'INSERT';
    v_details := jsonb_build_object('new', v_new);
  else
    v_action := 'DELETE';
    v_details := jsonb_build_object('old', v_old);
  end if;

  if v_reason is not null then
    v_details := v_details || jsonb_build_object('reason', v_reason);
  end if;

  insert into public.audit_logs (actor_id, actor_role, owner_id, action, entity, entity_id, details)
  values (
    v_actor,
    (select p.role from public.profiles p where p.id = v_actor),
    case when tg_table_name = 'owners' then (v_row ->> 'id')::uuid
         else nullif(v_row ->> 'owner_id', '')::uuid end,
    v_action,
    tg_table_name,
    -- Singleton tables (platform_settings) have a non-uuid key: store null.
    case when v_entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then v_entity_id::uuid end,
    v_details
  );
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Account parent check (AUTH-01/05, ADM-02/03, CUS-03): ADMIN manages owners,
-- an OWNER manages their own customers. The actor must be active.
-- Locks and returns the target profile.
-- -----------------------------------------------------------------------------
create function app.lock_managed_account(p_actor_id uuid, p_target_id uuid) returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.user_role;
  t public.profiles;
begin
  select p.role into v_actor_role
  from public.profiles p
  left join public.profiles o on o.id = p.owner_id
  where p.id = p_actor_id
    and p.status = 'ACTIVE'
    and (p.owner_id is null or o.status = 'ACTIVE');
  if v_actor_role is null then
    perform app.fail('RD403', 'This user may not manage accounts');
  end if;

  select * into t from public.profiles where id = p_target_id for update;
  if not found then
    perform app.fail('RD404', 'Account not found');
  end if;

  if t.role = 'OWNER' and v_actor_role = 'ADMIN' then
    null;
  elsif t.role = 'CUSTOMER' and v_actor_role = 'OWNER' and t.owner_id = p_actor_id then
    null;
  else
    perform app.fail('RD403', 'This user may not manage this account');
  end if;

  perform app.set_actor(p_actor_id);
  return t;
end;
$$;

-- -----------------------------------------------------------------------------
-- Login (AUTH-08). Lockout counts failed attempts with wrong credentials for a
-- username since the later of (now - lockout window) and its last success. The same
-- rule applies to unknown usernames, so a lockout reveals nothing about existence.
-- -----------------------------------------------------------------------------
create function app.username_failures(p_username text, p_since timestamptz)
returns table (failures integer, last_failure_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer, max(a.created_at)
  from public.login_attempts a
  where a.username = p_username
    and a.success = false
    and a.reason = 'invalid_credentials'
    and a.created_at > greatest(
      p_since,
      coalesce((select max(s.created_at) from public.login_attempts s
                where s.username = p_username and s.success), '-infinity'::timestamptz)
    );
$$;

-- Everything the login gate (src/lib/auth/login-gate.ts) needs, in one round trip.
create function app.login_gate_state(p_username text, p_ip inet) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.platform_settings;
  v_locked_until timestamptz;
  v_failures integer;
  v_last_failure timestamptz;
  v_ip_failures integer := 0;
begin
  select * into s from public.platform_settings;
  select p.locked_until into v_locked_until from public.profiles p where p.username = p_username;
  select f.failures, f.last_failure_at into v_failures, v_last_failure
  from app.username_failures(p_username, now() - make_interval(mins => s.login_lockout_minutes)) f;
  if p_ip is not null then
    select count(*)::integer into v_ip_failures
    from public.login_attempts a
    where a.ip = p_ip
      and a.success = false
      and a.reason = 'invalid_credentials'
      and a.created_at > now() - make_interval(mins => s.login_ip_window_minutes);
  end if;

  return jsonb_build_object(
    'now', now(),
    'locked_until', v_locked_until,
    'username_failures', v_failures,
    'last_username_failure_at', v_last_failure,
    'ip_failures', v_ip_failures,
    'policy', jsonb_build_object(
      'max_failures', s.login_max_failures,
      'lockout_minutes', s.login_lockout_minutes,
      'ip_max_failures', s.login_ip_max_failures,
      'ip_window_minutes', s.login_ip_window_minutes
    )
  );
end;
$$;

-- Records one login attempt atomically (row lock on the profile):
--   success                      -> clears the counter and lock, sets last_login_at (audit LOGIN)
--   'invalid_credentials'        -> counts the failure; at the threshold sets locked_until (audit LOCKOUT)
--   any other failure reason     -> recorded only ('locked', 'ip_limited', 'suspended', ...)
-- Every failure also writes a LOGIN_FAILED audit entry.
create function app.record_login_attempt(
  p_username text,
  p_ip inet,
  p_success boolean,
  p_reason text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.platform_settings;
  p public.profiles;
  v_failures integer := 0;
  v_locked_until timestamptz;
begin
  if p_username is null or length(p_username) = 0 or length(p_username) > 100 then
    perform app.fail('RD400', 'Invalid username');
  end if;
  if not p_success and p_reason is null then
    perform app.fail('RD400', 'A failed attempt needs a reason');
  end if;

  select * into s from public.platform_settings;
  select * into p from public.profiles where username = p_username for update;

  -- clock_timestamp(): attempts in one transaction stay ordered (tests, retries).
  insert into public.login_attempts (username, user_id, ip, success, reason, created_at)
  values (p_username, p.id, p_ip, p_success, case when p_success then null else p_reason end, clock_timestamp());

  if p_success then
    if p.id is null then
      perform app.fail('RD404', 'Account not found');
    end if;
    perform app.set_actor(p.id);
    update public.profiles
    set failed_login_count = 0, locked_until = null, last_login_at = now()
    where id = p.id;
    return jsonb_build_object('user_id', p.id, 'failures', 0, 'locked_until', null);
  end if;

  if p_reason = 'invalid_credentials' then
    select f.failures into v_failures
    from app.username_failures(p_username, now() - make_interval(mins => s.login_lockout_minutes)) f;
    if v_failures >= s.login_max_failures then
      v_locked_until := now() + make_interval(mins => s.login_lockout_minutes);
    end if;
    if p.id is not null then
      perform app.set_actor(null);
      update public.profiles
      set failed_login_count = case when v_locked_until is null then v_failures else 0 end,
          locked_until = coalesce(v_locked_until, locked_until)
      where id = p.id;
    end if;
  end if;

  perform app.write_audit(
    null, 'LOGIN_FAILED', 'profiles', p.id, p.owner_id,
    jsonb_build_object('username', p_username, 'ip', p_ip, 'reason', p_reason, 'user_agent', left(p_user_agent, 300))
  );

  return jsonb_build_object('user_id', p.id, 'failures', v_failures, 'locked_until', v_locked_until);
end;
$$;

-- -----------------------------------------------------------------------------
-- Session state for the route guard (src/proxy.ts): role, status, owner status,
-- gates, and the session timeout settings. Read-only.
-- -----------------------------------------------------------------------------
create function app.session_state(p_user_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.id,
    'role', p.role,
    'username', p.username,
    'full_name', p.full_name,
    'status', p.status,
    'owner_id', p.owner_id,
    'owner_status', o.status,
    'must_change_password', p.must_change_password,
    'onboarded', case when p.role = 'OWNER' then c.onboarding_completed_at is not null else true end,
    'session_idle_minutes', s.session_idle_minutes,
    'session_max_hours', s.session_max_hours
  )
  from public.profiles p
  left join public.profiles o on o.id = p.owner_id
  left join public.owner_company_profiles c on c.owner_id = p.id
  cross join public.platform_settings s
  where p.id = p_user_id;
$$;

-- -----------------------------------------------------------------------------
-- Status changes (ADM-02, CUS-03, AUTH-10). Reason required. The affected user gets
-- an in-app notification. Suspending an owner blocks their customers through the
-- RLS helpers, the route guard and the access token hook (no per-customer change).
-- -----------------------------------------------------------------------------
create function app.set_account_status(
  p_actor_id uuid,
  p_target_id uuid,
  p_status public.account_status,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.profiles;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_status is null then
    perform app.fail('RD400', 'Status is required');
  end if;
  if v_reason is null then
    perform app.fail('RD400', 'A reason is required');
  end if;

  t := app.lock_managed_account(p_actor_id, p_target_id);
  if t.status = p_status then
    perform app.fail('RD409', 'The account already has this status');
  end if;

  perform set_config('app.audit_reason', v_reason, true);
  update public.profiles
  set status = p_status,
      -- Reactivation starts clean.
      failed_login_count = case when p_status = 'ACTIVE' then 0 else failed_login_count end,
      locked_until = case when p_status = 'ACTIVE' then null else locked_until end
  where id = t.id;
  perform set_config('app.audit_reason', '', true);

  perform app.enqueue_notifications(
    t.owner_id,
    jsonb_build_array(jsonb_build_object(
      'user_id', t.id,
      'event', 'account.' || lower(p_status::text),
      'title', case p_status
                 when 'ACTIVE' then 'Your account is active again'
                 when 'SUSPENDED' then 'Your account was suspended'
                 else 'Your account was closed'
               end,
      'body', v_reason
    )),
    'profiles',
    t.id
  );

  return jsonb_build_object('user_id', t.id, 'from', t.status, 'to', p_status);
end;
$$;

-- -----------------------------------------------------------------------------
-- Password reset (AUTH-05, ADM-03, CUS-03). Call BEFORE setting the new password
-- through the Auth Admin API: this is the authorisation step. Forces a change at
-- next login and clears any lockout.
-- -----------------------------------------------------------------------------
create function app.reset_account_password(p_actor_id uuid, p_target_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.profiles;
begin
  t := app.lock_managed_account(p_actor_id, p_target_id);

  update public.profiles
  set must_change_password = true, failed_login_count = 0, locked_until = null
  where id = t.id;

  -- The trigger logs PASSWORD_RESET only when the flag flips; log it explicitly otherwise.
  if t.must_change_password then
    perform app.write_audit(p_actor_id, 'PASSWORD_RESET', 'profiles', t.id, t.owner_id,
                            jsonb_build_object('username', t.username));
  end if;

  return jsonb_build_object('user_id', t.id, 'username', t.username);
end;
$$;

-- AUTH-03: the user changed their own password (server code has already done it
-- through Supabase Auth). Clears the forced-change flag; audit PASSWORD_CHANGED.
create function app.complete_password_change(p_user_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.profiles;
begin
  select * into t from public.profiles where id = p_user_id for update;
  if not found then
    perform app.fail('RD404', 'Account not found');
  end if;
  perform app.set_actor(p_user_id);
  if t.must_change_password then
    update public.profiles set must_change_password = false where id = t.id;
  else
    perform app.write_audit(p_user_id, 'PASSWORD_CHANGED', 'profiles', t.id, t.owner_id, '{}'::jsonb);
  end if;
  return jsonb_build_object('user_id', t.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Account details (ADM-01, CUS-01). Keys absent from p_details keep their value;
-- present keys with null clear optional fields.
-- -----------------------------------------------------------------------------
create function app.update_owner(p_actor_id uuid, p_owner_id uuid, p_details jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.profiles;
begin
  t := app.lock_managed_account(p_actor_id, p_owner_id);
  if t.role <> 'OWNER' then
    perform app.fail('RD400', 'Not an owner account');
  end if;

  update public.owners
  set business_name = case when p_details ? 'business_name' then p_details ->> 'business_name' else business_name end,
      contact_person = case when p_details ? 'contact_person' then coalesce(p_details ->> 'contact_person', '') else contact_person end,
      phone = case when p_details ? 'phone' then p_details ->> 'phone' else phone end,
      email = case when p_details ? 'email' then p_details ->> 'email' else email end,
      address = case when p_details ? 'address' then p_details ->> 'address' else address end
  where id = t.id;

  if p_details ? 'contact_person' then
    update public.profiles set full_name = coalesce(p_details ->> 'contact_person', '') where id = t.id;
  end if;
  return jsonb_build_object('user_id', t.id);
end;
$$;

create function app.update_customer(p_actor_id uuid, p_customer_id uuid, p_details jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.profiles;
begin
  t := app.lock_managed_account(p_actor_id, p_customer_id);
  if t.role <> 'CUSTOMER' then
    perform app.fail('RD400', 'Not a customer account');
  end if;

  update public.customers
  set name = case when p_details ? 'name' then p_details ->> 'name' else name end,
      business_name = case when p_details ? 'business_name' then p_details ->> 'business_name' else business_name end,
      phone = case when p_details ? 'phone' then p_details ->> 'phone' else phone end,
      email = case when p_details ? 'email' then p_details ->> 'email' else email end,
      address = case when p_details ? 'address' then p_details ->> 'address' else address end
  where id = t.id;

  if p_details ? 'name' then
    update public.profiles set full_name = p_details ->> 'name' where id = t.id;
  end if;
  return jsonb_build_object('user_id', t.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Company setup and settings (BRD-01, BRD-03). Only the owner themself. The first
-- save completes onboarding. `logo_path` is changed only when the key is present
-- (null removes the logo). Issued invoices keep their own branding_snapshot.
-- -----------------------------------------------------------------------------
create function app.save_company_profile(p_owner_id uuid, p_details jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.user_role;
  v_completed timestamptz;
begin
  select p.role into v_role
  from public.profiles p
  where p.id = p_owner_id and p.status = 'ACTIVE';
  if v_role is distinct from 'OWNER' then
    perform app.fail('RD403', 'Only an active owner can change company details');
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    perform app.fail('RD400', 'Company details must be an object');
  end if;
  if p_details ? 'logo_path' and p_details ->> 'logo_path' is not null
     and p_details ->> 'logo_path' <> p_owner_id::text || '/logo.png' then
    perform app.fail('RD400', 'Invalid logo path');
  end if;

  perform app.set_actor(p_owner_id);

  insert into public.owner_company_profiles as c (
    owner_id, company_name, address, phone, email, bank_name, bank_branch,
    bank_account_name, bank_account_no, logo_path, onboarding_completed_at
  ) values (
    p_owner_id,
    p_details ->> 'company_name',
    p_details ->> 'address',
    p_details ->> 'phone',
    p_details ->> 'email',
    p_details ->> 'bank_name',
    p_details ->> 'bank_branch',
    p_details ->> 'bank_account_name',
    p_details ->> 'bank_account_no',
    p_details ->> 'logo_path',
    now()
  )
  on conflict (owner_id) do update
  set company_name = excluded.company_name,
      address = excluded.address,
      phone = excluded.phone,
      email = excluded.email,
      bank_name = excluded.bank_name,
      bank_branch = excluded.bank_branch,
      bank_account_name = excluded.bank_account_name,
      bank_account_no = excluded.bank_account_no,
      logo_path = case when p_details ? 'logo_path' then excluded.logo_path else c.logo_path end,
      onboarding_completed_at = coalesce(c.onboarding_completed_at, now())
  returning onboarding_completed_at into v_completed;

  return jsonb_build_object('owner_id', p_owner_id, 'onboarding_completed_at', v_completed);
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants: app.* functions are service_role only (0009 granted the earlier ones).
-- -----------------------------------------------------------------------------
revoke execute on function
  app.lock_managed_account(uuid, uuid),
  app.username_failures(text, timestamptz),
  app.login_gate_state(text, inet),
  app.record_login_attempt(text, inet, boolean, text, text),
  app.session_state(uuid),
  app.set_account_status(uuid, uuid, public.account_status, text),
  app.reset_account_password(uuid, uuid),
  app.complete_password_change(uuid),
  app.update_owner(uuid, uuid, jsonb),
  app.update_customer(uuid, uuid, jsonb),
  app.save_company_profile(uuid, jsonb)
from public, anon, authenticated;

grant execute on function
  app.lock_managed_account(uuid, uuid),
  app.username_failures(text, timestamptz),
  app.login_gate_state(text, inet),
  app.record_login_attempt(text, inet, boolean, text, text),
  app.session_state(uuid),
  app.set_account_status(uuid, uuid, public.account_status, text),
  app.reset_account_password(uuid, uuid),
  app.complete_password_change(uuid),
  app.update_owner(uuid, uuid, jsonb),
  app.update_customer(uuid, uuid, jsonb),
  app.save_company_profile(uuid, jsonb)
to service_role;

-- -----------------------------------------------------------------------------
-- public.rpc_* wrappers (service role only), as in 0012.
-- -----------------------------------------------------------------------------
create function public.rpc_login_gate_state(p_username text, p_ip inet) returns jsonb
language sql
set search_path = ''
as $$
  select app.login_gate_state(p_username, p_ip);
$$;

create function public.rpc_record_login_attempt(
  p_username text,
  p_ip inet,
  p_success boolean,
  p_reason text default null,
  p_user_agent text default null
) returns jsonb
language sql
set search_path = ''
as $$
  select app.record_login_attempt(p_username, p_ip, p_success, p_reason, p_user_agent);
$$;

create function public.rpc_session_state(p_user_id uuid) returns jsonb
language sql
set search_path = ''
as $$
  select app.session_state(p_user_id);
$$;

create function public.rpc_set_account_status(
  p_actor_id uuid,
  p_target_id uuid,
  p_status public.account_status,
  p_reason text
) returns jsonb
language sql
set search_path = ''
as $$
  select app.set_account_status(p_actor_id, p_target_id, p_status, p_reason);
$$;

create function public.rpc_reset_account_password(p_actor_id uuid, p_target_id uuid) returns jsonb
language sql
set search_path = ''
as $$
  select app.reset_account_password(p_actor_id, p_target_id);
$$;

create function public.rpc_complete_password_change(p_user_id uuid) returns jsonb
language sql
set search_path = ''
as $$
  select app.complete_password_change(p_user_id);
$$;

create function public.rpc_update_owner(p_actor_id uuid, p_owner_id uuid, p_details jsonb) returns jsonb
language sql
set search_path = ''
as $$
  select app.update_owner(p_actor_id, p_owner_id, p_details);
$$;

create function public.rpc_update_customer(p_actor_id uuid, p_customer_id uuid, p_details jsonb) returns jsonb
language sql
set search_path = ''
as $$
  select app.update_customer(p_actor_id, p_customer_id, p_details);
$$;

create function public.rpc_save_company_profile(p_owner_id uuid, p_details jsonb) returns jsonb
language sql
set search_path = ''
as $$
  select app.save_company_profile(p_owner_id, p_details);
$$;

revoke execute on function
  public.rpc_login_gate_state(text, inet),
  public.rpc_record_login_attempt(text, inet, boolean, text, text),
  public.rpc_session_state(uuid),
  public.rpc_set_account_status(uuid, uuid, public.account_status, text),
  public.rpc_reset_account_password(uuid, uuid),
  public.rpc_complete_password_change(uuid),
  public.rpc_update_owner(uuid, uuid, jsonb),
  public.rpc_update_customer(uuid, uuid, jsonb),
  public.rpc_save_company_profile(uuid, jsonb)
from public, anon, authenticated;

grant execute on function
  public.rpc_login_gate_state(text, inet),
  public.rpc_record_login_attempt(text, inet, boolean, text, text),
  public.rpc_session_state(uuid),
  public.rpc_set_account_status(uuid, uuid, public.account_status, text),
  public.rpc_reset_account_password(uuid, uuid),
  public.rpc_complete_password_change(uuid),
  public.rpc_update_owner(uuid, uuid, jsonb),
  public.rpc_update_customer(uuid, uuid, jsonb),
  public.rpc_save_company_profile(uuid, jsonb)
to service_role;

-- -----------------------------------------------------------------------------
-- Supabase Auth "Custom Access Token" hook (free plan). Runs before every token
-- is issued: password sign-in and refresh. Refuses tokens to:
--   * users without a profile, suspended or deactivated users,
--   * customers whose owner is not active (AUTH-10),
--   * password sign-ins while the account is locked (AUTH-08). Refreshes are not
--     refused for a lockout, so failed guesses by someone else cannot sign the
--     real user out.
-- Messages start with "RD_BLOCKED:" so the login action can show a clear message.
-- Only supabase_auth_admin may execute it. Enable it in the dashboard:
-- Authentication > Hooks > Customize Access Token (JWT) Claims (docs/database.md).
-- -----------------------------------------------------------------------------
create function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (event ->> 'user_id')::uuid;
  v_method text := event ->> 'authentication_method';
  p public.profiles;
  v_owner_status public.account_status;
  v_block text;
begin
  select * into p from public.profiles where id = v_user_id;
  if not found then
    v_block := 'NO_PROFILE';
  else
    select o.status into v_owner_status from public.profiles o where o.id = p.owner_id;
    if p.status = 'SUSPENDED' then
      v_block := 'SUSPENDED';
    elsif p.status = 'DEACTIVATED' then
      v_block := 'DEACTIVATED';
    elsif p.role = 'CUSTOMER' and v_owner_status is distinct from 'ACTIVE' then
      v_block := 'OWNER_INACTIVE';
    elsif v_method = 'password' and p.locked_until is not null and p.locked_until > now() then
      v_block := 'LOCKED';
    end if;
  end if;

  if v_block is not null then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'RD_BLOCKED:' || v_block
    ));
  end if;
  return jsonb_build_object('claims', event -> 'claims');
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  'Supabase Auth Custom Access Token hook: refuses tokens to blocked or locked accounts. supabase_auth_admin only.';

revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
