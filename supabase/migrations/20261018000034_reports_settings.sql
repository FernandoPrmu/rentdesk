-- =============================================================================
-- 0034 Dashboards, reports, settings editors, support view, agreement end reminders
--      (task 11: RPT-01..08, CP-01, ADM-04..08, AGR-03; decisions 77-86).
--
--   A. Settings: agreement end notice (AGR-03), one validation (app.settings_problems)
--      for the platform defaults and the owner's effective settings, and the only
--      write paths: rpc_update_platform_settings (admin) and rpc_update_owner_settings
--      (owner). Client write grants on both tables are revoked: every value is checked.
--   B. Support view (ADM-08): rpc_log_support_view writes a SUPPORT_VIEW audit row.
--   C. Agreement end reminder (AGR-03): catalogue event + daily-job candidates.
--   D. Report functions: public.report_*, SECURITY INVOKER and STABLE, so RLS decides
--      what they read and they cannot write. They are the only public functions that
--      `authenticated` may execute. One security-definer helper reads the owner's
--      service cost (a column clients cannot read, decision 64) after a tenant check.
--   E. Indexes for the date-range scans.
--
-- Money is bigint cents. Business dates are Asia/Colombo calendar dates.
-- =============================================================================

-- =============================================================================
-- A. Settings
-- =============================================================================
alter table public.platform_settings
  add column agreement_end_notice_days integer not null default 30
    constraint platform_settings_agreement_end_notice_days check (agreement_end_notice_days between 1 and 180);
alter table public.owner_settings
  add column agreement_end_notice_days integer
    constraint owner_settings_agreement_end_notice_days check (agreement_end_notice_days between 1 and 180);

-- New column at the end (create or replace view may only add columns at the end).
create or replace view public.owner_settings_effective
with (security_invoker = true) as
select
  o.id as owner_id,
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
  coalesce(s.weekly_summary_dow, p.weekly_summary_dow) as weekly_summary_dow,
  p.dispute_reminder_days,
  p.dispute_escalation_days,
  coalesce(s.agreement_end_notice_days, p.agreement_end_notice_days) as agreement_end_notice_days
from public.owners o
cross join public.platform_settings p
left join public.owner_settings s on s.owner_id = o.id;

-- Every write goes through the rpcs below (validated, audited).
revoke insert, update on public.owner_settings from authenticated;
revoke insert, update on public.platform_settings from authenticated;

-- Settings an owner may override (null = platform default). The rest are platform-only.
create function app.owner_setting_keys() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'meter_deadline_days', 'meter_reminder_days',
    'review_deadline_hours', 'review_reminder_hours', 'review_escalation_hours',
    'payment_due_days', 'payment_reminder_before_days', 'payment_reminder_on_due', 'payment_overdue_reminder_days',
    'slip_review_deadline_hours', 'slip_review_reminder_hours', 'slip_review_escalation_hours',
    'max_meter_rejections', 'rejected_photo_retention_days', 'payment_slip_retention_days',
    'grace_period_days', 'late_fee_enabled', 'late_fee_cents', 'estimated_billing_enabled',
    'service_ack_hours_urgent', 'service_ack_hours_normal',
    'service_admin_escalation_hours_urgent', 'service_admin_escalation_hours_normal',
    'weekly_summary_dow', 'agreement_end_notice_days'
  ]::text[];
$$;

create function app.platform_setting_keys() returns text[]
language sql immutable set search_path = '' as $$
  select app.owner_setting_keys() || array[
    'dispute_reminder_days', 'dispute_escalation_days',
    'login_max_failures', 'login_lockout_minutes', 'login_ip_max_failures', 'login_ip_window_minutes',
    'session_idle_minutes', 'session_max_hours',
    'email_daily_limit', 'email_monthly_limit', 'email_essential_reserve', 'email_max_attempts', 'email_reminder_expiry_days'
  ]::text[];
$$;

