-- =============================================================================
-- 0032 Notifications: email outbox, delivery log, preferences, templates
-- (NOT-01..05, ADM-03, CUS-02; decisions 65-74).
--
-- The in-app row stays in `notifications` (the centre, Realtime). Every other
-- channel is a row in `notification_deliveries`, written by
-- `app.enqueue_notifications` in the SAME transaction as the business change
-- (outbox): a change that rolls back leaves no delivery, so no email is ever sent
-- for it. Server code claims due deliveries after the request (Next `after()`) and
-- from the daily job, sends them and records the result.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. Catalogue: which events go out by email / SMS and how essential they are.
--    Mirrors src/lib/notifications/events.ts (notifications.db.test.ts checks it).
-- -----------------------------------------------------------------------------
create table public.notification_events (
  event text primary key check (event ~ '^[a-z0-9_.]+$'),
  category text not null check (category in ('ESSENTIAL', 'UPDATE', 'REMINDER')),
  email boolean not null default true,
  sms boolean not null default false
);
comment on table public.notification_events is
  'Delivery catalogue (decision 66): events with an email (and later SMS/WhatsApp) and their category. Read by app.enqueue_notifications.';

insert into public.notification_events (event, category, email, sms) values
  ('account.active', 'ESSENTIAL', true, false),
  ('account.contact_changed', 'ESSENTIAL', true, false),
  ('account.credentials', 'ESSENTIAL', true, false),
  ('account.deactivated', 'ESSENTIAL', true, false),
  ('account.owner_active', 'ESSENTIAL', true, false),
  ('account.owner_deactivated', 'ESSENTIAL', true, false),
  ('account.owner_suspended', 'ESSENTIAL', true, false),
  ('account.suspended', 'ESSENTIAL', true, false),
  ('agreement.terms_changed', 'ESSENTIAL', true, false),
  ('credit.refunded', 'ESSENTIAL', true, false),
  ('cron.failed', 'UPDATE', true, false),
  ('cron.missed', 'UPDATE', true, false),
  ('deposit.settled', 'ESSENTIAL', true, false),
  ('dispute.credit', 'ESSENTIAL', true, false),
  ('dispute.escalated', 'UPDATE', true, true),
  ('dispute.photo_received', 'UPDATE', true, false),
  ('dispute.photo_requested', 'UPDATE', true, false),
  ('dispute.raised', 'UPDATE', true, false),
  ('dispute.rejected', 'ESSENTIAL', true, false),
  ('dispute.reminder', 'REMINDER', true, false),
  ('invoice.corrected', 'ESSENTIAL', true, false),
  ('invoice.issued', 'ESSENTIAL', true, false),
  ('invoice.late_fee', 'ESSENTIAL', true, false),
  ('invoice.resent', 'ESSENTIAL', true, false),
  ('machine.assigned', 'ESSENTIAL', true, false),
  ('machine.returned', 'ESSENTIAL', true, false),
  ('meter.baseline', 'UPDATE', true, false),
  ('meter.corrected', 'UPDATE', true, false),
  ('meter.entered', 'UPDATE', true, false),
  ('meter.rejected', 'UPDATE', true, false),
  ('meter.rejected_final', 'UPDATE', true, false),
  ('meter.submitted', 'UPDATE', true, false),
  ('payment.due_soon', 'REMINDER', true, true),
  ('payment.due_today', 'REMINDER', true, true),
  ('payment.overdue', 'REMINDER', true, true),
  ('payment.overdue_owner', 'UPDATE', true, false),
  ('payment.overdue_summary', 'REMINDER', true, false),
  ('payment.partial', 'ESSENTIAL', true, false),
  ('payment.reallocated', 'ESSENTIAL', true, false),
  ('payment.receipt', 'ESSENTIAL', true, false),
  ('payment.recorded', 'ESSENTIAL', true, false),
  ('payment.rejected', 'ESSENTIAL', true, false),
  ('payment.reversed', 'ESSENTIAL', true, false),
  ('payment.submitted', 'UPDATE', true, false),
  ('service.escalated_admin', 'UPDATE', true, true),
  ('service.escalated_owner', 'REMINDER', true, true),
  ('service.raised', 'UPDATE', true, true),
  ('ticket.cancelled', 'ESSENTIAL', true, false),
  ('ticket.due_date_changed', 'ESSENTIAL', true, false),
  ('ticket.escalated', 'UPDATE', true, true),
  ('ticket.estimate_ready', 'UPDATE', true, false),
  ('ticket.meter_missed', 'UPDATE', true, true),
  ('ticket.meter_overdue', 'REMINDER', true, true),
  ('ticket.meter_reminder', 'REMINDER', true, true),
  ('ticket.opened', 'ESSENTIAL', true, true),
  ('ticket.previous_overdue', 'UPDATE', true, false),
  ('ticket.reopened', 'ESSENTIAL', true, false),
  ('ticket.review_reminder', 'REMINDER', true, false),
  ('ticket.slip_reminder', 'REMINDER', true, false);

