-- =============================================================================
-- 0001 Foundation: private `app` schema, enums, shared trigger functions, audit log.
--
-- Conventions used by every migration:
--   * Money is bigint cents. Timestamps are timestamptz. Business dates are `date`
--     in Asia/Colombo (computed by server code, never by the database clock alone).
--   * Every tenant table has owner_id -> owners(id) plus composite foreign keys
--     (child_id, owner_id) -> parent(id, owner_id) so a row can never point at another
--     tenant's data, even through the service role.
--   * Grants and RLS policies live in 0009; storage in 0010.
-- =============================================================================

create schema if not exists app;
comment on schema app is
  'Private helpers (RLS) and server-only workflow functions. Not for direct client use: '
  'authenticated may execute only the four read helpers; everything else is service_role only.';

revoke all on schema app from public;
-- New functions in `app` must not be executable by PUBLIC by default.
alter default privileges in schema app revoke execute on functions from public;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.user_role as enum ('ADMIN', 'OWNER', 'CUSTOMER');
create type public.account_status as enum ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

create type public.machine_type as enum ('MONO', 'COLOUR');
create type public.machine_status as enum ('AVAILABLE', 'RENTED', 'UNDER_REPAIR', 'RETIRED');
create type public.agreement_status as enum ('ACTIVE', 'SUSPENDED', 'TERMINATED');

-- Spec 5.3 / 11.
create type public.ticket_status as enum (
  'METER_REQUESTED', 'PENDING_OWNER_REVIEW', 'AWAITING_PAYMENT', 'PAYMENT_SUBMITTED',
  'CLOSED', 'OVERDUE', 'PARTIALLY_PAID', 'DISPUTED', 'CANCELLED', 'REOPENED'
);
create type public.ticket_event_type as enum (
  'CREATED', 'STATUS_CHANGE', 'REMINDER', 'ESCALATION', 'CORRECTION', 'MANUAL_ENTRY', 'BASELINE', 'NOTE'
);

-- Spec 4.8 (PAY-01) / 6.6.
create type public.invoice_status as enum (
  'DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'PAID',
  'OVERDUE', 'DISPUTED', 'REJECTED', 'CANCELLED'
);
create type public.invoice_type as enum ('NORMAL', 'ESTIMATED');
create type public.invoice_line_type as enum (
  'COMMITMENT', 'BW_EXCESS', 'COLOUR_EXCESS', 'LATE_FEE', 'CREDIT', 'ADJUSTMENT'
);

create type public.counter_type as enum ('BW', 'COLOUR');
create type public.reading_source as enum ('CUSTOMER', 'OWNER_MANUAL');
create type public.meter_submission_status as enum ('PENDING_REVIEW', 'CONFIRMED', 'REJECTED', 'SUPERSEDED');

create type public.payment_status as enum ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'PARTIAL');
create type public.payment_method as enum ('BANK_TRANSFER', 'DEPOSIT', 'CASH', 'CHEQUE', 'ONLINE', 'OTHER');
create type public.payment_source as enum ('CUSTOMER_SLIP', 'OWNER_MANUAL');

create type public.dispute_status as enum ('OPEN', 'RESOLVED', 'REJECTED');
create type public.credit_kind as enum (
  'OVERPAYMENT', 'ESTIMATE_RECONCILIATION', 'CANCELLED_INVOICE', 'ADVANCE', 'MANUAL'
);
create type public.credit_status as enum ('AVAILABLE', 'APPLIED', 'REFUNDED');

-- Spec 4.9.
create type public.service_request_type as enum ('BREAKDOWN', 'TONER', 'SPARE_PART', 'MAINTENANCE', 'OTHER');
create type public.service_request_status as enum (
  'NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED'
);
create type public.urgency as enum ('LOW', 'NORMAL', 'HIGH', 'URGENT');
create type public.toner_colour as enum ('BLACK', 'CYAN', 'MAGENTA', 'YELLOW');

create type public.notification_channel as enum ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP');
create type public.notification_status as enum ('PENDING', 'SENT', 'FAILED', 'READ');

create type public.idempotency_scope as enum (
  'METER_SUBMISSION', 'PAYMENT_SUBMISSION', 'SERVICE_REQUEST', 'TICKET_COMMENT'
);

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
create function app.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Audit log (append-only). Server-write-only: rows come from triggers and from
-- app.write_audit(). No client may insert, update or delete (see 0009).
-- No foreign keys on purpose: an audit record must outlive what it describes.
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role public.user_role,
  owner_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  -- clock_timestamp(): keeps several entries written in one transaction in order.
  created_at timestamptz not null default clock_timestamp()
);
comment on table public.audit_logs is
  'Append-only audit trail (AUTH-11, spec 3.3 / 11). SERVER-WRITE-ONLY. actor_id null = system.';
create index audit_logs_owner_id_idx on public.audit_logs (owner_id, created_at desc);
create index audit_logs_actor_id_idx on public.audit_logs (actor_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity, entity_id);
create index audit_logs_created_at_idx on public.audit_logs (created_at desc);

-- Who is acting?
--   * A signed-in user: auth.uid().
--   * The service role (server code): the workflow functions set `app.actor_id`
--     for the transaction; otherwise the `x-actor-id` request header is used.
--     Both are honoured ONLY when the JWT role is service_role, so a user can
--     never impersonate someone else.
--   * Anything else (cron, direct DB session): null = system.
create function app.resolve_actor() returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_raw text;
begin
  if v_uid is not null then
    return v_uid;
  end if;
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    return null;
  end if;
  v_raw := coalesce(
    nullif(current_setting('app.actor_id', true), ''),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-actor-id'
  );
  if v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v_raw::uuid;
  end if;
  return null;
end;
$$;

-- Generic audit trigger. TG_ARGV[0]:
--   'all'    - log every insert / update (with a column diff) / delete
--   'status' - log insert / delete, and updates only when `status` changes
create function app.audit_row_change() returns trigger
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