-- Problems in a complete settings object (platform defaults, or an owner's effective
-- settings), as "field: message". The same rules as src/lib/settings/rules.ts (decision 82);
-- settings.db.test.ts checks both agree.
create function app.settings_problems(s jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  v text[] := '{}';
  v_key text;
  v_lo integer;
  v_hi integer;
  v_val numeric;
  v_list integer[];
  v_i integer;
  -- [key, min, max]
  v_ranges text[][] := array[
    ['meter_deadline_days', '1', '28'],
    ['review_deadline_hours', '1', '336'],
    ['review_escalation_hours', '1', '720'],
    ['payment_due_days', '0', '90'],
    ['slip_review_deadline_hours', '1', '336'],
    ['slip_review_escalation_hours', '1', '720'],
    ['max_meter_rejections', '1', '10'],
    ['rejected_photo_retention_days', '1', '90'],
    ['payment_slip_retention_days', '30', '3650'],
    ['grace_period_days', '0', '90'],
    ['late_fee_cents', '0', '10000000'],
    ['service_ack_hours_urgent', '1', '168'],
    ['service_ack_hours_normal', '1', '168'],
    ['service_admin_escalation_hours_urgent', '1', '336'],
    ['service_admin_escalation_hours_normal', '1', '336'],
    ['weekly_summary_dow', '0', '6'],
    ['agreement_end_notice_days', '1', '180'],
    ['dispute_escalation_days', '1', '60'],
    ['login_max_failures', '3', '20'],
    ['login_lockout_minutes', '1', '1440'],
    ['login_ip_max_failures', '3', '1000'],
    ['login_ip_window_minutes', '1', '1440'],
    ['session_idle_minutes', '5', '1440'],
    ['session_max_hours', '1', '168'],
    ['email_daily_limit', '1', '100000'],
    ['email_monthly_limit', '1', '3000000'],
    ['email_essential_reserve', '0', '100000'],
    ['email_max_attempts', '1', '10'],
    ['email_reminder_expiry_days', '1', '30']
  ];
  -- [list key, item min, item max, max items, "below" key (items must be lower) or '']
  v_lists text[][] := array[
    ['meter_reminder_days', '1', '27', '5', 'meter_deadline_days'],
    ['review_reminder_hours', '1', '719', '5', 'review_escalation_hours'],
    ['slip_review_reminder_hours', '1', '719', '5', 'slip_review_escalation_hours'],
    ['payment_reminder_before_days', '1', '30', '5', ''],
    ['payment_overdue_reminder_days', '1', '365', '6', ''],
    ['dispute_reminder_days', '1', '59', '5', 'dispute_escalation_days']
  ];
  r text[];
begin
  foreach r slice 1 in array v_ranges loop
    v_key := r[1];
    if not (s ? v_key) then continue; end if;
    if jsonb_typeof(s -> v_key) <> 'number' or (s ->> v_key)::numeric <> trunc((s ->> v_key)::numeric) then
      v := v || format('%s: must be a whole number', v_key);
      continue;
    end if;
    v_val := (s ->> v_key)::numeric;
    v_lo := r[2]::integer;
    v_hi := r[3]::integer;
    if v_val < v_lo or v_val > v_hi then
      v := v || format('%s: must be between %s and %s', v_key, v_lo, v_hi);
    end if;
  end loop;

  foreach r slice 1 in array v_lists loop
    v_key := r[1];
    if not (s ? v_key) then continue; end if;
    if jsonb_typeof(s -> v_key) <> 'array' then
      v := v || format('%s: must be a list of whole numbers', v_key);
      continue;
    end if;
    begin
      select coalesce(array_agg(x::integer order by o), '{}') into v_list
      from jsonb_array_elements_text(s -> v_key) with ordinality as e(x, o);
    exception when others then
      v := v || format('%s: must be a list of whole numbers', v_key);
      continue;
    end;
    if cardinality(v_list) > r[4]::integer then
      v := v || format('%s: at most %s values', v_key, r[4]);
    end if;
    for v_i in 1 .. coalesce(cardinality(v_list), 0) loop
      if v_list[v_i] < r[2]::integer or v_list[v_i] > r[3]::integer then
        v := v || format('%s: each value must be between %s and %s', v_key, r[2], r[3]);
        exit;
      end if;
      if v_i > 1 and v_list[v_i] <= v_list[v_i - 1] then
        v := v || format('%s: values must go up, without repeats', v_key);
        exit;
      end if;
    end loop;
    if r[5] <> '' and s ? r[5] and jsonb_typeof(s -> r[5]) = 'number'
       and exists (select 1 from unnest(v_list) x where x >= (s ->> r[5])::numeric) then
      v := v || format('%s: every value must be lower than %s', v_key, r[5]);
    end if;
  end loop;

  -- Cross-field rules.
  if (s ->> 'review_escalation_hours')::numeric < (s ->> 'review_deadline_hours')::numeric then
    v := v || 'review_escalation_hours: must not be before review_deadline_hours'::text;
  end if;
  if (s ->> 'slip_review_escalation_hours')::numeric < (s ->> 'slip_review_deadline_hours')::numeric then
    v := v || 'slip_review_escalation_hours: must not be before slip_review_deadline_hours'::text;
  end if;
  if (s ->> 'service_admin_escalation_hours_urgent')::numeric <= (s ->> 'service_ack_hours_urgent')::numeric then
    v := v || 'service_admin_escalation_hours_urgent: must be later than service_ack_hours_urgent'::text;
  end if;
  if (s ->> 'service_admin_escalation_hours_normal')::numeric <= (s ->> 'service_ack_hours_normal')::numeric then
    v := v || 'service_admin_escalation_hours_normal: must be later than service_ack_hours_normal'::text;
  end if;
  if (s ->> 'service_ack_hours_urgent')::numeric > (s ->> 'service_ack_hours_normal')::numeric then
    v := v || 'service_ack_hours_urgent: must not be longer than service_ack_hours_normal'::text;
  end if;
  if (s ->> 'late_fee_enabled')::boolean and (s ->> 'late_fee_cents')::numeric <= 0 then
    v := v || 'late_fee_cents: enter the late fee, or switch it off'::text;
  end if;
  if (s ->> 'login_ip_max_failures')::numeric < (s ->> 'login_max_failures')::numeric then
    v := v || 'login_ip_max_failures: must not be lower than login_max_failures'::text;
  end if;
  if (s ->> 'session_idle_minutes')::numeric > (s ->> 'session_max_hours')::numeric * 60 then
    v := v || 'session_idle_minutes: must not be longer than session_max_hours'::text;
  end if;
  if (s ->> 'email_monthly_limit')::numeric < (s ->> 'email_daily_limit')::numeric then
    v := v || 'email_monthly_limit: must not be lower than email_daily_limit'::text;
  end if;
  if (s ->> 'email_essential_reserve')::numeric > (s ->> 'email_daily_limit')::numeric then
    v := v || 'email_essential_reserve: must not be more than email_daily_limit'::text;
  end if;
  foreach v_key in array array['payment_reminder_on_due', 'late_fee_enabled', 'estimated_billing_enabled'] loop
    if s ? v_key and jsonb_typeof(s -> v_key) <> 'boolean' then
      v := v || format('%s: must be yes or no', v_key);
    end if;
  end loop;
  return v;
end;
$$;

-- Admin: change platform defaults. Unknown keys and invalid values are refused; the
-- row's audit trigger records old -> new with the admin as actor.
create function app.update_platform_settings(p_actor_id uuid, p_changes jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.platform_settings;
  v_new public.platform_settings;
  v_bad text;
  v_problems text[];
  v_changed text[];
begin
  if not exists (select 1 from public.profiles p where p.id = p_actor_id and p.role = 'ADMIN' and p.status = 'ACTIVE') then
    perform app.fail('RD403', 'Only an admin can change platform settings');
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    perform app.fail('RD400', 'Nothing to change');
  end if;
  select k into v_bad from jsonb_object_keys(p_changes) k where k <> all (app.platform_setting_keys()) limit 1;
  if v_bad is not null then
    perform app.fail('RD400', format('Unknown setting: %s', v_bad));
  end if;
  if exists (select 1 from jsonb_each(p_changes) e where jsonb_typeof(e.value) = 'null') then
    perform app.fail('RD400', 'Platform settings cannot be empty');
  end if;
  perform app.set_actor(p_actor_id);
  select * into v_old from public.platform_settings where id for update;
  v_problems := app.settings_problems(to_jsonb(v_old) || p_changes);
  if cardinality(v_problems) > 0 then
    perform app.fail('RD400', array_to_string(v_problems, '; '));
  end if;
  v_new := jsonb_populate_record(v_old, p_changes);
  select coalesce(array_agg(k order by k), '{}') into v_changed
  from jsonb_object_keys(p_changes) k where (to_jsonb(v_old) -> k) is distinct from (to_jsonb(v_new) -> k);
  if cardinality(v_changed) = 0 then
    return jsonb_build_object('changed', '[]'::jsonb);
  end if;
  update public.platform_settings set
    meter_deadline_days = v_new.meter_deadline_days,
    meter_reminder_days = v_new.meter_reminder_days,
    review_deadline_hours = v_new.review_deadline_hours,
    review_reminder_hours = v_new.review_reminder_hours,
    review_escalation_hours = v_new.review_escalation_hours,
    payment_due_days = v_new.payment_due_days,
    payment_reminder_before_days = v_new.payment_reminder_before_days,
    payment_reminder_on_due = v_new.payment_reminder_on_due,
    payment_overdue_reminder_days = v_new.payment_overdue_reminder_days,
    slip_review_deadline_hours = v_new.slip_review_deadline_hours,
    slip_review_reminder_hours = v_new.slip_review_reminder_hours,
    slip_review_escalation_hours = v_new.slip_review_escalation_hours,
    max_meter_rejections = v_new.max_meter_rejections,
    rejected_photo_retention_days = v_new.rejected_photo_retention_days,
    payment_slip_retention_days = v_new.payment_slip_retention_days,
    grace_period_days = v_new.grace_period_days,
    late_fee_enabled = v_new.late_fee_enabled,
    late_fee_cents = v_new.late_fee_cents,
    estimated_billing_enabled = v_new.estimated_billing_enabled,
    service_ack_hours_urgent = v_new.service_ack_hours_urgent,
    service_ack_hours_normal = v_new.service_ack_hours_normal,
    service_admin_escalation_hours_urgent = v_new.service_admin_escalation_hours_urgent,
    service_admin_escalation_hours_normal = v_new.service_admin_escalation_hours_normal,
    weekly_summary_dow = v_new.weekly_summary_dow,
    agreement_end_notice_days = v_new.agreement_end_notice_days,
    dispute_reminder_days = v_new.dispute_reminder_days,
    dispute_escalation_days = v_new.dispute_escalation_days,
    login_max_failures = v_new.login_max_failures,
    login_lockout_minutes = v_new.login_lockout_minutes,
    login_ip_max_failures = v_new.login_ip_max_failures,
    login_ip_window_minutes = v_new.login_ip_window_minutes,
    session_idle_minutes = v_new.session_idle_minutes,
    session_max_hours = v_new.session_max_hours,
    email_daily_limit = v_new.email_daily_limit,
    email_monthly_limit = v_new.email_monthly_limit,
    email_essential_reserve = v_new.email_essential_reserve,
    email_max_attempts = v_new.email_max_attempts,
    email_reminder_expiry_days = v_new.email_reminder_expiry_days
  where id;
  return jsonb_build_object('changed', to_jsonb(v_changed));
end;
$$;

-- Owner: own overrides. A key set to null goes back to the platform default. The
-- effective result (overrides over the current platform defaults) must pass the rules.
create function app.update_owner_settings(p_actor_id uuid, p_changes jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.owner_settings;
  v_new public.owner_settings;
  v_bad text;
  v_problems text[];
  v_changed text[];
  v_effective jsonb;
begin
  if not exists (select 1 from public.profiles p where p.id = p_actor_id and p.role = 'OWNER' and p.status = 'ACTIVE') then
    perform app.fail('RD403', 'Only the owner can change these settings');
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    perform app.fail('RD400', 'Nothing to change');
  end if;
  select k into v_bad from jsonb_object_keys(p_changes) k where k <> all (app.owner_setting_keys()) limit 1;
  if v_bad is not null then
    perform app.fail('RD400', format('Unknown setting: %s', v_bad));
  end if;
  perform app.set_actor(p_actor_id);
  insert into public.owner_settings (owner_id) values (p_actor_id) on conflict (owner_id) do nothing;
  select * into v_old from public.owner_settings where owner_id = p_actor_id for update;
  v_new := jsonb_populate_record(v_old, p_changes);
  -- Platform defaults with this owner's non-null overrides on top.
  select to_jsonb(p) || jsonb_strip_nulls((select jsonb_object_agg(k, to_jsonb(v_new) -> k) from unnest(app.owner_setting_keys()) k))
  into v_effective from public.platform_settings p;
  v_problems := app.settings_problems(v_effective);
  if cardinality(v_problems) > 0 then
    perform app.fail('RD400', array_to_string(v_problems, '; '));
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_changed
  from jsonb_object_keys(p_changes) k where (to_jsonb(v_old) -> k) is distinct from (to_jsonb(v_new) -> k);
  if cardinality(v_changed) = 0 then
    return jsonb_build_object('changed', '[]'::jsonb);
  end if;
  update public.owner_settings set
    meter_deadline_days = v_new.meter_deadline_days,
    meter_reminder_days = v_new.meter_reminder_days,
    review_deadline_hours = v_new.review_deadline_hours,
    review_reminder_hours = v_new.review_reminder_hours,
    review_escalation_hours = v_new.review_escalation_hours,
    payment_due_days = v_new.payment_due_days,
    payment_reminder_before_days = v_new.payment_reminder_before_days,
    payment_reminder_on_due = v_new.payment_reminder_on_due,
    payment_overdue_reminder_days = v_new.payment_overdue_reminder_days,
    slip_review_deadline_hours = v_new.slip_review_deadline_hours,
    slip_review_reminder_hours = v_new.slip_review_reminder_hours,
    slip_review_escalation_hours = v_new.slip_review_escalation_hours,
    max_meter_rejections = v_new.max_meter_rejections,
    rejected_photo_retention_days = v_new.rejected_photo_retention_days,
    payment_slip_retention_days = v_new.payment_slip_retention_days,
    grace_period_days = v_new.grace_period_days,
    late_fee_enabled = v_new.late_fee_enabled,
    late_fee_cents = v_new.late_fee_cents,
    estimated_billing_enabled = v_new.estimated_billing_enabled,
    service_ack_hours_urgent = v_new.service_ack_hours_urgent,
    service_ack_hours_normal = v_new.service_ack_hours_normal,
    service_admin_escalation_hours_urgent = v_new.service_admin_escalation_hours_urgent,
    service_admin_escalation_hours_normal = v_new.service_admin_escalation_hours_normal,
    weekly_summary_dow = v_new.weekly_summary_dow,
    agreement_end_notice_days = v_new.agreement_end_notice_days
  where owner_id = p_actor_id;
  return jsonb_build_object('changed', to_jsonb(v_changed));
end;
$$;

-- =============================================================================
-- B. Support view (ADM-08, decision 81)
-- =============================================================================
create function app.log_support_view(p_admin_id uuid, p_owner_id uuid, p_path text, p_reason text) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if not exists (select 1 from public.profiles p where p.id = p_admin_id and p.role = 'ADMIN' and p.status = 'ACTIVE') then
    perform app.fail('RD403', 'Only an admin can open the support view');
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_owner_id and p.role = 'OWNER') then
    perform app.fail('RD404', 'Owner not found');
  end if;
  if p_path is null or length(p_path) > 300 or p_path !~ '^/admin/owners/' then
    perform app.fail('RD400', 'Invalid path');
  end if;
  if length(coalesce(p_reason, '')) > 300 then
    perform app.fail('RD400', 'The reason is too long');
  end if;
  insert into public.audit_logs (actor_id, actor_role, owner_id, action, entity, entity_id, details)
  values (p_admin_id, 'ADMIN', p_owner_id, 'SUPPORT_VIEW', 'owners', p_owner_id,
          jsonb_build_object('path', p_path) || case when nullif(btrim(p_reason), '') is null then '{}'::jsonb
                                                     else jsonb_build_object('reason', btrim(p_reason)) end)
  returning id into v_id;
  return v_id;
end;
$$;

-- =============================================================================
-- C. Agreement end reminder (AGR-03, decision 86)
-- =============================================================================
insert into public.notification_events (event, category, email, sms) values ('agreement.ending', 'ESSENTIAL', true, false);

-- Live agreements whose end date is within the owner's notice (today counts), not
-- reminded yet for this end date. A changed end date gets its own reminder.
create function app.cron_ending_agreements(p_today date, p_limit integer default 100) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.end_date, x.agreement_id), '[]'::jsonb)
  from (
    select a.id as agreement_id, a.owner_id, a.customer_id, a.end_date, (a.end_date - p_today) as days_left,
           c.name as customer_name, m.brand || ' ' || m.model as machine_name, m.serial_no
    from public.rental_agreements a
    join public.owner_settings_effective s on s.owner_id = a.owner_id
    join public.profiles op on op.id = a.owner_id and op.status = 'ACTIVE'
    join public.customers c on c.id = a.customer_id
    join public.machines m on m.id = a.machine_id
    where a.status = 'ACTIVE'
      and a.end_date is not null
      and a.end_date >= p_today
      and a.end_date - p_today <= s.agreement_end_notice_days
      and not exists (
        select 1 from public.notifications n
        where n.owner_id = a.owner_id and n.event = 'agreement.ending'
          and n.data ->> 'dedupe_key' = 'agreement-ending:' || a.id::text || ':' || a.end_date::text
      )
    order by a.end_date, a.id
    limit greatest(p_limit, 1)
  ) x;