-- -----------------------------------------------------------------------------
-- B. Settings: Resend free tier (100 a day per UTC day, 3,000 a month), retries,
--    reminder expiry, SMS / WhatsApp switches (no provider yet: stubs).
-- -----------------------------------------------------------------------------
alter table public.platform_settings
  add column email_daily_limit integer not null default 100 check (email_daily_limit >= 0),
  add column email_monthly_limit integer not null default 3000 check (email_monthly_limit >= 0),
  add column email_essential_reserve integer not null default 20 check (email_essential_reserve >= 0),
  add column email_max_attempts integer not null default 5 check (email_max_attempts between 1 and 20),
  add column email_reminder_expiry_days integer not null default 3 check (email_reminder_expiry_days > 0),
  add column sms_enabled boolean not null default false,
  add column whatsapp_enabled boolean not null default false;

-- Admins have no owners/customers row: their alert address lives on the profile.
alter table public.profiles add column email text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
comment on column public.profiles.email is 'ADMIN only: where admin alerts are emailed. Owners and customers use owners.email / customers.email.';

-- -----------------------------------------------------------------------------
-- C. Deliveries (outbox + delivery log, NOT-05).
-- -----------------------------------------------------------------------------
create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  -- null for a direct send (login details: the password is never stored, decision 70).
  notification_id uuid references public.notifications (id) on delete cascade,
  owner_id uuid references public.owners (id), -- null for platform (admin) alerts
  user_id uuid not null references public.profiles (id),
  event text not null,
  channel public.notification_channel not null check (channel <> 'IN_APP'),
  category text not null check (category in ('ESSENTIAL', 'UPDATE', 'REMINDER')),
  priority smallint not null default 1,
  -- Address (email or phone) at the time it was queued; null when the user has none.
  recipient text,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts smallint not null default 0 check (attempts >= 0),
  last_error text,
  next_attempt_at timestamptz not null default now(),
  claimed_until timestamptz,
  claim_token uuid,
  provider text,
  provider_id text,
  -- What was actually sent (after templates and the non-production redirect).
  subject text,
  sent_to text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.notification_deliveries is
  'Email/SMS/WhatsApp outbox and delivery log (NOT-02/03/05). Written in the same transaction as the business change. SERVER-WRITE-ONLY.';
create index notification_deliveries_due_idx on public.notification_deliveries (priority, next_attempt_at)
  where status = 'PENDING';
create index notification_deliveries_owner_idx on public.notification_deliveries (owner_id, created_at desc);
create index notification_deliveries_notification_idx on public.notification_deliveries (notification_id);
create index notification_deliveries_user_idx on public.notification_deliveries (user_id);
create index notification_deliveries_sent_idx on public.notification_deliveries (sent_at) where provider = 'resend';
create unique index notification_deliveries_provider_idx on public.notification_deliveries (provider, provider_id)
  where provider_id is not null;

create trigger notification_deliveries_set_updated_at before update on public.notification_deliveries
  for each row execute function app.set_updated_at();

-- -----------------------------------------------------------------------------
-- D. Preferences (decision 68): reminders and other updates can be turned off;
--    essential emails always go.
-- -----------------------------------------------------------------------------
create table public.notification_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  owner_id uuid references public.owners (id), -- the user's tenant (null for admins)
  email_reminders boolean not null default true,
  email_updates boolean not null default true,
  updated_at timestamptz not null default now()
);
create index notification_preferences_owner_idx on public.notification_preferences (owner_id);
create trigger notification_preferences_set_updated_at before update on public.notification_preferences
  for each row execute function app.set_updated_at();

-- -----------------------------------------------------------------------------
-- E. Templates: written only through the server (variables checked first).
-- -----------------------------------------------------------------------------
alter table public.notification_templates
  add constraint notification_templates_subject_len check (length(subject) <= 200),
  add constraint notification_templates_body_len check (length(body) <= 5000);
revoke insert, update, delete on public.notification_templates from authenticated;
drop policy notification_templates_insert on public.notification_templates;
drop policy notification_templates_update on public.notification_templates;
drop policy notification_templates_delete on public.notification_templates;

-- Users mark only their own in-app rows read (email rows live elsewhere now, but
-- keep the rule explicit).
drop policy notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications for update to authenticated
using (user_id = (select auth.uid()) and channel = 'IN_APP' and (select app.current_user_role()) is not null)
with check (user_id = (select auth.uid()) and channel = 'IN_APP' and (select app.current_user_role()) is not null);

-- -----------------------------------------------------------------------------
-- F. RLS and grants for the new tables.
-- -----------------------------------------------------------------------------
alter table public.notification_events enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_preferences enable row level security;

grant select on public.notification_events to authenticated, service_role;
create policy notification_events_select on public.notification_events for select to authenticated using ((select app.current_user_role()) is not null);

grant select on public.notification_deliveries to authenticated;
grant select, insert, update on public.notification_deliveries to service_role;
-- Delivery log: admin sees all; an owner sees their tenant's (NOT-05, ADM-05).
create policy notification_deliveries_select on public.notification_deliveries for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);

grant select on public.notification_preferences to authenticated;
grant select, insert, update on public.notification_preferences to service_role;
create policy notification_preferences_select on public.notification_preferences for select to authenticated using (
  user_id = (select auth.uid()) and (select app.current_user_role()) is not null
);

