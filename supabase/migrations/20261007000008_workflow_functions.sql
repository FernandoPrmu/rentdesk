-- =============================================================================
-- 0008 Atomic workflow functions (server-only).
--
-- Every multi-table change runs inside ONE of these functions, so it commits or
-- rolls back as a unit. They are SECURITY DEFINER, executable ONLY by service_role
-- (grants in 0009), and called through rpc() by server code:
--
--   src/lib/tickets (TS state machine) validates the request and the actor's role,
--   computes amounts and deadlines (billing engine, Asia/Colombo), then calls the
--   function. The function locks the ticket row (SELECT ... FOR UPDATE), re-checks
--   the current status and the actor, and only then writes. A concurrent request
--   for the same ticket waits for the lock and then fails the status re-check, so a
--   ticket can never be transitioned twice.
--
-- Error codes (SQLSTATE, mapped by server code):
--   RD400 invalid input / transition not allowed   RD403 actor not permitted
--   RD404 not found                                 RD409 stale state / conflict
--
-- Notifications: each function takes p_notifications, a JSON array of
--   { user_id, event, title, body?, channel? (default IN_APP), link?, data?,
--     entity_type?, entity_id? }
-- written in the same transaction. "{entity_id}" in link is replaced by the ticket id.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------
create function app.fail(p_code text, p_message text) returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = p_code, message = p_message;
end;
$$;

-- Record the acting user for audit triggers in this transaction (see app.resolve_actor).
create function app.set_actor(p_actor_id uuid) returns void
language sql
set search_path = ''
as $$
  select set_config('app.actor_id', coalesce(p_actor_id::text, ''), true);
$$;