$$;

create index notifications_dedupe_idx on public.notifications (owner_id, (data ->> 'dedupe_key'))
  where data ? 'dedupe_key';
create index rental_agreements_end_date_idx on public.rental_agreements (end_date) where status = 'ACTIVE' and end_date is not null;

-- =============================================================================
-- D. Reports (security invoker: RLS applies; stable: read-only)
-- =============================================================================

-- Owner service cost by machine, customer and type, by the date the work was resolved
-- (decision 79). The cost column is hidden from clients (decision 64), so this helper
-- is security definer and checks the tenant itself: the owner, or an admin.
create function app.report_service_costs(p_owner_id uuid, p_from date, p_to date)
returns table (machine_id uuid, customer_id uuid, type public.service_request_type, cost_cents bigint, resolved integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (app.is_admin() or (app.current_user_role() = 'OWNER' and app.current_owner_id() = p_owner_id)) then
    return;
  end if;
  return query
  select r.machine_id, r.customer_id, r.type, coalesce(sum(r.cost_cents), 0)::bigint, count(*)::integer
  from public.service_requests r
  where r.owner_id = p_owner_id
    and r.resolved_at is not null
    and (r.resolved_at at time zone 'Asia/Colombo')::date between p_from and p_to
    and r.status <> 'CANCELLED'
  group by r.machine_id, r.customer_id, r.type;
end;
$$;

-- Invoiced lines of issued, not-cancelled bills (by issue date), with what each line
-- counts as (decision 77): CREDIT lines that carry money already received
-- (overpayment, advance, cancelled-invoice credit) are 'PAID_CREDIT' and do not
-- reduce what was invoiced; estimate, dispute, service-discount and manual credits
-- are 'DISCOUNT' and do.
create function app.report_invoice_lines(p_owner_id uuid, p_from date, p_to date)
returns table (invoice_id uuid, customer_id uuid, machine_id uuid, issued_on date, line_type public.invoice_line_type,
               kind text, amount_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select i.id, i.customer_id, i.machine_id, (i.issued_at at time zone 'Asia/Colombo')::date, l.line_type,
         case
           when l.line_type = 'COMMITMENT' then 'COMMITMENT'
           when l.line_type in ('BW_EXCESS', 'COLOUR_EXCESS') then 'EXCESS'
           when l.line_type in ('LATE_FEE', 'ADJUSTMENT') then 'OTHER'
           when c.kind in ('OVERPAYMENT', 'ADVANCE', 'CANCELLED_INVOICE') then 'PAID_CREDIT'
           else 'DISCOUNT'
         end,
         l.amount_cents
  from public.invoices i
  join public.invoice_lines l on l.invoice_id = i.id
  left join public.credits c on c.id = l.credit_id
  where i.owner_id = p_owner_id
    and i.issued_at is not null
    and i.status <> 'CANCELLED'
    and (i.issued_at at time zone 'Asia/Colombo')::date between p_from and p_to;
$$;

-- Money collected (decision 77), one row per item: accepted payments by paid date (net
-- of reversals: reversed payments are not counted; deposit-applied payments are),
-- advance payments recorded with an agreement by received date, security deposit kept
-- (retained) by its date, minus credit refunds by refund date. Deposits received and
-- refunded are not income.
create function app.report_collected(p_owner_id uuid, p_from date, p_to date)
returns table (customer_id uuid, on_date date, source text, amount_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.customer_id, p.paid_on, 'PAYMENT', coalesce(p.accepted_amount_cents, p.amount_cents)
  from public.payments p
  where p.owner_id = p_owner_id and p.status in ('ACCEPTED', 'PARTIAL') and p.paid_on between p_from and p_to
  union all
  select c.customer_id, coalesce(c.received_on, (c.created_at at time zone 'Asia/Colombo')::date), 'ADVANCE', c.amount_cents
  from public.credits c
  where c.owner_id = p_owner_id and c.kind = 'ADVANCE' and c.source_payment_id is null and c.status <> 'VOID'
    and coalesce(c.received_on, (c.created_at at time zone 'Asia/Colombo')::date) between p_from and p_to
  union all
  select d.customer_id, d.occurred_on, 'DEPOSIT_KEPT', d.amount_cents
  from public.deposit_transactions d
  where d.owner_id = p_owner_id and d.kind = 'RETAINED' and d.occurred_on between p_from and p_to
  union all
  select r.customer_id, r.refunded_on, 'REFUND', -r.amount_cents
  from public.credit_refunds r
  where r.owner_id = p_owner_id and r.refunded_on between p_from and p_to;
$$;

-- RPT-02: monthly income and sales.
create function public.report_income(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with months as (
    select gs::date as month
    from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') gs
  ),
  inv as (
    select date_trunc('month', issued_on)::date as month,
           coalesce(sum(amount_cents) filter (where kind = 'COMMITMENT'), 0) as commitment,
           coalesce(sum(amount_cents) filter (where kind = 'EXCESS'), 0) as excess,
           coalesce(sum(amount_cents) filter (where kind = 'OTHER'), 0) as other,
           coalesce(sum(amount_cents) filter (where kind = 'DISCOUNT'), 0) as discounts,
           count(distinct invoice_id) as invoices
    from app.report_invoice_lines(p_owner_id, p_from, p_to)
    group by 1
  ),
  col as (
    select date_trunc('month', on_date)::date as month,
           coalesce(sum(amount_cents) filter (where source = 'PAYMENT'), 0) as payments,
           coalesce(sum(amount_cents) filter (where source = 'ADVANCE'), 0) as advances,
           coalesce(sum(amount_cents) filter (where source = 'DEPOSIT_KEPT'), 0) as deposits_kept,
           coalesce(sum(amount_cents) filter (where source = 'REFUND'), 0) as refunds
    from app.report_collected(p_owner_id, p_from, p_to)
    group by 1
  )
  select jsonb_build_object('months', coalesce(jsonb_agg(jsonb_build_object(
    'month', m.month,
    'commitment_cents', coalesce(inv.commitment, 0),
    'excess_cents', coalesce(inv.excess, 0),
    'other_cents', coalesce(inv.other, 0),
    'discount_cents', coalesce(inv.discounts, 0),
    'invoices', coalesce(inv.invoices, 0),
    'payments_cents', coalesce(col.payments, 0),
    'advances_cents', coalesce(col.advances, 0),
    'deposits_kept_cents', coalesce(col.deposits_kept, 0),
    'refunds_cents', coalesce(col.refunds, 0)
  ) order by m.month), '[]'::jsonb))
  from months m
  left join inv on inv.month = m.month
  left join col on col.month = m.month;
$$;

-- RPT-03: machine-wise performance (revenue, copies, excess, service and toner cost).
create function public.report_machines(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with lines as (
    select machine_id,
           coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT'), 0) as revenue,
           coalesce(sum(amount_cents) filter (where kind = 'COMMITMENT'), 0) as commitment,
           coalesce(sum(amount_cents) filter (where line_type = 'BW_EXCESS'), 0) as bw_excess,
           coalesce(sum(amount_cents) filter (where line_type = 'COLOUR_EXCESS'), 0) as colour_excess,
           coalesce(sum(amount_cents) filter (where kind in ('OTHER', 'DISCOUNT')), 0) as other
    from app.report_invoice_lines(p_owner_id, p_from, p_to)
    group by machine_id
  ),
  copies as (
    select i.machine_id,
           coalesce(sum((c ->> 'usage')::bigint) filter (where c ->> 'counter_type' = 'BW'), 0) as bw,
           coalesce(sum((c ->> 'usage')::bigint) filter (where c ->> 'counter_type' = 'COLOUR'), 0) as colour
    from public.invoices i
    cross join lateral jsonb_array_elements(coalesce(i.calculation -> 'counters', '[]'::jsonb)) c
    where i.owner_id = p_owner_id and i.type = 'NORMAL' and i.issued_at is not null and i.status <> 'CANCELLED'
      and (i.issued_at at time zone 'Asia/Colombo')::date between p_from and p_to
    group by i.machine_id
  ),
  costs as (
    select machine_id,
           sum(cost_cents) as service_cost,
           coalesce(sum(cost_cents) filter (where type = 'TONER'), 0) as toner_cost
    from app.report_service_costs(p_owner_id, p_from, p_to)
    group by machine_id
  ),
  requests as (
    select machine_id, count(*) as requests, count(*) filter (where type = 'TONER') as toner_requests
    from public.service_requests
    where owner_id = p_owner_id and (created_at at time zone 'Asia/Colombo')::date between p_from and p_to
    group by machine_id
  ),
  live as (
    select a.machine_id, c.name as customer
    from public.rental_agreements a join public.customers c on c.id = a.customer_id
    where a.owner_id = p_owner_id and a.status = 'ACTIVE'
  )
  select jsonb_build_object('machines', coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'brand', m.brand, 'model', m.model, 'serial_no', m.serial_no, 'type', m.type, 'status', m.status,
    'customer', live.customer,
    'revenue_cents', coalesce(l.revenue, 0), 'commitment_cents', coalesce(l.commitment, 0),
    'bw_excess_cents', coalesce(l.bw_excess, 0), 'colour_excess_cents', coalesce(l.colour_excess, 0),
    'other_cents', coalesce(l.other, 0),
    'bw_copies', coalesce(cp.bw, 0), 'colour_copies', coalesce(cp.colour, 0),
    'service_cost_cents', coalesce(co.service_cost, 0), 'toner_cost_cents', coalesce(co.toner_cost, 0),
    'requests', coalesce(rq.requests, 0), 'toner_requests', coalesce(rq.toner_requests, 0)
  ) order by coalesce(l.revenue, 0) desc, m.brand, m.model, m.serial_no), '[]'::jsonb))
  from public.machines m
  left join lines l on l.machine_id = m.id
  left join copies cp on cp.machine_id = m.id
  left join costs co on co.machine_id = m.id
  left join requests rq on rq.machine_id = m.id
  left join live on live.machine_id = m.id
  where m.owner_id = p_owner_id
    and (m.status <> 'RETIRED' or l.machine_id is not null or co.machine_id is not null);
$$;

-- RPT-05: customer-wise (invoices, payments, balance, payment behaviour).
create function public.report_customers(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with inv as (
    select customer_id,
           coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT'), 0) as invoiced,
           count(distinct invoice_id) as invoices
    from app.report_invoice_lines(p_owner_id, p_from, p_to)
    group by customer_id
  ),
  col as (
    select customer_id, sum(amount_cents) as collected
    from app.report_collected(p_owner_id, p_from, p_to)
    group by customer_id
  ),
  -- Bills due in the range that are paid: on time when the last money arrived by the due date.
  paid as (
    select i.customer_id, i.id, i.due_date, (i.issued_at at time zone 'Asia/Colombo')::date as issued_on,
           max(p.paid_on) as paid_on
    from public.invoices i
    join public.payment_allocations a on a.invoice_id = i.id and a.released_at is null and a.applied_cents > 0
    join public.payments p on p.id = a.payment_id and p.status in ('ACCEPTED', 'PARTIAL')
    where i.owner_id = p_owner_id and i.status = 'PAID' and i.due_date between p_from and p_to
    group by i.customer_id, i.id, i.due_date, i.issued_at
  ),
  behaviour as (
    select customer_id, count(*) as paid_bills,
           count(*) filter (where paid_on <= due_date) as on_time,
           round(avg(paid_on - issued_on), 1) as avg_days_to_pay
    from paid group by customer_id
  ),
  bal as (
    select customer_id,
           sum(total_cents - amount_paid_cents) as outstanding,
           sum(total_cents - amount_paid_cents) filter (
             where due_date < (now() at time zone 'Asia/Colombo')::date and status <> 'PAYMENT_SUBMITTED') as overdue
    from public.invoices
    where owner_id = p_owner_id and invoice_no is not null
      and status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
    group by customer_id
  ),
  cred as (
    select customer_id, sum(amount_cents - refunded_cents) as credit
    from public.credits where owner_id = p_owner_id and status = 'AVAILABLE'
    group by customer_id
  ),
  machines as (
    select customer_id, count(*) as machines from public.rental_agreements
    where owner_id = p_owner_id and status = 'ACTIVE' group by customer_id
  )
  select jsonb_build_object('customers', coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'business_name', c.business_name, 'status', pr.status,
    'machines', coalesce(mc.machines, 0),
    'invoiced_cents', coalesce(inv.invoiced, 0), 'invoices', coalesce(inv.invoices, 0),
    'collected_cents', coalesce(col.collected, 0),
    'outstanding_cents', coalesce(bal.outstanding, 0), 'overdue_cents', coalesce(bal.overdue, 0),
    'credit_cents', coalesce(cred.credit, 0),
    'paid_bills', coalesce(b.paid_bills, 0), 'paid_on_time', coalesce(b.on_time, 0),
    'avg_days_to_pay', b.avg_days_to_pay
  ) order by coalesce(bal.overdue, 0) desc, coalesce(bal.outstanding, 0) desc, c.name), '[]'::jsonb))
  from public.customers c
  join public.profiles pr on pr.id = c.id
  left join inv on inv.customer_id = c.id
  left join col on col.customer_id = c.id
  left join behaviour b on b.customer_id = c.id
  left join bal on bal.customer_id = c.id
  left join cred on cred.customer_id = c.id
  left join machines mc on mc.customer_id = c.id
  where c.owner_id = p_owner_id
    and (pr.status = 'ACTIVE' or inv.customer_id is not null or col.customer_id is not null or bal.customer_id is not null);