-- Delivery log view: in-app rows and their deliveries, one row per notification
-- and channel. security_invoker, so the RLS of both tables applies.
create view public.notification_log with (security_invoker = true) as
  select n.id, n.id as notification_id, n.owner_id, n.user_id, n.event, n.channel, n.status::text as status,
         n.attempts, n.last_error, null::text as recipient, n.title, n.created_at, n.sent_at, n.read_at
  from public.notifications n
  union all
  select d.id, d.notification_id, d.owner_id, d.user_id, d.event, d.channel, d.status,
         d.attempts, d.last_error, d.recipient, coalesce(n.title, d.subject, d.event), d.created_at, d.sent_at, null::timestamptz
  from public.notification_deliveries d
  left join public.notifications n on n.id = d.notification_id;
grant select on public.notification_log to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- G. Queueing.
-- -----------------------------------------------------------------------------

-- Where a user is reached on a channel: owners.email / customers.email (admins:
-- profiles.email); phones for SMS / WhatsApp. Null when none.
create function app.notification_address(p_user_id uuid, p_channel public.notification_channel) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(btrim(case
    when p_channel = 'EMAIL' then case p.role when 'ADMIN' then p.email when 'OWNER' then o.email else c.email end
    else case p.role when 'ADMIN' then null when 'OWNER' then o.phone else c.phone end
  end), '')
  from public.profiles p
  left join public.owners o on o.id = p.id
  left join public.customers c on c.id = p.id
  where p.id = p_user_id;
$$;