-- Allowed ticket transitions: spec 5.3 and section 11. CANCELLED is final.
create function app.ticket_transition_allowed(p_from public.ticket_status, p_to public.ticket_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'METER_REQUESTED'      then p_to in ('PENDING_OWNER_REVIEW', 'OVERDUE', 'CANCELLED')
    when 'PENDING_OWNER_REVIEW' then p_to in ('AWAITING_PAYMENT', 'METER_REQUESTED', 'CANCELLED')
    when 'AWAITING_PAYMENT'     then p_to in ('PAYMENT_SUBMITTED', 'OVERDUE', 'DISPUTED', 'CANCELLED')
    when 'PAYMENT_SUBMITTED'    then p_to in ('CLOSED', 'AWAITING_PAYMENT', 'PARTIALLY_PAID')
    when 'PARTIALLY_PAID'       then p_to in ('PAYMENT_SUBMITTED', 'OVERDUE', 'DISPUTED', 'CANCELLED')
    when 'OVERDUE'              then p_to in ('PENDING_OWNER_REVIEW', 'AWAITING_PAYMENT', 'PARTIALLY_PAID',
                                              'PAYMENT_SUBMITTED', 'DISPUTED', 'CANCELLED')
    when 'DISPUTED'             then p_to in ('AWAITING_PAYMENT', 'CANCELLED')
    when 'CLOSED'               then p_to = 'REOPENED'
    when 'REOPENED'             then p_to in ('AWAITING_PAYMENT', 'OVERDUE')
    else false
  end;
$$;

-- Verify the actor is active, has an allowed role, and belongs to this ticket:
-- an OWNER must own the tenant, a CUSTOMER must be the ticket's customer.
-- p_actor_id null = the system (cron), allowed only when p_allow_system.
create function app.assert_actor(
  p_actor_id uuid,
  p_owner_id uuid,
  p_customer_id uuid,
  p_allowed public.user_role[],
  p_allow_system boolean default false
) returns public.user_role
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.user_role;
begin
  if p_actor_id is null then
    if p_allow_system then
      return null;
    end if;
    perform app.fail('RD403', 'This action needs a signed-in actor');
  end if;

  select p.role into v_role
  from public.profiles p
  left join public.profiles o on o.id = p.owner_id
  where p.id = p_actor_id
    and p.status = 'ACTIVE'
    and (p.owner_id is null or o.status = 'ACTIVE');

  if v_role is null or not (v_role = any (p_allowed)) then
    perform app.fail('RD403', 'This user may not perform this action');
  end if;
  if v_role = 'OWNER' and p_actor_id <> p_owner_id then
    perform app.fail('RD403', 'This ticket belongs to another owner');
  end if;
  if v_role = 'CUSTOMER' and p_actor_id is distinct from p_customer_id then
    perform app.fail('RD403', 'This ticket belongs to another customer');
  end if;
  return v_role;
end;
$$;

create function app.lock_ticket(p_ticket_id uuid) returns public.billing_cycle_tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
begin
  select * into t from public.billing_cycle_tickets where id = p_ticket_id for update;
  if not found then
    perform app.fail('RD404', 'Ticket not found');
  end if;
  return t;
end;
$$;

-- Move a (locked) ticket into a new stage and reset the stage clock.
create function app.enter_stage(p_ticket_id uuid, p_to public.ticket_status, p_stage_due_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.billing_cycle_tickets
  set status = p_to,
      status_before_overdue = case when p_to = 'OVERDUE' then status end,
      stage_due_at = p_stage_due_at,
      escalation_level = 0,
      reminder_count = 0,
      last_reminder_at = null
  where id = p_ticket_id;
$$;

create function app.insert_ticket_event(
  p_ticket public.billing_cycle_tickets,
  p_event_type public.ticket_event_type,
  p_to public.ticket_status,
  p_actor_id uuid,
  p_reason text,
  p_metadata jsonb
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.ticket_events (owner_id, ticket_id, event_type, from_status, to_status, actor_id, reason, metadata)
  values (p_ticket.owner_id, p_ticket.id, p_event_type, p_ticket.status, p_to, p_actor_id,
          nullif(btrim(p_reason), ''), coalesce(p_metadata, '{}'::jsonb));
$$;

create function app.enqueue_notifications(
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
begin
  if p_items is null or p_items = 'null'::jsonb then
    return 0;
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    perform app.fail('RD400', 'Notifications must be a JSON array');
  end if;

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
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Invoice numbers (INV-11): unique per owner, ordered, gap-free, concurrency-safe.
-- Call only inside the transaction that issues the invoice.
-- -----------------------------------------------------------------------------
create function app.assign_invoice_number(p_invoice_id uuid) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_invoice_no text;
  v_seq bigint;
  v_prefix text;
begin
  select i.owner_id, i.invoice_no into v_owner_id, v_invoice_no
  from public.invoices i where i.id = p_invoice_id for update;
  if not found then
    perform app.fail('RD404', 'Invoice not found');
  end if;
  if v_invoice_no is not null then
    return v_invoice_no; -- already numbered: idempotent
  end if;

  insert into public.invoice_counters (owner_id) values (v_owner_id) on conflict (owner_id) do nothing;
  -- The row lock taken by this UPDATE serialises concurrent issuers for the owner;
  -- a rollback of the surrounding transaction also undoes the increment.
  update public.invoice_counters
  set last_value = last_value + 1, updated_at = now()
  where owner_id = v_owner_id
  returning last_value, prefix into v_seq, v_prefix;

  v_invoice_no := v_prefix || lpad(v_seq::text, 6, '0');
  update public.invoices set invoice_seq = v_seq, invoice_no = v_invoice_no where id = p_invoice_id;
  return v_invoice_no;
end;
$$;

-- -----------------------------------------------------------------------------
-- Account provisioning: profile + owners/customers (+ settings and counter rows)
-- in one transaction. The auth user is created first through the Auth Admin API.
-- Returns {created:false} if the profile already exists (safe to re-run).
-- -----------------------------------------------------------------------------
create function app.provision_account(
  p_user_id uuid,
  p_role public.user_role,
  p_username text,
  p_full_name text,
  p_owner_id uuid,
  p_created_by uuid,
  p_must_change_password boolean default true,
  p_details jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_role public.user_role;
begin
  perform app.set_actor(p_created_by);

  if exists (select 1 from public.profiles where id = p_user_id) then
    return jsonb_build_object('user_id', p_user_id, 'created', false);
  end if;

  select role into v_creator_role from public.profiles where id = p_created_by and status = 'ACTIVE';

  -- AUTH-01: accounts are created only by the role above.
  if p_role = 'OWNER' and v_creator_role is distinct from 'ADMIN' then
    perform app.fail('RD403', 'Only an admin can create owners');
  elsif p_role = 'CUSTOMER' and (v_creator_role is distinct from 'OWNER' or p_created_by <> p_owner_id) then
    perform app.fail('RD403', 'Only the owner can create their customers');
  elsif p_role = 'ADMIN' and p_created_by is not null and v_creator_role is distinct from 'ADMIN' then
    perform app.fail('RD403', 'Only an admin can create admins');
  end if;

  insert into public.profiles (id, role, owner_id, username, full_name, must_change_password, created_by)
  values (
    p_user_id,
    p_role,
    case p_role when 'OWNER' then p_user_id when 'CUSTOMER' then p_owner_id end,
    p_username,
    coalesce(p_full_name, ''),
    p_must_change_password,
    p_created_by
  );

  if p_role = 'OWNER' then
    insert into public.owners (id, business_name, contact_person, phone, email, address)
    values (
      p_user_id,
      p_details ->> 'business_name',
      coalesce(p_details ->> 'contact_person', p_full_name, ''),
      p_details ->> 'phone',
      p_details ->> 'email',
      p_details ->> 'address'
    );
    insert into public.owner_settings (owner_id) values (p_user_id);
    insert into public.invoice_counters (owner_id) values (p_user_id);
  elsif p_role = 'CUSTOMER' then
    insert into public.customers (id, owner_id, name, business_name, phone, email, address)
    values (
      p_user_id,
      p_owner_id,
      coalesce(p_details ->> 'name', p_full_name),
      p_details ->> 'business_name',
      p_details ->> 'phone',
      p_details ->> 'email',
      p_details ->> 'address'
    );
  end if;

  return jsonb_build_object('user_id', p_user_id, 'created', true);
end;
$$;

-- Explicit audit entries from server code (logins, password resets, denied access).
create function app.write_audit(
  p_actor_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid default null,
  p_owner_id uuid default null,
  p_details jsonb default '{}'::jsonb
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (actor_id, actor_role, owner_id, action, entity, entity_id, details)
  values (p_actor_id, (select role from public.profiles where id = p_actor_id), p_owner_id,
          p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

-- -----------------------------------------------------------------------------
-- TKT-01/07/08: open the next cycle of an agreement (daily cron, system actor).
-- Replays safely: an existing (agreement, cycle) ticket is returned, never duplicated.
-- The agreement row lock serialises concurrent cron runs.
-- -----------------------------------------------------------------------------
create function app.open_billing_cycle(
  p_agreement_id uuid,
  p_cycle_no integer,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.rental_agreements;
  v_ticket_id uuid;
  v_machine_type public.machine_type;
  v_cycle_date date;
begin
  perform app.set_actor(null);

  select * into a from public.rental_agreements where id = p_agreement_id for update;
  if not found then
    perform app.fail('RD404', 'Agreement not found');
  end if;

  select id into v_ticket_id
  from public.billing_cycle_tickets
  where agreement_id = p_agreement_id and cycle_no = p_cycle_no;
  if found then
    return jsonb_build_object('ticket_id', v_ticket_id, 'cycle_no', p_cycle_no, 'replayed', true);
  end if;

  if a.status <> 'ACTIVE' then
    return jsonb_build_object('skipped', 'AGREEMENT_NOT_ACTIVE', 'cycle_no', p_cycle_no);
  end if;
  if p_cycle_no <> a.next_cycle_no then
    perform app.fail('RD409', format('Agreement is due for cycle %s, not %s', a.next_cycle_no, p_cycle_no));
  end if;
  -- Spec 5.5 / 11.8: no new tickets for suspended customers or owners.
  if not exists (
    select 1 from public.profiles c join public.profiles o on o.id = c.owner_id
    where c.id = a.customer_id and c.status = 'ACTIVE' and o.status = 'ACTIVE'
  ) then
    return jsonb_build_object('skipped', 'ACCOUNT_NOT_ACTIVE', 'cycle_no', p_cycle_no);
  end if;

  v_cycle_date := a.next_cycle_date;
  select m.type into v_machine_type from public.machines m where m.id = a.machine_id;

  insert into public.billing_cycle_tickets (
    owner_id, customer_id, agreement_id, machine_id, cycle_no, cycle_date, period_start, period_end,
    status, stage_due_at, machine_type, cycle_length_days, commitment_cents,
    bw_included, bw_rate_cents, colour_included, colour_rate_cents
  ) values (
    a.owner_id, a.customer_id, a.id, a.machine_id, p_cycle_no, v_cycle_date,
    v_cycle_date - a.cycle_length_days, v_cycle_date - 1,
    'METER_REQUESTED', p_stage_due_at, v_machine_type, a.cycle_length_days, a.monthly_commitment_cents,
    a.bw_included, a.bw_rate_cents, a.colour_included, a.colour_rate_cents
  )
  returning id into v_ticket_id;

  insert into public.ticket_events (owner_id, ticket_id, event_type, to_status, actor_id, metadata)
  values (a.owner_id, v_ticket_id, 'CREATED', 'METER_REQUESTED', null,
          jsonb_build_object('cycle_no', p_cycle_no, 'cycle_date', v_cycle_date));

  -- TKT-07: the next cycle follows the calendar, not the close date.
  update public.rental_agreements
  set next_cycle_no = next_cycle_no + 1,
      next_cycle_date = next_cycle_date + cycle_length_days
  where id = a.id;

  perform app.enqueue_notifications(a.owner_id, p_notifications, 'billing_cycle_ticket', v_ticket_id);

  return jsonb_build_object('ticket_id', v_ticket_id, 'cycle_no', p_cycle_no, 'cycle_date', v_cycle_date, 'replayed', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- Generic owner/system transition: overdue flags, cancel, reopen, return from
-- overdue/dispute. Transitions with side effects have dedicated functions below
-- and are refused here. The current invoice follows the ticket (spec 6.6).
-- -----------------------------------------------------------------------------
create function app.transition_ticket(
  p_ticket_id uuid,
  p_from public.ticket_status,
  p_to public.ticket_status,
  p_actor_id uuid,
  p_reason text default null,
  p_stage_due_at timestamptz default null,
  p_invoice_status public.invoice_status default null,
  p_event_type public.ticket_event_type default 'STATUS_CHANGE',
  p_metadata jsonb default '{}'::jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
  v_invoice_status public.invoice_status;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);

  -- Re-check under the lock: a concurrent request that already moved the ticket wins.
  if t.status <> p_from then
    perform app.fail('RD409', format('Ticket is %s, not %s', t.status, p_from));
  end if;
  if not app.ticket_transition_allowed(p_from, p_to) then
    perform app.fail('RD400', format('Transition %s -> %s is not allowed', p_from, p_to));
  end if;
  if p_to in ('PENDING_OWNER_REVIEW', 'PAYMENT_SUBMITTED', 'CLOSED', 'DISPUTED')
     or (p_from = 'PENDING_OWNER_REVIEW' and p_to <> 'CANCELLED') then
    perform app.fail('RD400', format('Transition %s -> %s needs its dedicated workflow function', p_from, p_to));
  end if;
  -- TKT-10 / spec 11: cancelling and reopening need a reason.
  if p_to in ('CANCELLED', 'REOPENED') and coalesce(btrim(p_reason), '') = '' then
    perform app.fail('RD400', 'A reason is required');
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[], true);

  perform app.insert_ticket_event(t, p_event_type, p_to, p_actor_id, p_reason, p_metadata);
  perform app.enter_stage(t.id, p_to, p_stage_due_at);
  if p_to = 'REOPENED' then
    update public.billing_cycle_tickets set closed_at = null, closed_by = null where id = t.id;
  end if;

  if t.current_invoice_id is not null then
    select * into inv from public.invoices where id = t.current_invoice_id for update;
    v_invoice_status := coalesce(p_invoice_status, case p_to
      when 'OVERDUE' then 'OVERDUE'
      when 'AWAITING_PAYMENT' then 'AWAITING_PAYMENT'
      when 'PARTIALLY_PAID' then 'PARTIALLY_PAID'
      when 'CANCELLED' then 'CANCELLED'
    end::public.invoice_status);

    if v_invoice_status is not null and v_invoice_status <> inv.status then
      update public.invoices
      set status = v_invoice_status,
          cancelled_by = case when v_invoice_status = 'CANCELLED' then p_actor_id else cancelled_by end,
          cancelled_at = case when v_invoice_status = 'CANCELLED' then now() else cancelled_at end,
          cancel_reason = case when v_invoice_status = 'CANCELLED' then btrim(p_reason) else cancel_reason end
      where id = inv.id;

      -- Spec 11.4: money already paid on a cancelled invoice is kept as credit.
      if v_invoice_status = 'CANCELLED' and inv.amount_paid_cents > 0 then
        insert into public.credits (owner_id, customer_id, source_invoice_id, kind, amount_cents, reason, created_by)
        values (t.owner_id, t.customer_id, inv.id, 'CANCELLED_INVOICE', inv.amount_paid_cents,
                format('Paid on cancelled invoice %s', coalesce(inv.invoice_no, inv.id::text)), p_actor_id);
      end if;
    end if;
  end if;

  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'from', p_from, 'status', p_to);
end;
$$;

-- -----------------------------------------------------------------------------
-- Steps 2-3 (INV-01..06, INV-12..14): customer (or owner manual entry) submits
-- readings; the draft invoice computed by the TS billing engine is stored; the
-- ticket moves to PENDING_OWNER_REVIEW.
--   p_readings: [{counter_type, previous_value, current_value, rolled_over?}]
--   p_photo:    {storage_path, captured_at?}  (required for CUSTOMER source)
--   p_invoice:  {type?, period_start?, period_end?, cycles_covered?, subtotal_cents,
--                credit_applied_cents?, total_cents,
--                lines: [{line_type, description, quantity, rate_cents, amount_cents}]}
-- -----------------------------------------------------------------------------
create function app.submit_meter_reading(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_source public.reading_source,
  p_readings jsonb,
  p_photo jsonb,
  p_invoice jsonb,
  p_stage_due_at timestamptz,
  p_note text default null,
  p_anomaly_flag text default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  v_existing public.meter_submissions;
  v_to constant public.ticket_status := 'PENDING_OWNER_REVIEW';
  v_submission_id uuid;
  v_invoice_id uuid;
  v_attempt smallint;
  v_reading jsonb;
  v_line jsonb;
  v_sort smallint := 0;
  v_lines_total bigint;
  v_late boolean;
begin
  perform app.set_actor(p_actor_id);
  if p_idempotency_key is null then
    perform app.fail('RD400', 'An idempotency key is required');
  end if;
  t := app.lock_ticket(p_ticket_id);

  -- INV-13: a retried request returns the original result instead of failing.
  select * into v_existing from public.meter_submissions s where s.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.ticket_id <> p_ticket_id then
      perform app.fail('RD409', 'Idempotency key already used for another ticket');
    end if;
    return jsonb_build_object('ticket_id', p_ticket_id, 'submission_id', v_existing.id,
                              'invoice_id', v_existing.invoice_id, 'status', t.status, 'replayed', true);
  end if;

  if not (t.status = 'METER_REQUESTED' or (t.status = 'OVERDUE' and t.status_before_overdue = 'METER_REQUESTED')) then
    perform app.fail('RD409', format('Ticket is %s; meter readings are not expected', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id,
    (case p_source when 'CUSTOMER' then array['CUSTOMER'] else array['OWNER'] end)::public.user_role[]);

  if jsonb_typeof(p_readings) is distinct from 'array'
     or jsonb_array_length(p_readings) <> (case t.machine_type when 'COLOUR' then 2 else 1 end) then
    perform app.fail('RD400', format('A %s machine needs %s reading(s)', t.machine_type,
                                     case t.machine_type when 'COLOUR' then 2 else 1 end));
  end if;
  if p_source = 'CUSTOMER' and p_photo is null then
    perform app.fail('RD400', 'A live meter photo is required');
  end if;
  if p_photo is not null
     and coalesce(p_photo ->> 'storage_path', '') not like t.owner_id::text || '/' || t.id::text || '/%' then
    perform app.fail('RD400', 'Photo path must be {owner_id}/{ticket_id}/...');
  end if;
  if jsonb_typeof(p_invoice -> 'lines') is distinct from 'array' or jsonb_array_length(p_invoice -> 'lines') = 0 then
    perform app.fail('RD400', 'Invoice lines are required');
  end if;
  select coalesce(sum((l ->> 'amount_cents')::bigint), 0) into v_lines_total
  from jsonb_array_elements(p_invoice -> 'lines') l;
  if v_lines_total is distinct from (p_invoice ->> 'total_cents')::bigint then
    perform app.fail('RD400', 'Invoice lines do not add up to the total');
  end if;

  -- Spec 6.1: photos of earlier rejected attempts are purged once the customer resubmits.
  update public.meter_photos ph
  set delete_requested_at = now()
  from public.meter_submissions s
  where s.id = ph.submission_id and s.ticket_id = t.id and s.status = 'REJECTED'
    and ph.delete_requested_at is null and ph.deleted_at is null;

  select coalesce(max(s.attempt_no), 0) + 1 into v_attempt
  from public.meter_submissions s where s.ticket_id = t.id;

  insert into public.meter_submissions (
    owner_id, ticket_id, customer_id, attempt_no, source, idempotency_key, submitted_by, note, anomaly_flag
  ) values (
    t.owner_id, t.id, t.customer_id, v_attempt, p_source, p_idempotency_key, p_actor_id,
    nullif(btrim(p_note), ''), p_anomaly_flag
  )
  returning id into v_submission_id;

  for v_reading in select * from jsonb_array_elements(p_readings) loop
    insert into public.meter_readings (owner_id, submission_id, counter_type, previous_value, current_value, rolled_over)
    values (
      t.owner_id, v_submission_id,
      (v_reading ->> 'counter_type')::public.counter_type,
      (v_reading ->> 'previous_value')::bigint,
      (v_reading ->> 'current_value')::bigint,
      coalesce((v_reading ->> 'rolled_over')::boolean, false)
    );
  end loop;
  if t.machine_type = 'MONO' and exists (
    select 1 from public.meter_readings r where r.submission_id = v_submission_id and r.counter_type = 'COLOUR'
  ) then
    perform app.fail('RD400', 'A mono machine has only a B&W counter');
  end if;

  if p_photo is not null then
    insert into public.meter_photos (owner_id, submission_id, storage_path, captured_at)
    values (t.owner_id, v_submission_id, p_photo ->> 'storage_path', nullif(p_photo ->> 'captured_at', '')::timestamptz);
  end if;

  insert into public.invoices (
    owner_id, customer_id, agreement_id, machine_id, ticket_id, type, status,
    period_start, period_end, cycles_covered, subtotal_cents, credit_applied_cents, total_cents
  ) values (
    t.owner_id, t.customer_id, t.agreement_id, t.machine_id, t.id,
    coalesce(p_invoice ->> 'type', 'NORMAL')::public.invoice_type, 'DRAFT',
    coalesce((p_invoice ->> 'period_start')::date, t.period_start),
    coalesce((p_invoice ->> 'period_end')::date, t.period_end),
    coalesce((p_invoice ->> 'cycles_covered')::smallint, 1),
    (p_invoice ->> 'subtotal_cents')::bigint,
    coalesce((p_invoice ->> 'credit_applied_cents')::bigint, 0),
    (p_invoice ->> 'total_cents')::bigint
  )
  returning id into v_invoice_id;

  for v_line in select * from jsonb_array_elements(p_invoice -> 'lines') loop
    insert into public.invoice_lines (owner_id, invoice_id, line_type, description, quantity, rate_cents, amount_cents, sort_order)
    values (
      t.owner_id, v_invoice_id,
      (v_line ->> 'line_type')::public.invoice_line_type,
      v_line ->> 'description',
      coalesce((v_line ->> 'quantity')::bigint, 1),
      (v_line ->> 'rate_cents')::bigint,
      (v_line ->> 'amount_cents')::bigint,
      v_sort
    );
    v_sort := v_sort + 1;
  end loop;

  update public.meter_submissions set invoice_id = v_invoice_id where id = v_submission_id;

  -- Spec 11.6: a submission after the stage deadline is accepted and marked Late.
  v_late := t.status = 'OVERDUE' or (t.stage_due_at is not null and now() > t.stage_due_at);

  perform app.insert_ticket_event(
    t,
    (case p_source when 'OWNER_MANUAL' then 'MANUAL_ENTRY' else 'STATUS_CHANGE' end)::public.ticket_event_type,
    v_to, p_actor_id, p_note,
    jsonb_build_object('submission_id', v_submission_id, 'invoice_id', v_invoice_id,
                       'attempt_no', v_attempt, 'late', v_late, 'anomaly_flag', p_anomaly_flag)
  );
  perform app.enter_stage(t.id, v_to, p_stage_due_at);
  update public.billing_cycle_tickets
  set current_invoice_id = v_invoice_id, is_late = is_late or v_late
  where id = t.id;

  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'submission_id', v_submission_id, 'invoice_id', v_invoice_id,
                            'status', v_to, 'is_late', v_late, 'replayed', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- Steps 4-5 (INV-07, INV-09, INV-11): owner confirms. Invoice numbered and issued,
-- submission confirmed, photo marked for deletion, ticket -> AWAITING_PAYMENT.
-- Returns photo_paths: server code deletes those storage objects AFTER this
-- commits and then sets meter_photos.deleted_at (the daily cron retries leftovers).
-- -----------------------------------------------------------------------------
create function app.confirm_meter_submission(
  p_ticket_id uuid,
  p_submission_id uuid,
  p_actor_id uuid,
  p_due_date date,
  p_stage_due_at timestamptz,
  p_branding_snapshot jsonb default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  s public.meter_submissions;
  v_to constant public.ticket_status := 'AWAITING_PAYMENT';
  v_invoice_no text;
  v_paths text[];
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);

  if t.status <> 'PENDING_OWNER_REVIEW' then
    perform app.fail('RD409', format('Ticket is %s, not PENDING_OWNER_REVIEW', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[]);
  if p_due_date is null then
    perform app.fail('RD400', 'A due date is required');
  end if;

  select * into s from public.meter_submissions where id = p_submission_id and ticket_id = t.id for update;
  if not found then
    perform app.fail('RD404', 'Submission not found on this ticket');
  end if;
  if s.status <> 'PENDING_REVIEW' or s.invoice_id is distinct from t.current_invoice_id then
    perform app.fail('RD409', 'This submission is no longer awaiting review');
  end if;

  -- Number first (still DRAFT); if anything below fails, the number is released too.
  v_invoice_no := app.assign_invoice_number(s.invoice_id);

  update public.invoices
  set status = 'AWAITING_PAYMENT', due_date = p_due_date, confirmed_by = p_actor_id,
      confirmed_at = now(), issued_at = now(), branding_snapshot = p_branding_snapshot
  where id = s.invoice_id and status = 'DRAFT';
  if not found then
    perform app.fail('RD409', 'The draft invoice is no longer a draft');
  end if;

  update public.meter_submissions
  set status = 'CONFIRMED', reviewed_by = p_actor_id, reviewed_at = now()
  where id = s.id;

  with marked as (
    update public.meter_photos
    set delete_requested_at = coalesce(delete_requested_at, now())
    where submission_id = s.id and deleted_at is null
    returning storage_path
  )
  select coalesce(array_agg(storage_path), '{}') into v_paths from marked;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, p_actor_id, null,
    jsonb_build_object('submission_id', s.id, 'invoice_id', s.invoice_id, 'invoice_no', v_invoice_no));
  perform app.enter_stage(t.id, v_to, p_stage_due_at);
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'invoice_id', s.invoice_id, 'invoice_no', v_invoice_no,
                            'status', v_to, 'photo_paths', to_jsonb(v_paths));
end;
$$;

-- -----------------------------------------------------------------------------
-- INV-07 / spec 11.3: owner rejects a submission (reason required). Draft invoice
-- -> REJECTED, ticket -> METER_REQUESTED, photo kept until resubmission/retention.
-- -----------------------------------------------------------------------------
create function app.reject_meter_submission(
  p_ticket_id uuid,
  p_submission_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_stage_due_at timestamptz,
  p_photo_expires_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  s public.meter_submissions;
  v_to constant public.ticket_status := 'METER_REQUESTED';
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);

  if t.status <> 'PENDING_OWNER_REVIEW' then
    perform app.fail('RD409', format('Ticket is %s, not PENDING_OWNER_REVIEW', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[]);
  if coalesce(btrim(p_reason), '') = '' then
    perform app.fail('RD400', 'A reason is required to reject a reading');
  end if;

  select * into s from public.meter_submissions where id = p_submission_id and ticket_id = t.id for update;
  if not found then
    perform app.fail('RD404', 'Submission not found on this ticket');
  end if;
  if s.status <> 'PENDING_REVIEW' or s.invoice_id is distinct from t.current_invoice_id then
    perform app.fail('RD409', 'This submission is no longer awaiting review');
  end if;

  update public.invoices set status = 'REJECTED' where id = s.invoice_id and status = 'DRAFT';
  update public.meter_submissions
  set status = 'REJECTED', reject_reason = btrim(p_reason), reviewed_by = p_actor_id, reviewed_at = now()
  where id = s.id;
  update public.meter_photos set expires_at = p_photo_expires_at
  where submission_id = s.id and deleted_at is null;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, p_actor_id, p_reason,
    jsonb_build_object('submission_id', s.id, 'invoice_id', s.invoice_id));
  perform app.enter_stage(t.id, v_to, p_stage_due_at);
  update public.billing_cycle_tickets
  set current_invoice_id = null, rejection_count = rejection_count + 1
  where id = t.id;
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'status', v_to, 'rejection_count', t.rejection_count + 1);
end;
$$;

-- -----------------------------------------------------------------------------
-- Steps 6-7 (PAY-02..04, PAY-07, PAY-11): customer submits a slip, or the owner
-- records a cash/cheque payment. Ticket and invoice -> PAYMENT_SUBMITTED.
--   p_payment: {amount_cents, paid_on, method?, reference?, note?}
--   p_slip:    {storage_path, sha256, mime_type, size_bytes, retention_until?}
-- -----------------------------------------------------------------------------
create function app.submit_payment(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_source public.payment_source,
  p_payment jsonb,
  p_slip jsonb,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
  v_existing public.payments;
  v_to constant public.ticket_status := 'PAYMENT_SUBMITTED';
  v_payment_id uuid;
  v_duplicate_of uuid;
  v_reference text := nullif(btrim(p_payment ->> 'reference'), '');
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);

  if p_idempotency_key is not null then
    select * into v_existing from public.payments p where p.idempotency_key = p_idempotency_key;
    if found then
      if v_existing.ticket_id <> p_ticket_id then
        perform app.fail('RD409', 'Idempotency key already used for another ticket');
      end if;
      return jsonb_build_object('ticket_id', p_ticket_id, 'payment_id', v_existing.id,
                                'duplicate_of_payment_id', v_existing.duplicate_of_payment_id,
                                'status', t.status, 'replayed', true);
    end if;
  end if;

  if not (t.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID')
          or (t.status = 'OVERDUE' and t.status_before_overdue in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED'))) then
    perform app.fail('RD409', format('Ticket is %s; no payment is expected', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id,
    (case p_source when 'CUSTOMER_SLIP' then array['CUSTOMER'] else array['OWNER'] end)::public.user_role[]);
  if p_source = 'CUSTOMER_SLIP' and p_slip is null then
    perform app.fail('RD400', 'A payment slip is required');
  end if;
  if p_slip is not null
     and coalesce(p_slip ->> 'storage_path', '') not like t.owner_id::text || '/' || t.id::text || '/%' then
    perform app.fail('RD400', 'Slip path must be {owner_id}/{ticket_id}/...');
  end if;

  select * into inv from public.invoices where id = t.current_invoice_id for update;
  if not found or inv.status not in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE') then
    perform app.fail('RD409', 'There is no payable invoice on this ticket');
  end if;

  -- PAY-11: flag (not block) a reused bank reference or slip file.
  select p.id into v_duplicate_of
  from public.payments p
  where p.owner_id = t.owner_id
    and ((v_reference is not null and lower(p.reference) = lower(v_reference))
         or (p_slip is not null and exists (
               select 1 from public.payment_slips sl
               where sl.payment_id = p.id and sl.sha256 = p_slip ->> 'sha256')))
  order by p.submitted_at
  limit 1;

  insert into public.payments (
    owner_id, invoice_id, ticket_id, customer_id, source, method, amount_cents, paid_on,
    reference, note, idempotency_key, submitted_by, duplicate_of_payment_id
  ) values (
    t.owner_id, inv.id, t.id, t.customer_id, p_source,
    coalesce(p_payment ->> 'method', case p_source when 'CUSTOMER_SLIP' then 'BANK_TRANSFER' else 'CASH' end)::public.payment_method,
    (p_payment ->> 'amount_cents')::bigint,
    (p_payment ->> 'paid_on')::date,
    v_reference,
    nullif(btrim(p_payment ->> 'note'), ''),
    p_idempotency_key,
    p_actor_id,
    v_duplicate_of
  )
  returning id into v_payment_id;

  if p_slip is not null then
    insert into public.payment_slips (owner_id, payment_id, storage_path, sha256, mime_type, size_bytes, uploaded_by, retention_until)
    values (
      t.owner_id, v_payment_id, p_slip ->> 'storage_path', p_slip ->> 'sha256', p_slip ->> 'mime_type',
      (p_slip ->> 'size_bytes')::integer, p_actor_id, nullif(p_slip ->> 'retention_until', '')::date
    );
  end if;

  -- Spec 8.2: while a slip waits for verification the invoice is not overdue.
  update public.invoices set status = 'PAYMENT_SUBMITTED' where id = inv.id;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, p_actor_id, null,
    jsonb_build_object('payment_id', v_payment_id, 'amount_cents', (p_payment ->> 'amount_cents')::bigint,
                       'source', p_source, 'duplicate_of_payment_id', v_duplicate_of));
  perform app.enter_stage(t.id, v_to, p_stage_due_at);
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'payment_id', v_payment_id,
                            'duplicate_of_payment_id', v_duplicate_of, 'status', v_to, 'replayed', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- Steps 8-9 (PAY-05, PAY-06, PAY-12): owner verifies the slip.
--   accept, fully paid  -> payment ACCEPTED, invoice PAID, ticket CLOSED
--                          (any excess becomes an OVERPAYMENT credit)
--   accept, balance due -> payment PARTIAL, invoice + ticket PARTIALLY_PAID
--   reject (reason)     -> payment REJECTED, back to AWAITING_PAYMENT
--                          (or PARTIALLY_PAID if part was already accepted)
-- -----------------------------------------------------------------------------
create function app.verify_payment(
  p_ticket_id uuid,
  p_payment_id uuid,
  p_actor_id uuid,
  p_accept boolean,
  p_accepted_amount_cents bigint default null,
  p_reason text default null,
  p_stage_due_at timestamptz default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  pay public.payments;
  inv public.invoices;
  v_accepted bigint;
  v_paid bigint;
  v_overpaid bigint := 0;
  v_to public.ticket_status;
  v_invoice_status public.invoice_status;
  v_payment_status public.payment_status;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);

  if t.status <> 'PAYMENT_SUBMITTED' then
    perform app.fail('RD409', format('Ticket is %s, not PAYMENT_SUBMITTED', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[]);
  if p_accept is null then
    perform app.fail('RD400', 'Accept or reject must be chosen');
  end if;

  select * into pay from public.payments where id = p_payment_id and ticket_id = t.id for update;
  if not found then
    perform app.fail('RD404', 'Payment not found on this ticket');
  end if;
  if pay.status <> 'SUBMITTED' then
    perform app.fail('RD409', 'This payment has already been verified');
  end if;
  select * into inv from public.invoices where id = pay.invoice_id for update;
  if inv.id is distinct from t.current_invoice_id then
    perform app.fail('RD409', 'The payment is not for the ticket''s current invoice');
  end if;

  if not p_accept then
    if coalesce(btrim(p_reason), '') = '' then
      perform app.fail('RD400', 'A reason is required to reject a payment');
    end if;
    v_payment_status := 'REJECTED';
    v_paid := inv.amount_paid_cents;
    v_to := case when v_paid > 0 then 'PARTIALLY_PAID' else 'AWAITING_PAYMENT' end;
    v_invoice_status := v_to::text::public.invoice_status;
  else
    v_accepted := coalesce(p_accepted_amount_cents, pay.amount_cents);
    if v_accepted <= 0 or v_accepted > pay.amount_cents then
      perform app.fail('RD400', 'Accepted amount must be more than 0 and not more than the slip amount');
    end if;
    v_paid := inv.amount_paid_cents + v_accepted;
    if v_paid >= inv.total_cents then
      v_overpaid := v_paid - inv.total_cents;
      v_paid := inv.total_cents;
      v_to := 'CLOSED';
      v_invoice_status := 'PAID';
      v_payment_status := 'ACCEPTED';
    else
      v_to := 'PARTIALLY_PAID';
      v_invoice_status := 'PARTIALLY_PAID';
      v_payment_status := 'PARTIAL';
    end if;
  end if;

  update public.payments
  set status = v_payment_status,
      accepted_amount_cents = v_accepted,
      reject_reason = case when p_accept then null else btrim(p_reason) end,
      verified_by = p_actor_id,
      verified_at = now()
  where id = pay.id;

  update public.invoices set status = v_invoice_status, amount_paid_cents = v_paid where id = inv.id;

  if v_overpaid > 0 then
    insert into public.credits (owner_id, customer_id, source_invoice_id, source_payment_id, kind, amount_cents, reason, created_by)
    values (t.owner_id, t.customer_id, inv.id, pay.id, 'OVERPAYMENT', v_overpaid,
            format('Overpayment on invoice %s', inv.invoice_no), p_actor_id);
  end if;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, p_actor_id, p_reason,
    jsonb_build_object('payment_id', pay.id, 'accepted_amount_cents', v_accepted,
                       'balance_cents', inv.total_cents - v_paid, 'credit_cents', v_overpaid));
  perform app.enter_stage(t.id, v_to, case when v_to = 'CLOSED' then null else p_stage_due_at end);
  if v_to = 'CLOSED' then
    update public.billing_cycle_tickets set closed_at = now(), closed_by = p_actor_id where id = t.id;
  end if;
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'payment_id', pay.id, 'status', v_to,
                            'invoice_status', v_invoice_status, 'balance_cents', inv.total_cents - v_paid,
                            'credit_cents', v_overpaid);
end;
$$;