$$;

-- RPT-06: service and toner demand (counts by type, machine, customer and month;
-- response times; recent toner request dates for the forecast, decision 80).
create function public.report_service_demand(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with r as (
    -- Named columns: cost_cents is not readable by clients (decision 64).
    select sr.id, sr.machine_id, sr.customer_id, sr.type, sr.urgency, sr.status, sr.toner_colours, sr.rating,
           sr.created_at, sr.acknowledged_at, sr.resolved_at,
           (sr.created_at at time zone 'Asia/Colombo')::date as created_on
    from public.service_requests sr
    where sr.owner_id = p_owner_id and (sr.created_at at time zone 'Asia/Colombo')::date between p_from and p_to
  ),
  machine_names as (
    select id, brand || ' ' || model || ' (' || serial_no || ')' as name, type from public.machines where owner_id = p_owner_id
  )
  select jsonb_build_object(
    'total', (select count(*) from r),
    'open', (select count(*) from r where status not in ('CLOSED', 'CANCELLED', 'RESOLVED')),
    'by_type', (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb) from (select type, count(*) n from r group by type) x),
    'by_urgency', (select coalesce(jsonb_object_agg(urgency, n), '{}'::jsonb) from (select urgency, count(*) n from r group by urgency) x),
    'by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', month, 'requests', n, 'toner', t) order by month), '[]'::jsonb)
                 from (select date_trunc('month', created_on)::date as month, count(*) as n, count(*) filter (where type = 'TONER') t from r group by 1) x),
    'toner_colours', (select coalesce(jsonb_object_agg(colour, n), '{}'::jsonb)
                      from (select colour, count(*) n from r, unnest(r.toner_colours) colour where r.type = 'TONER' group by colour) x),
    'avg_ack_hours', (select round(avg(extract(epoch from acknowledged_at - created_at) / 3600)::numeric, 1) from r where acknowledged_at is not null),
    'avg_resolve_hours', (select round(avg(extract(epoch from resolved_at - created_at) / 3600)::numeric, 1) from r where resolved_at is not null),
    'avg_rating', (select round(avg(rating)::numeric, 2) from r where rating is not null),
    'ratings', (select count(*) from r where rating is not null),
    'by_machine', (select coalesce(jsonb_agg(x order by x.requests desc, x.name), '[]'::jsonb) from (
       select r.machine_id as id, mn.name, count(*) as requests,
              count(*) filter (where r.type = 'TONER') as toner,
              count(*) filter (where r.type = 'BREAKDOWN') as breakdowns
       from r join machine_names mn on mn.id = r.machine_id group by r.machine_id, mn.name) x),
    'by_customer', (select coalesce(jsonb_agg(x order by x.requests desc, x.name), '[]'::jsonb) from (
       select r.customer_id as id, c.name, count(*) as requests, count(*) filter (where r.type = 'TONER') as toner
       from r join public.customers c on c.id = r.customer_id group by r.customer_id, c.name) x),
    -- Toner history up to the end of the range, newest 6 per machine (forecast input).
    'toner_history', (select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) from (
       select mn.id, mn.name, mn.type,
              (select jsonb_agg(d order by d) from (
                 select (sr.created_at at time zone 'Asia/Colombo')::date d
                 from public.service_requests sr
                 where sr.owner_id = p_owner_id and sr.machine_id = mn.id and sr.type = 'TONER' and sr.status <> 'CANCELLED'
                   and (sr.created_at at time zone 'Asia/Colombo')::date <= p_to
                 order by sr.created_at desc limit 6) h) as dates
       from machine_names mn
       where exists (select 1 from public.service_requests sr where sr.owner_id = p_owner_id and sr.machine_id = mn.id and sr.type = 'TONER')) x)
  );