-- True when the user turned this category off (essential never).
create function app.delivery_opted_out(p_user_id uuid, p_category text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_category
    when 'REMINDER' then not coalesce((select email_reminders from public.notification_preferences where user_id = p_user_id), true)
    when 'UPDATE' then not coalesce((select email_updates from public.notification_preferences where user_id = p_user_id), true)
    else false
  end;
$$;

-- One delivery row: PENDING, or SKIPPED (NO_ADDRESS / OPTED_OUT) so the log shows why.
create function app.queue_delivery(
  p_notification_id uuid,
  p_owner_id uuid,
  p_user_id uuid,
  p_event text,
  p_channel public.notification_channel,
  p_category text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to text := app.notification_address(p_user_id, p_channel);
  v_skip text;
begin
  if v_to is null then
    v_skip := case when p_channel = 'EMAIL' then 'NO_EMAIL: no email address on the account' else 'NO_PHONE: no phone number on the account' end;
  elsif app.delivery_opted_out(p_user_id, p_category) then
    v_skip := 'OPTED_OUT: turned off by the user';
  end if;
  insert into public.notification_deliveries (notification_id, owner_id, user_id, event, channel, category, priority, recipient, status, last_error)
  values (p_notification_id, p_owner_id, p_user_id, p_event, p_channel, p_category,
          case p_category when 'ESSENTIAL' then 0 when 'UPDATE' then 1 else 2 end,
          v_to, case when v_skip is null then 'PENDING' else 'SKIPPED' end, v_skip);
end;
$$;

-- Redefined (was 0008): also queues the email (and, when switched on, SMS /
-- WhatsApp) deliveries of catalogue events in the same transaction. An item may
-- say "email": false to stay in-app only.
create or replace function app.enqueue_notifications(
  p_owner_id uuid,
  p_items jsonb,
  p_entity_type text default null,
  p_entity_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_user uuid;
  v_channel public.notification_channel;
  v_count integer := 0;
  v_id uuid;
  ev public.notification_events;
  s public.platform_settings;
begin
  if p_items is null or p_items = 'null'::jsonb then
    return 0;
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    perform app.fail('RD400', 'Notifications must be a JSON array');
  end if;
  select * into s from public.platform_settings where id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_user := (v_item ->> 'user_id')::uuid;
    -- Recipients must be in this tenant (or platform admins).
    if not exists (
      select 1 from public.profiles p
      where p.id = v_user and (p.owner_id = p_owner_id or p.role = 'ADMIN')
    ) then
      perform app.fail('RD400', 'Notification recipient is outside this tenant');
    end if;
    v_channel := coalesce(v_item ->> 'channel', 'IN_APP')::public.notification_channel;

    insert into public.notifications (
      owner_id, user_id, event, channel, title, body, link, data, entity_type, entity_id, status, sent_at
    ) values (
      p_owner_id,
      v_user,
      v_item ->> 'event',
      v_channel,
      v_item ->> 'title',
      coalesce(v_item ->> 'body', ''),
      replace(v_item ->> 'link', '{entity_id}', coalesce(p_entity_id::text, '')),
      coalesce(v_item -> 'data', '{}'::jsonb),
      coalesce(v_item ->> 'entity_type', p_entity_type),
      coalesce(nullif(v_item ->> 'entity_id', '')::uuid, p_entity_id),
      case when v_channel = 'IN_APP' then 'SENT' else 'PENDING' end::public.notification_status,
      case when v_channel = 'IN_APP' then now() end
    )
    returning id into v_id;
    v_count := v_count + 1;

    if v_channel = 'IN_APP' and coalesce((v_item ->> 'email')::boolean, true) then
      select * into ev from public.notification_events e where e.event = v_item ->> 'event';
      if found then
        if ev.email then
          perform app.queue_delivery(v_id, p_owner_id, v_user, ev.event, 'EMAIL', ev.category);
        end if;
        if ev.sms and s.sms_enabled then
          perform app.queue_delivery(v_id, p_owner_id, v_user, ev.event, 'SMS', ev.category);
        end if;
        if ev.sms and s.whatsapp_enabled then
          perform app.queue_delivery(v_id, p_owner_id, v_user, ev.event, 'WHATSAPP', ev.category);
        end if;
      end if;
    end if;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- H. Sending (server code): quota, claim, record, bounce, direct sends.
-- -----------------------------------------------------------------------------

-- Emails sent through Resend today (UTC calendar day, as Resend counts) and this
-- UTC month, and the limits (decision 69).
create function app.email_quota(p_now timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sent_today', (select count(*) from public.notification_deliveries d
                   where d.provider = 'resend' and d.sent_at >= date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC'
                     and d.sent_at <= p_now),
    'sent_month', (select count(*) from public.notification_deliveries d
                   where d.provider = 'resend' and d.sent_at >= date_trunc('month', p_now at time zone 'UTC') at time zone 'UTC'
                     and d.sent_at <= p_now),
    'daily_limit', s.email_daily_limit,
    'monthly_limit', s.email_monthly_limit,
    'reserve', s.email_essential_reserve,
    'max_attempts', s.email_max_attempts
  )
  from public.platform_settings s where s.id;
$$;

-- Everything the sender needs about one delivery: the message, the recipient, the
-- owner's branding (customers and owners), the effective template and the PDF to
-- attach.
create function app.delivery_context(d public.notification_deliveries) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n public.notifications;
  p public.profiles;
  v_name text;
  v_company jsonb;
  v_template jsonb;
  v_attachment jsonb;
  v_invoice uuid;
begin
  select * into n from public.notifications where id = d.notification_id;
  select * into p from public.profiles where id = d.user_id;
  v_name := coalesce(
    (select nullif(c.name, '') from public.customers c where c.id = d.user_id),
    (select nullif(o.contact_person, '') from public.owners o where o.id = d.user_id),
    nullif(p.full_name, ''),
    p.username
  );

  if d.owner_id is not null and p.role <> 'ADMIN' then
    select jsonb_build_object(
      'name', coalesce(cp.company_name, o.business_name),
      'email', coalesce(nullif(btrim(cp.email), ''), nullif(btrim(o.email), '')),
      'logo_path', cp.logo_path
    ) into v_company
    from public.owners o left join public.owner_company_profiles cp on cp.owner_id = o.id
    where o.id = d.owner_id;
  end if;

  select jsonb_build_object('subject', t.subject, 'body', t.body, 'source', case when t.owner_id is null then 'GLOBAL' else 'OWNER' end)
  into v_template
  from public.notification_templates t
  where t.event = d.event and t.channel = 'EMAIL' and t.locale = 'en'
    and (t.owner_id = d.owner_id or t.owner_id is null)
  order by t.owner_id nulls last
  limit 1;

  -- Attachments (decision 72): the bill's PDF, the payment's receipt PDF.
  if n.id is not null and d.event in ('invoice.issued', 'invoice.corrected', 'invoice.resent') then
    v_invoice := nullif(n.data ->> 'invoice_id', '')::uuid;
    if v_invoice is null and n.entity_type = 'billing_cycle_ticket' then
      select t.current_invoice_id into v_invoice from public.billing_cycle_tickets t where t.id = n.entity_id;
    elsif v_invoice is null and n.entity_type in ('rental_agreements', 'rental_agreement') then
      select i.id into v_invoice from public.invoices i
      where i.agreement_id = n.entity_id and i.invoice_no is not null and i.created_at <= n.created_at + interval '1 minute'
      order by i.issued_at desc nulls last, i.created_at desc limit 1;
    end if;
    select jsonb_build_object('kind', 'INVOICE', 'number', i.invoice_no, 'status', i.pdf_status, 'path', i.pdf_path)
    into v_attachment from public.invoices i where i.id = v_invoice and i.owner_id = d.owner_id;
  elsif n.id is not null and d.event in ('payment.receipt', 'payment.partial', 'payment.recorded') and n.entity_type = 'payment' then
    select jsonb_build_object('kind', 'RECEIPT', 'number', r.receipt_no, 'status', r.pdf_status, 'path', r.pdf_path)
    into v_attachment from public.receipts r where r.payment_id = n.entity_id and r.owner_id = d.owner_id;
  end if;

  return jsonb_build_object(
    'id', d.id,
    'token', d.claim_token,
    'channel', d.channel,
    'event', d.event,
    'category', d.category,
    'attempts', d.attempts,
    'created_at', d.created_at,
    'recipient', d.recipient,
    'user_id', d.user_id,
    'owner_id', d.owner_id,
    'role', p.role,
    'recipient_name', v_name,
    'title', coalesce(n.title, d.subject, ''),
    'body', coalesce(n.body, ''),
    'link', n.link,
    'data', coalesce(n.data, '{}'::jsonb),
    'company', v_company,
    'template', v_template,
    'attachment', v_attachment
  );
end;
$$;

-- Claims due deliveries for this sender (decision 67). Emails: at most
-- p_email_limit (0 when the limit is reached), only ESSENTIAL when p_essential_only;
-- other channels: p_other_limit. Reminders older than the expiry are skipped; with
-- p_essential_only, other due emails wait for the next UTC day (logged).
-- FOR UPDATE SKIP LOCKED + a lease: two senders never claim the same row.
create function app.claim_deliveries(
  p_now timestamptz,
  p_email_limit integer,
  p_essential_only boolean,
  p_other_limit integer default 20,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.platform_settings;
  v_token uuid := gen_random_uuid();
  v_next_day timestamptz := (date_trunc('day', p_now at time zone 'UTC') + interval '1 day') at time zone 'UTC';
  v_ids uuid[];
  v_out jsonb;
begin
  select * into s from public.platform_settings where id;

  update public.notification_deliveries d
  set status = 'SKIPPED', last_error = 'EXPIRED: reminder not sent within ' || s.email_reminder_expiry_days || ' days', claim_token = null, claimed_until = null
  where d.status = 'PENDING' and d.category = 'REMINDER'
    and d.created_at < p_now - make_interval(days => s.email_reminder_expiry_days)
    and (d.claimed_until is null or d.claimed_until < p_now);

  if p_essential_only then
    update public.notification_deliveries d
    set next_attempt_at = v_next_day, last_error = 'DEFERRED: daily email limit nearly reached; waits for tomorrow'
    where d.status = 'PENDING' and d.channel = 'EMAIL' and d.category <> 'ESSENTIAL'
      and d.next_attempt_at <= p_now and (d.claimed_until is null or d.claimed_until < p_now);
  end if;

  with emails as (
    select d.id from public.notification_deliveries d
    where d.status = 'PENDING' and d.channel = 'EMAIL' and d.next_attempt_at <= p_now
      and (d.claimed_until is null or d.claimed_until < p_now)
      and (not p_essential_only or d.category = 'ESSENTIAL')
    order by d.priority, d.next_attempt_at, d.created_at
    limit greatest(p_email_limit, 0)
    for update skip locked
  ), others as (
    select d.id from public.notification_deliveries d
    where d.status = 'PENDING' and d.channel <> 'EMAIL' and d.next_attempt_at <= p_now
      and (d.claimed_until is null or d.claimed_until < p_now)
    order by d.priority, d.next_attempt_at, d.created_at
    limit greatest(p_other_limit, 0)
    for update skip locked
  )
  select array(select id from emails union all select id from others) into v_ids;
  if cardinality(v_ids) = 0 then
    v_ids := null;
  end if;

  if v_ids is null then
    return '[]'::jsonb;
  end if;

  update public.notification_deliveries
  set claim_token = v_token, claimed_until = p_now + make_interval(secs => p_lease_seconds)
  where id = any(v_ids);

  select jsonb_agg(app.delivery_context(d) order by d.priority, d.created_at) into v_out
  from public.notification_deliveries d where d.id = any(v_ids);
  return v_out;
end;
$$;

-- An owner (customer emails) or the admins (owner emails) hear when an email could
-- not be delivered, in-app (spec 11.2: "owner alerted if all channels fail").
create function app.alert_delivery_failed(d public.notification_deliveries) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.profiles;
  v_who text;
  v_what text;
  v_items jsonb;
begin
  select * into p from public.profiles where id = d.user_id;
  v_what := coalesce((select n.title from public.notifications n where n.id = d.notification_id), d.subject, d.event);
  if p.role = 'CUSTOMER' then
    select coalesce(nullif(c.business_name, ''), c.name) into v_who from public.customers c where c.id = p.id;
    perform app.enqueue_notifications(p.owner_id, jsonb_build_array(jsonb_build_object(
      'user_id', p.owner_id,
      'event', 'email.failed',
      'title', format('Email to %s could not be delivered', v_who),
      'body', format('"%s" did not reach %s (%s). Check the email address on the customer page, or tell the customer yourself.',
                     v_what, coalesce(d.recipient, 'no address'), coalesce(d.last_error, 'failed')),
      'link', '/owner/customers/' || p.id::text
    )), 'profiles', p.id);
  elsif p.role = 'OWNER' then
    select o.business_name into v_who from public.owners o where o.id = p.id;
    select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', a.id,
      'event', 'email.failed',
      'title', format('Email to %s could not be delivered', v_who),
      'body', format('"%s" did not reach %s (%s). Check the owner''s email address.', v_what, coalesce(d.recipient, 'no address'), coalesce(d.last_error, 'failed')),
      'link', '/admin/owners/' || p.id::text
    )), '[]'::jsonb) into v_items
    from public.profiles a where a.role = 'ADMIN' and a.status = 'ACTIVE';
    perform app.enqueue_notifications(p.id, v_items, 'profiles', p.id);
  end if;