$$;

-- Usage trends: copies per month (by the bill's period end) per machine and customer,
-- from the engine's stored calculation on normal (not estimated) bills.
create function public.report_usage(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object('rows', coalesce(jsonb_agg(x order by x.month, x.machine), '[]'::jsonb))
  from (
    select date_trunc('month', i.period_end)::date as month,
           i.machine_id, m.brand || ' ' || m.model || ' (' || m.serial_no || ')' as machine,
           i.customer_id, c.name as customer,
           coalesce(sum((k ->> 'usage')::bigint) filter (where k ->> 'counter_type' = 'BW'), 0) as bw,
           coalesce(sum((k ->> 'usage')::bigint) filter (where k ->> 'counter_type' = 'COLOUR'), 0) as colour
    from public.invoices i
    join public.machines m on m.id = i.machine_id
    join public.customers c on c.id = i.customer_id
    cross join lateral jsonb_array_elements(coalesce(i.calculation -> 'counters', '[]'::jsonb)) k
    where i.owner_id = p_owner_id and i.type = 'NORMAL' and i.issued_at is not null and i.status <> 'CANCELLED'
      and i.period_end between p_from and p_to
    group by 1, i.machine_id, m.brand, m.model, m.serial_no, i.customer_id, c.name
  ) x;
$$;

-- Rental information (spec 10.2): machines rented vs available, agreement end dates.
create function public.report_rental(p_owner_id uuid, p_today date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'machines', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                 from (select status, count(*) n from public.machines where owner_id = p_owner_id group by status) x),
    'notice_days', (select agreement_end_notice_days from public.owner_settings_effective where owner_id = p_owner_id),
    'agreements', (select coalesce(jsonb_agg(x order by x.end_date nulls last, x.customer), '[]'::jsonb) from (
       select a.id, a.start_date, a.end_date, a.next_cycle_date, a.monthly_commitment_cents,
              case when a.end_date is null then null else a.end_date - p_today end as days_left,
              c.name as customer, m.brand || ' ' || m.model || ' (' || m.serial_no || ')' as machine, m.type
       from public.rental_agreements a
       join public.customers c on c.id = a.customer_id
       join public.machines m on m.id = a.machine_id
       where a.owner_id = p_owner_id and a.status = 'ACTIVE') x)
  );
$$;

-- Billing cycle status (spec 10.2): tickets by stage, average time per stage, late
-- submissions and missed stage deadlines, for cycles dated in the range.
create function public.report_cycle_status(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with t as (
    select * from public.billing_cycle_tickets
    where owner_id = p_owner_id and cycle_date between p_from and p_to
  ),
  ev as (
    select e.ticket_id, e.from_status, e.to_status, e.event_type, e.created_at,
           lead(e.created_at) over (partition by e.ticket_id order by e.created_at, e.id) as next_at
    from public.ticket_events e
    join t on t.id = e.ticket_id
    where e.to_status is not null and (e.from_status is distinct from e.to_status or e.event_type = 'CREATED')
  )
  select jsonb_build_object(
    'tickets', (select count(*) from t),
    'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from t group by status) x),
    'avg_hours', (select coalesce(jsonb_object_agg(to_status, h), '{}'::jsonb) from (
       select to_status, round(avg(extract(epoch from next_at - created_at) / 3600)::numeric, 1) h
       from ev where next_at is not null group by to_status) x),
    'late_tickets', (select count(*) from t where t.is_late),
    'went_overdue', (select count(distinct ticket_id) from ev where to_status = 'OVERDUE'),
    'late_readings', (select count(distinct s.ticket_id) from public.meter_submissions s
       join ev on ev.ticket_id = s.ticket_id and ev.to_status = 'OVERDUE' and ev.from_status = 'METER_REQUESTED'
       where s.submitted_at > ev.created_at),
    'escalations', (select count(*) from public.ticket_events e join t on t.id = e.ticket_id where e.event_type = 'ESCALATION'),
    'reminders', (select count(*) from public.ticket_events e join t on t.id = e.ticket_id where e.event_type = 'REMINDER')
  );
$$;

-- RPT-04: unpaid issued bills for the ageing report and its export (the buckets are made
-- in TS, src/lib/payments/ageing.ts, as of the chosen date).
create function public.report_ageing_invoices(p_owner_id uuid) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'invoice_no', i.invoice_no, 'customer_id', i.customer_id, 'customer_name', c.name,
    'status', i.status, 'due_date', i.due_date, 'balance_cents', i.total_cents - i.amount_paid_cents
  ) order by i.due_date nulls last, i.invoice_no), '[]'::jsonb)
  from public.invoices i join public.customers c on c.id = i.customer_id
  where i.owner_id = p_owner_id and i.invoice_no is not null
    and i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
    and i.total_cents > i.amount_paid_cents;
$$;

-- RPT-01: the owner dashboard in one call.
create function public.report_owner_dashboard(p_owner_id uuid, p_today date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select date_trunc('month', p_today)::date as this_start,
           (date_trunc('month', p_today) - interval '1 month')::date as last_start,
           (date_trunc('month', p_today) - interval '1 day')::date as last_end,
           -- Same point in last month (31 Oct -> 30 Sep).
           least((date_trunc('month', p_today) - interval '1 month')::date + (p_today - date_trunc('month', p_today)::date),
                 (date_trunc('month', p_today) - interval '1 day')::date) as last_same_day
  ),
  settings as (select * from public.owner_settings_effective where owner_id = p_owner_id),
  unpaid as (
    select i.status, i.due_date, i.total_cents - i.amount_paid_cents as balance
    from public.invoices i
    where i.owner_id = p_owner_id and i.invoice_no is not null and i.total_cents > i.amount_paid_cents
      and i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
  ),
  open_requests as (
    select r.id, r.type, r.urgency, r.status, r.created_at, r.escalation_level, r.toner_colours, r.part_name,
           c.name as customer,
           r.status = 'NEW' and r.created_at + make_interval(hours =>
             case when r.urgency in ('URGENT', 'HIGH') then s.service_ack_hours_urgent else s.service_ack_hours_normal end) < now() as overdue
    from public.service_requests r
    join public.customers c on c.id = r.customer_id
    cross join settings s
    where r.owner_id = p_owner_id and r.status in ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED')
  )
  select jsonb_build_object(
    'today', p_today,
    'collected_this_month', (select coalesce(sum(amount_cents), 0) from bounds b, app.report_collected(p_owner_id, b.this_start, p_today)),
    'collected_last_month', (select coalesce(sum(amount_cents), 0) from bounds b, app.report_collected(p_owner_id, b.last_start, b.last_end)),
    'collected_last_month_to_date', (select coalesce(sum(amount_cents), 0) from bounds b, app.report_collected(p_owner_id, b.last_start, b.last_same_day)),
    'invoiced_this_month', (select coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT'), 0)
                            from bounds b, app.report_invoice_lines(p_owner_id, b.this_start, p_today)),
    'invoiced_last_month', (select coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT'), 0)
                            from bounds b, app.report_invoice_lines(p_owner_id, b.last_start, b.last_end)),
    'outstanding_cents', (select coalesce(sum(balance), 0) from unpaid),
    'overdue_cents', (select coalesce(sum(balance) filter (where status <> 'PAYMENT_SUBMITTED' and due_date < p_today), 0) from unpaid),
    'overdue_bills', (select count(*) filter (where status <> 'PAYMENT_SUBMITTED' and due_date < p_today) from unpaid),
    'readings_to_review', (select count(*) from public.billing_cycle_tickets where owner_id = p_owner_id and status = 'PENDING_OWNER_REVIEW'),
    'slips_to_verify', (select count(*) from public.payments where owner_id = p_owner_id and status = 'SUBMITTED'),
    'tickets_by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
       select status, count(*) n from public.billing_cycle_tickets
       where owner_id = p_owner_id and status not in ('CLOSED', 'CANCELLED') group by status) x),
    'tickets_escalated', (select count(*) from public.billing_cycle_tickets
       where owner_id = p_owner_id and status not in ('CLOSED', 'CANCELLED') and escalation_level > 0),
    'service', jsonb_build_object(
       'total', (select count(*) from open_requests),
       'by_urgency', (select coalesce(jsonb_object_agg(urgency, n), '{}'::jsonb) from (select urgency, count(*) n from open_requests group by urgency) x),
       'by_type', (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb) from (select type, count(*) n from open_requests group by type) x),
       'overdue', (select count(*) from open_requests where overdue),
       'to_confirm', (select count(*) from open_requests where status = 'RESOLVED'),
       'top', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select id, type, urgency, status, customer, overdue, toner_colours, part_name from open_requests
          order by case urgency when 'URGENT' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end, overdue desc, created_at
          limit 5) x)
    ),
    'deposits', (select jsonb_build_object('count', count(*), 'held_cents', coalesce(sum(b.held_cents), 0))
                 from public.agreement_deposit_balances b
                 join public.rental_agreements a on a.id = b.agreement_id and a.status = 'TERMINATED'
                 where a.owner_id = p_owner_id and b.held_cents > 0),
    'machines', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
       select status, count(*) n from public.machines where owner_id = p_owner_id group by status) x),
    'machines_in_service', (select count(distinct r.machine_id) from public.service_requests r
       join public.machines m on m.id = r.machine_id and m.status = 'RENTED'
       where r.owner_id = p_owner_id and r.status in ('ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS')),
    'rating', (select jsonb_build_object('average', round(avg(rating)::numeric, 2), 'count', count(rating))
               from public.service_requests where owner_id = p_owner_id and rating is not null),
    'ending_soon', (select count(*) from public.rental_agreements a cross join settings s
       where a.owner_id = p_owner_id and a.status = 'ACTIVE' and a.end_date is not null
         and a.end_date between p_today and p_today + s.agreement_end_notice_days),
    'top_machines', (select coalesce(jsonb_agg(x order by x.revenue_cents desc), '[]'::jsonb) from (
       select l.machine_id as id, m.brand || ' ' || m.model || ' (' || m.serial_no || ')' as name,
              sum(l.amount_cents) filter (where l.kind <> 'PAID_CREDIT') as revenue_cents
       from bounds b, app.report_invoice_lines(p_owner_id, (b.this_start - interval '2 months')::date, p_today) l
       join public.machines m on m.id = l.machine_id
       group by l.machine_id, m.brand, m.model, m.serial_no
       order by 3 desc limit 5) x),
    'recent_payments', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
       select p.id, p.paid_on, p.status, coalesce(p.accepted_amount_cents, p.amount_cents) as amount_cents, p.method, c.name as customer
       from public.payments p join public.customers c on c.id = p.customer_id
       where p.owner_id = p_owner_id and p.status in ('ACCEPTED', 'PARTIAL')
       order by p.paid_on desc, p.verified_at desc nulls last limit 5) x)
  );