end;
$$;

-- Records what happened to a claimed delivery. Outcomes: SENT, RETRY (backoff time
-- given by the sender; FAILED after the last attempt), FAILED (permanent),
-- SKIPPED (reason), POSTPONE (e.g. PDF not ready: no attempt used). A stale claim
-- (another sender took it over) changes nothing.
create function app.record_delivery_result(
  p_id uuid,
  p_token uuid,
  p_outcome text,
  p_now timestamptz,
  p_error text default null,
  p_next_attempt_at timestamptz default null,
  p_provider text default null,
  p_provider_id text default null,
  p_subject text default null,
  p_sent_to text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.notification_deliveries;
  v_max integer := (select email_max_attempts from public.platform_settings where id);
  v_status text;
begin
  select * into d from public.notification_deliveries where id = p_id for update;
  if not found then
    perform app.fail('RD404', 'Delivery not found');
  end if;
  if d.claim_token is distinct from p_token or d.status <> 'PENDING' then
    return jsonb_build_object('skipped', true);
  end if;
  if p_outcome not in ('SENT', 'RETRY', 'FAILED', 'SKIPPED', 'POSTPONE') then
    perform app.fail('RD400', 'Unknown outcome');
  end if;

  v_status := case p_outcome
    when 'SENT' then 'SENT'
    when 'FAILED' then 'FAILED'
    when 'SKIPPED' then 'SKIPPED'
    when 'RETRY' then case when d.attempts + 1 >= v_max then 'FAILED' else 'PENDING' end
    else 'PENDING'
  end;

  update public.notification_deliveries
  set status = v_status,
      attempts = attempts + case when p_outcome in ('SENT', 'RETRY', 'FAILED') then 1 else 0 end,
      last_error = case when p_outcome = 'SENT' then p_error else left(p_error, 1000) end,
      next_attempt_at = case when v_status = 'PENDING' then coalesce(p_next_attempt_at, p_now + interval '5 minutes') else next_attempt_at end,
      claim_token = null,
      claimed_until = null,
      provider = coalesce(p_provider, provider),
      provider_id = coalesce(p_provider_id, provider_id),
      subject = coalesce(p_subject, subject),
      sent_to = coalesce(p_sent_to, sent_to),
      sent_at = case when p_outcome = 'SENT' then p_now else sent_at end
  where id = d.id
  returning * into d;

  if v_status = 'FAILED' then
    perform app.alert_delivery_failed(d);
  end if;
  return jsonb_build_object('status', v_status, 'attempts', d.attempts);
end;
$$;

-- Bounce or complaint reported by the Resend webhook: the delivery becomes FAILED
-- and the owner (or admins) are alerted, once.
create function app.mark_delivery_bounced(p_provider_id text, p_reason text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.notification_deliveries;
begin
  select * into d from public.notification_deliveries
  where provider = 'resend' and provider_id = p_provider_id for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  if d.status = 'FAILED' then
    return jsonb_build_object('found', true, 'skipped', true);
  end if;
  update public.notification_deliveries
  set status = 'FAILED', last_error = left(coalesce(p_reason, 'Bounced'), 1000)
  where id = d.id
  returning * into d;
  perform app.alert_delivery_failed(d);
  return jsonb_build_object('found', true, 'id', d.id);
end;
$$;

-- A direct send logged after the fact (login details: the password never reaches
-- the database, decision 70).
create function app.log_direct_delivery(
  p_owner_id uuid,
  p_user_id uuid,
  p_event text,
  p_subject text,
  p_recipient text,
  p_status text,
  p_error text,
  p_provider text,
  p_provider_id text,
  p_sent_to text,
  p_now timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.owner_id is not distinct from p_owner_id) then
    perform app.fail('RD400', 'Recipient is outside this tenant');
  end if;
  insert into public.notification_deliveries (owner_id, user_id, event, channel, category, priority, recipient, status, attempts,
    last_error, provider, provider_id, subject, sent_to, sent_at, next_attempt_at)
  values (p_owner_id, p_user_id, p_event, 'EMAIL', 'ESSENTIAL', 0, p_recipient, p_status,
    case when p_status in ('SENT', 'FAILED') then 1 else 0 end, left(p_error, 1000), p_provider, p_provider_id,
    p_subject, p_sent_to, case when p_status = 'SENT' then p_now end, p_now)
  returning id into v_id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- I. Templates, preferences and the admin's alert address (server actions).
-- -----------------------------------------------------------------------------

-- Admin: global template (p_owner_id null). Owner: own override only. The server
-- checked the variables (decision 71); the database checks who and which event.
create function app.save_notification_template(
  p_actor_id uuid,
  p_owner_id uuid,
  p_event text,
  p_subject text,
  p_body text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.profiles;
  v_id uuid;
begin
  select * into a from public.profiles where id = p_actor_id;
  if not found or a.status <> 'ACTIVE'
     or not coalesce((a.role = 'ADMIN' and p_owner_id is null) or (a.role = 'OWNER' and p_owner_id is not distinct from a.id), false) then
    perform app.fail('RD403', 'Not allowed to change this template');
  end if;
  if not exists (select 1 from public.notification_events e where e.event = p_event and e.email) then
    perform app.fail('RD400', 'Unknown email event');
  end if;
  if coalesce(btrim(p_subject), '') = '' or coalesce(btrim(p_body), '') = '' then
    perform app.fail('RD400', 'Subject and text are required');
  end if;
  perform app.set_actor(p_actor_id);
  insert into public.notification_templates (owner_id, event, channel, locale, subject, body)
  values (p_owner_id, p_event, 'EMAIL', 'en', btrim(p_subject), p_body)
  on conflict on constraint notification_templates_key
  do update set subject = excluded.subject, body = excluded.body
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- "Reset to default": removes the override (owner) or the global edit (admin).
create function app.reset_notification_template(p_actor_id uuid, p_owner_id uuid, p_event text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.profiles;
  v_count integer;
begin
  select * into a from public.profiles where id = p_actor_id;
  if not found or a.status <> 'ACTIVE'
     or not coalesce((a.role = 'ADMIN' and p_owner_id is null) or (a.role = 'OWNER' and p_owner_id is not distinct from a.id), false) then
    perform app.fail('RD403', 'Not allowed to change this template');
  end if;
  perform app.set_actor(p_actor_id);
  delete from public.notification_templates t
  where t.owner_id is not distinct from p_owner_id and t.event = p_event and t.channel = 'EMAIL' and t.locale = 'en';
  get diagnostics v_count = row_count;
  return jsonb_build_object('deleted', v_count);
end;
$$;

create function app.save_notification_preferences(p_user_id uuid, p_reminders boolean, p_updates boolean) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.profiles;
begin
  select * into p from public.profiles where id = p_user_id;
  if not found or p.status <> 'ACTIVE' then
    perform app.fail('RD403', 'Not allowed');
  end if;
  perform app.set_actor(p_user_id);
  insert into public.notification_preferences (user_id, owner_id, email_reminders, email_updates)
  values (p.id, p.owner_id, coalesce(p_reminders, true), coalesce(p_updates, true))
  on conflict (user_id) do update set email_reminders = excluded.email_reminders, email_updates = excluded.email_updates;
  return jsonb_build_object('email_reminders', coalesce(p_reminders, true), 'email_updates', coalesce(p_updates, true));
end;
$$;

create function app.set_admin_email(p_actor_id uuid, p_email text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles p where p.id = p_actor_id and p.role = 'ADMIN' and p.status = 'ACTIVE') then
    perform app.fail('RD403', 'Admins only');
  end if;
  perform app.set_actor(p_actor_id);
  update public.profiles set email = nullif(btrim(p_email), '') where id = p_actor_id;
  return jsonb_build_object('email', nullif(btrim(p_email), ''));
end;
$$;

-- -----------------------------------------------------------------------------
-- J. Contact change (spec 11.8): a test message to the new address.
-- -----------------------------------------------------------------------------
create function app.notify_contact_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- owners has no owner_id column: read it from the row as JSON.
  v_owner uuid := case when tg_table_name = 'owners' then new.id else (to_jsonb(new) ->> 'owner_id')::uuid end;
  v_from text;
begin
  if new.email is not distinct from old.email or nullif(btrim(new.email), '') is null then
    return new;
  end if;
  if tg_table_name = 'owners' then
    v_from := 'the RentDesk team';
  else
    select coalesce(cp.company_name, o.business_name) into v_from
    from public.owners o left join public.owner_company_profiles cp on cp.owner_id = o.id where o.id = v_owner;
  end if;
  perform app.enqueue_notifications(v_owner, jsonb_build_array(jsonb_build_object(
    'user_id', new.id,
    'event', 'account.contact_changed',
    'title', 'Your email address was updated',
    'body', format('From now on, RentDesk emails will be sent to %s. If this is not your address, please tell %s.', btrim(new.email), v_from),
    'link', case when tg_table_name = 'owners' then '/owner/settings/notifications' else '/customer/help' end,
    'data', jsonb_build_object('vars', jsonb_build_object('email', btrim(new.email)))
  )), 'profiles', new.id);
  return new;
end;
$$;

create trigger customers_contact_changed after update of email on public.customers
  for each row execute function app.notify_contact_changed();
create trigger owners_contact_changed after update of email on public.owners
  for each row execute function app.notify_contact_changed();

-- -----------------------------------------------------------------------------
-- K. Account status (redefined from 0013): an owner's suspension, reactivation or
--    closure is also told to that owner's active customers (spec 11.3, 11.8).
-- -----------------------------------------------------------------------------
create or replace function app.set_account_status(
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
  v_company text;
  v_items jsonb;
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

  if t.role = 'OWNER' then
    select coalesce(cp.company_name, o.business_name) into v_company
    from public.owners o left join public.owner_company_profiles cp on cp.owner_id = o.id where o.id = t.id;
    select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', c.id,
      'event', 'account.owner_' || lower(p_status::text),
      'title', case p_status
                 when 'ACTIVE' then format('%s is back on RentDesk', v_company)
                 when 'SUSPENDED' then format('%s is on hold in RentDesk', v_company)
                 else format('%s has left RentDesk', v_company)
               end,
      'body', case p_status
                when 'ACTIVE' then 'You can sign in again. Your machines, bills and payments are as you left them.'
                when 'SUSPENDED' then format('You cannot sign in to RentDesk for now. Your bills, readings and payments are kept. Please contact %s directly.', v_company)
                else format('You can no longer sign in to RentDesk. Your records are kept. Please contact %s directly about your rental.', v_company)
              end,
      'link', '/customer'
    )), '[]'::jsonb) into v_items
    from public.customers c join public.profiles cpr on cpr.id = c.id
    where c.owner_id = t.id and cpr.status = 'ACTIVE';
    perform app.enqueue_notifications(t.id, v_items, 'profiles', t.id);
  end if;

  return jsonb_build_object('user_id', t.id, 'from', t.status, 'to', p_status);
end;
$$;

-- -----------------------------------------------------------------------------
-- L. Grants and public.rpc_* wrappers (service role only)
-- -----------------------------------------------------------------------------
revoke all on function
  app.notification_address(uuid, public.notification_channel),
  app.delivery_opted_out(uuid, text),
  app.queue_delivery(uuid, uuid, uuid, text, public.notification_channel, text),
  app.email_quota(timestamptz),
  app.delivery_context(public.notification_deliveries),
  app.claim_deliveries(timestamptz, integer, boolean, integer, integer),
  app.alert_delivery_failed(public.notification_deliveries),
  app.record_delivery_result(uuid, uuid, text, timestamptz, text, timestamptz, text, text, text, text),
  app.mark_delivery_bounced(text, text),
  app.log_direct_delivery(uuid, uuid, text, text, text, text, text, text, text, text, timestamptz),
  app.save_notification_template(uuid, uuid, text, text, text),
  app.reset_notification_template(uuid, uuid, text),
  app.save_notification_preferences(uuid, boolean, boolean),
  app.set_admin_email(uuid, text),
  app.notify_contact_changed()
from public, anon, authenticated;

grant execute on function
  app.email_quota(timestamptz),
  app.claim_deliveries(timestamptz, integer, boolean, integer, integer),
  app.record_delivery_result(uuid, uuid, text, timestamptz, text, timestamptz, text, text, text, text),
  app.mark_delivery_bounced(text, text),
  app.log_direct_delivery(uuid, uuid, text, text, text, text, text, text, text, text, timestamptz),
  app.save_notification_template(uuid, uuid, text, text, text),
  app.reset_notification_template(uuid, uuid, text),
  app.save_notification_preferences(uuid, boolean, boolean),
  app.set_admin_email(uuid, text)
to service_role;

create function public.rpc_email_quota(p_now timestamptz) returns jsonb
language sql set search_path = '' as $$ select app.email_quota(p_now); $$;

create function public.rpc_claim_deliveries(
  p_now timestamptz, p_email_limit integer, p_essential_only boolean, p_other_limit integer default 20, p_lease_seconds integer default 120
) returns jsonb language sql set search_path = '' as $$
  select app.claim_deliveries(p_now, p_email_limit, p_essential_only, p_other_limit, p_lease_seconds);
$$;

create function public.rpc_record_delivery_result(
  p_id uuid, p_token uuid, p_outcome text, p_now timestamptz, p_error text default null, p_next_attempt_at timestamptz default null,
  p_provider text default null, p_provider_id text default null, p_subject text default null, p_sent_to text default null
) returns jsonb language sql set search_path = '' as $$
  select app.record_delivery_result(p_id, p_token, p_outcome, p_now, p_error, p_next_attempt_at, p_provider, p_provider_id, p_subject, p_sent_to);
$$;

create function public.rpc_mark_delivery_bounced(p_provider_id text, p_reason text) returns jsonb
language sql set search_path = '' as $$ select app.mark_delivery_bounced(p_provider_id, p_reason); $$;

create function public.rpc_log_direct_delivery(
  p_owner_id uuid, p_user_id uuid, p_event text, p_subject text, p_recipient text, p_status text, p_error text,
  p_provider text, p_provider_id text, p_sent_to text, p_now timestamptz
) returns uuid language sql set search_path = '' as $$
  select app.log_direct_delivery(p_owner_id, p_user_id, p_event, p_subject, p_recipient, p_status, p_error, p_provider, p_provider_id, p_sent_to, p_now);
$$;

create function public.rpc_save_notification_template(p_actor_id uuid, p_owner_id uuid, p_event text, p_subject text, p_body text) returns jsonb
language sql set search_path = '' as $$ select app.save_notification_template(p_actor_id, p_owner_id, p_event, p_subject, p_body); $$;

create function public.rpc_reset_notification_template(p_actor_id uuid, p_owner_id uuid, p_event text) returns jsonb
language sql set search_path = '' as $$ select app.reset_notification_template(p_actor_id, p_owner_id, p_event); $$;

create function public.rpc_save_notification_preferences(p_user_id uuid, p_reminders boolean, p_updates boolean) returns jsonb
language sql set search_path = '' as $$ select app.save_notification_preferences(p_user_id, p_reminders, p_updates); $$;

create function public.rpc_set_admin_email(p_actor_id uuid, p_email text) returns jsonb
language sql set search_path = '' as $$ select app.set_admin_email(p_actor_id, p_email); $$;

revoke execute on function
  public.rpc_email_quota(timestamptz),
  public.rpc_claim_deliveries(timestamptz, integer, boolean, integer, integer),
  public.rpc_record_delivery_result(uuid, uuid, text, timestamptz, text, timestamptz, text, text, text, text),
  public.rpc_mark_delivery_bounced(text, text),
  public.rpc_log_direct_delivery(uuid, uuid, text, text, text, text, text, text, text, text, timestamptz),
  public.rpc_save_notification_template(uuid, uuid, text, text, text),
  public.rpc_reset_notification_template(uuid, uuid, text),
  public.rpc_save_notification_preferences(uuid, boolean, boolean),
  public.rpc_set_admin_email(uuid, text)
from public, anon, authenticated;
grant execute on function
  public.rpc_email_quota(timestamptz),
  public.rpc_claim_deliveries(timestamptz, integer, boolean, integer, integer),
  public.rpc_record_delivery_result(uuid, uuid, text, timestamptz, text, timestamptz, text, text, text, text),
  public.rpc_mark_delivery_bounced(text, text),
  public.rpc_log_direct_delivery(uuid, uuid, text, text, text, text, text, text, text, text, timestamptz),
  public.rpc_save_notification_template(uuid, uuid, text, text, text),
  public.rpc_reset_notification_template(uuid, uuid, text),
  public.rpc_save_notification_preferences(uuid, boolean, boolean),
  public.rpc_set_admin_email(uuid, text)
to service_role;