$$;

-- CP-01: the customer's own dashboard (RLS: only their rows; the owner's settings are
-- not needed).
create function public.report_customer_dashboard() returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with me as (select app.current_customer_id() as id)
  select jsonb_build_object(
    'outstanding_cents', (select coalesce(sum(i.total_cents - i.amount_paid_cents), 0) from public.invoices i, me
       where i.customer_id = me.id and i.invoice_no is not null
         and i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')),
    'credit_cents', (select coalesce(sum(c.amount_cents - c.refunded_cents), 0) from public.credits c, me
       where c.customer_id = me.id and c.status = 'AVAILABLE'),
    'machines', (select coalesce(jsonb_agg(x order by x.next_cycle_date, x.name), '[]'::jsonb) from (
       select a.id as agreement_id, m.brand || ' ' || m.model as name, m.serial_no, m.type, a.next_cycle_date, a.end_date,
              a.installation_location as location
       from public.rental_agreements a join public.machines m on m.id = a.machine_id, me
       where a.customer_id = me.id and a.status = 'ACTIVE') x),
    'latest_invoice', (select to_jsonb(x) from (
       select i.id, i.invoice_no, i.status, i.total_cents, i.amount_paid_cents, i.due_date, i.issued_at, i.pdf_path is not null as has_pdf
       from public.invoices i, me
       where i.customer_id = me.id and i.invoice_no is not null and i.status <> 'CANCELLED'
       order by i.issued_at desc nulls last limit 1) x),
    'recent_payments', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
       select p.id, p.paid_on, p.status, p.amount_cents, p.accepted_amount_cents
       from public.payments p, me where p.customer_id = me.id
       order by p.submitted_at desc limit 3) x),
    'open_requests', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
       select r.id, r.type, r.status, r.urgency, r.toner_colours, r.part_name, m.brand || ' ' || m.model as machine
       from public.service_requests r join public.machines m on m.id = r.machine_id, me
       where r.customer_id = me.id and r.status in ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED')
       order by r.created_at desc limit 5) x)
  );
$$;

-- ADM-04: the platform dashboard (admins only; everyone else gets null).
create function public.report_admin_dashboard(p_today date, p_now timestamptz) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when not app.is_admin() then null else jsonb_build_object(
    'owners', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
       select status, count(*) n from public.profiles where role = 'OWNER' group by status) x),
    'customers', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
       select status, count(*) n from public.profiles where role = 'CUSTOMER' group by status) x),
    'machines', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
       select status, count(*) n from public.machines group by status) x),
    'open_tickets', (select count(*) from public.billing_cycle_tickets where status not in ('CLOSED', 'CANCELLED')),
    'escalated_tickets', (select count(*) from public.billing_cycle_tickets where status not in ('CLOSED', 'CANCELLED') and escalation_level >= 2),
    'open_requests', (select count(*) from public.service_requests where status in ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED')),
    'invoices_this_month', (select jsonb_build_object('count', count(*), 'total_cents', coalesce(sum(total_cents), 0))
       from public.invoices where issued_at is not null and status <> 'CANCELLED'
         and (issued_at at time zone 'Asia/Colombo')::date >= date_trunc('month', p_today)::date),
    -- The free-tier limits count UTC days and months (decision 69).
    'email', (select jsonb_build_object(
       'sent_today', count(*) filter (where status = 'SENT' and sent_at >= date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC'),
       'sent_month', count(*) filter (where status = 'SENT' and sent_at >= date_trunc('month', p_now at time zone 'UTC') at time zone 'UTC'),
       'failed_month', count(*) filter (where status = 'FAILED' and updated_at >= date_trunc('month', p_now at time zone 'UTC') at time zone 'UTC'),
       'pending', count(*) filter (where status = 'PENDING'),
       'daily_limit', (select email_daily_limit from public.platform_settings),
       'monthly_limit', (select email_monthly_limit from public.platform_settings))
       from public.notification_deliveries where channel = 'EMAIL'),
    'job', (select jsonb_build_object(
       'last_success', (select max(started_at) from public.cron_runs where job = 'daily' and status = 'SUCCESS' and not simulated),
       'last_run', (select to_jsonb(r) from (select started_at, finished_at, status, remaining from public.cron_runs
                    where job = 'daily' and not simulated order by started_at desc limit 1) r),
       'failed_7d', (select count(*) from public.cron_runs where job = 'daily' and status in ('FAILED', 'PARTIAL')
                     and started_at >= p_now - interval '7 days')))
  ) end;
$$;

-- RPT-08: admin report (counts over time, owner activity, delivery statistics).
create function public.report_admin_activity(p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with months as (
    select gs::date as month from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') gs
  )
  select case when not app.is_admin() then null else jsonb_build_object(
    'months', (select coalesce(jsonb_agg(jsonb_build_object(
       'month', m.month,
       'owners', (select count(*) from public.profiles where role = 'OWNER' and created_at < m.month + interval '1 month'),
       'customers', (select count(*) from public.profiles where role = 'CUSTOMER' and created_at < m.month + interval '1 month'),
       'machines', (select count(*) from public.machines where created_at < m.month + interval '1 month'),
       'invoices', (select count(*) from public.invoices where issued_at is not null and status <> 'CANCELLED'
                      and date_trunc('month', issued_at at time zone 'Asia/Colombo')::date = m.month)
     ) order by m.month), '[]'::jsonb) from months m),
    'owners', (select coalesce(jsonb_agg(x order by x.business_name), '[]'::jsonb) from (
       select o.id, o.business_name, p.status, p.last_login_at,
              (select count(*) from public.customers c where c.owner_id = o.id) as customers,
              (select count(*) from public.machines mm where mm.owner_id = o.id) as machines,
              (select count(*) from public.invoices i where i.owner_id = o.id and i.issued_at is not null and i.status <> 'CANCELLED'
                 and (i.issued_at at time zone 'Asia/Colombo')::date between p_from and p_to) as invoices,
              (select count(*) from public.billing_cycle_tickets t where t.owner_id = o.id and t.status not in ('CLOSED', 'CANCELLED')) as open_tickets,
              (select count(*) from public.billing_cycle_tickets t where t.owner_id = o.id and t.status not in ('CLOSED', 'CANCELLED')
                 and t.escalation_level >= 2) as escalated,
              (select count(*) from public.audit_logs a where a.owner_id = o.id and a.actor_id = o.id
                 and (a.created_at at time zone 'Asia/Colombo')::date between p_from and p_to) as actions
       from public.owners o join public.profiles p on p.id = o.id) x),
    'deliveries', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
       select channel || ':' || status as k, count(*) n from public.notification_deliveries
       where (created_at at time zone 'Asia/Colombo')::date between p_from and p_to group by channel, status) x),
    'in_app', (select jsonb_build_object('sent', count(*), 'read', count(read_at)) from public.notifications
       where channel = 'IN_APP' and (created_at at time zone 'Asia/Colombo')::date between p_from and p_to)
  ) end;
$$;

-- =============================================================================
-- Grants
-- =============================================================================
revoke execute on function
  app.owner_setting_keys(), app.platform_setting_keys(), app.settings_problems(jsonb),
  app.update_platform_settings(uuid, jsonb), app.update_owner_settings(uuid, jsonb),
  app.log_support_view(uuid, uuid, text, text), app.cron_ending_agreements(date, integer),
  app.report_service_costs(uuid, date, date), app.report_invoice_lines(uuid, date, date), app.report_collected(uuid, date, date)
from public, anon, authenticated;
grant execute on function
  app.owner_setting_keys(), app.platform_setting_keys(), app.settings_problems(jsonb),
  app.update_platform_settings(uuid, jsonb), app.update_owner_settings(uuid, jsonb),
  app.log_support_view(uuid, uuid, text, text), app.cron_ending_agreements(date, integer),
  app.report_service_costs(uuid, date, date), app.report_invoice_lines(uuid, date, date), app.report_collected(uuid, date, date)
to service_role;
-- The report functions call these as the signed-in user.
grant execute on function
  app.report_service_costs(uuid, date, date), app.report_invoice_lines(uuid, date, date), app.report_collected(uuid, date, date)
to authenticated;

revoke execute on function
  public.report_income(uuid, date, date), public.report_machines(uuid, date, date), public.report_customers(uuid, date, date),
  public.report_service_demand(uuid, date, date), public.report_usage(uuid, date, date), public.report_rental(uuid, date),
  public.report_cycle_status(uuid, date, date), public.report_ageing_invoices(uuid), public.report_owner_dashboard(uuid, date),
  public.report_customer_dashboard(), public.report_admin_dashboard(date, timestamptz), public.report_admin_activity(date, date)
from public, anon;
grant execute on function
  public.report_income(uuid, date, date), public.report_machines(uuid, date, date), public.report_customers(uuid, date, date),
  public.report_service_demand(uuid, date, date), public.report_usage(uuid, date, date), public.report_rental(uuid, date),
  public.report_cycle_status(uuid, date, date), public.report_ageing_invoices(uuid), public.report_owner_dashboard(uuid, date),
  public.report_customer_dashboard(), public.report_admin_dashboard(date, timestamptz), public.report_admin_activity(date, date)
to authenticated, service_role;

-- Server-only wrappers (service role).
create function public.rpc_update_platform_settings(p_actor_id uuid, p_changes jsonb) returns jsonb
language sql set search_path = '' as $$ select app.update_platform_settings(p_actor_id, p_changes); $$;
create function public.rpc_update_owner_settings(p_actor_id uuid, p_changes jsonb) returns jsonb
language sql set search_path = '' as $$ select app.update_owner_settings(p_actor_id, p_changes); $$;
create function public.rpc_log_support_view(p_admin_id uuid, p_owner_id uuid, p_path text, p_reason text default null) returns bigint
language sql set search_path = '' as $$ select app.log_support_view(p_admin_id, p_owner_id, p_path, p_reason); $$;
create function public.rpc_cron_ending_agreements(p_today date, p_limit integer default 100) returns jsonb
language sql set search_path = '' as $$ select app.cron_ending_agreements(p_today, p_limit); $$;
create function public.rpc_settings_problems(p_settings jsonb) returns text[]
language sql set search_path = '' as $$ select app.settings_problems(p_settings); $$;

revoke execute on function
  public.rpc_update_platform_settings(uuid, jsonb), public.rpc_update_owner_settings(uuid, jsonb),
  public.rpc_log_support_view(uuid, uuid, text, text), public.rpc_cron_ending_agreements(date, integer),
  public.rpc_settings_problems(jsonb)
from public, anon, authenticated;
grant execute on function
  public.rpc_update_platform_settings(uuid, jsonb), public.rpc_update_owner_settings(uuid, jsonb),
  public.rpc_log_support_view(uuid, uuid, text, text), public.rpc_cron_ending_agreements(date, integer),
  public.rpc_settings_problems(jsonb)
to service_role;

-- =============================================================================
-- E. Indexes for the report range scans
-- =============================================================================
create index invoices_owner_issued_idx on public.invoices (owner_id, issued_at) where issued_at is not null;
create index payments_owner_paid_on_idx on public.payments (owner_id, paid_on) where status in ('ACCEPTED', 'PARTIAL');
create index service_requests_owner_resolved_idx on public.service_requests (owner_id, resolved_at) where resolved_at is not null;
create index billing_cycle_tickets_owner_cycle_date_idx on public.billing_cycle_tickets (owner_id, cycle_date);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);
create index notification_deliveries_channel_created_idx on public.notification_deliveries (channel, created_at);
create index credit_refunds_owner_refunded_idx on public.credit_refunds (owner_id, refunded_on);
create index deposit_transactions_owner_kind_idx on public.deposit_transactions (owner_id, kind, occurred_on);
create index invoices_owner_period_end_idx on public.invoices (owner_id, period_end) where issued_at is not null;
