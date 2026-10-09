-- =============================================================================
-- 0015 Billing engine wiring (INV-04, INV-05).
--
-- ONE source of truth for amounts: the TypeScript billing engine
-- (src/lib/billing). The database never calculates an amount. It stores the
-- engine's result and refuses it unless:
--   * it carries the engine's calculation record (invoices.calculation);
--   * the record's inputs are this ticket's facts: the terms snapshot, the cycles
--     since the last confirmed reading, the previous reading of every counter
--     (app.last_known_reading: initial reading, confirmed reading or baseline),
--     the submitted readings and rollover flags, and the anomaly flag;
--   * its arithmetic is consistent: every line amount = quantity x rate, and the
--     lines add up to subtotal, credit and total.
-- A counter rollover must be confirmed by the owner before the invoice is issued.
-- =============================================================================

alter table public.invoices add column calculation jsonb;
comment on column public.invoices.calculation is
  'Billing engine record (version, inputs, usage per counter): how the amount was calculated.';

alter table public.meter_readings
  add column rollover_confirmed_by uuid references public.profiles (id),
  add column rollover_confirmed_at timestamptz,
  add constraint meter_readings_rollover_confirmation check (rolled_over or rollover_confirmed_at is null);
create index meter_readings_rollover_confirmed_by_idx on public.meter_readings (rollover_confirmed_by);

-- -----------------------------------------------------------------------------
-- last_known_reading (replaces 0014's): deterministic on equal timestamps, with
-- the same priority as the engine's loader (src/lib/billing/context.ts):
-- a baseline beats a confirmed reading beats the initial reading.
-- -----------------------------------------------------------------------------
create or replace function app.last_known_reading(p_agreement_id uuid, p_counter public.counter_type) returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select value from (
    select case p_counter when 'BW' then a.initial_bw_reading else a.initial_colour_reading end as value,
           a.created_at as at, 0 as priority
    from public.rental_agreements a where a.id = p_agreement_id
    union all
    select r.current_value, coalesce(s.reviewed_at, s.submitted_at), 1
    from public.meter_readings r
    join public.meter_submissions s on s.id = r.submission_id
    join public.billing_cycle_tickets t on t.id = s.ticket_id
    where t.agreement_id = p_agreement_id and s.status = 'CONFIRMED' and r.counter_type = p_counter
    union all
    select b.value, b.recorded_at, 2
    from public.meter_baselines b
    where b.agreement_id = p_agreement_id and b.counter_type = p_counter
  ) known
  where value is not null
  order by at desc, priority desc
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Checks a draft invoice built by the billing engine against this ticket.
-- -----------------------------------------------------------------------------
create function app.verify_meter_invoice(
  t public.billing_cycle_tickets,
  p_readings jsonb,
  p_invoice jsonb,
  p_anomaly_flag text
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := p_invoice -> 'calculation';
  v_gap integer;
  v_cycles integer := (p_invoice ->> 'cycles_covered')::integer;
  v_reading jsonb;
  v_calc jsonb;
  v_line jsonb;
  v_amount bigint;
  v_subtotal bigint := 0;
  v_credit bigint := 0;
begin
  if jsonb_typeof(c) is distinct from 'object' or coalesce(c ->> 'engine', '') = '' then
    perform app.fail('RD400', 'The invoice must be calculated by the billing engine');
  end if;
  if coalesce(p_invoice ->> 'type', 'NORMAL') <> 'NORMAL' or (c ->> 'type') is distinct from 'NORMAL' then
    perform app.fail('RD400', 'A meter reading creates a normal invoice');
  end if;
  if jsonb_typeof(c -> 'partial') is distinct from 'null' then
    perform app.fail('RD400', 'A final partial cycle is billed when the machine is returned');
  end if;

  if (c -> 'terms') is distinct from jsonb_build_object(
    'commitment_cents', t.commitment_cents, 'bw_included', t.bw_included, 'bw_rate_cents', t.bw_rate_cents,
    'colour_included', t.colour_included, 'colour_rate_cents', t.colour_rate_cents
  ) then
    perform app.fail('RD409', 'The invoice was calculated with other terms than this ticket''s');
  end if;

  -- Cycles since the last confirmed reading (spec 6.4 / 11.6).
  select t.cycle_no - coalesce(max(tt.cycle_no), 0) into v_gap
  from public.meter_submissions s
  join public.billing_cycle_tickets tt on tt.id = s.ticket_id
  where tt.agreement_id = t.agreement_id and s.status = 'CONFIRMED';
  if v_cycles is null or v_cycles <> v_gap
     or (c ->> 'cycles_covered')::integer is distinct from v_gap
     or (c ->> 'full_cycles')::integer is distinct from v_gap then
    perform app.fail('RD409', format('This reading covers %s cycle(s); recalculate the invoice', v_gap));
  end if;

  if jsonb_typeof(c -> 'counters') is distinct from 'array'
     or jsonb_array_length(c -> 'counters') <> jsonb_array_length(p_readings) then
    perform app.fail('RD400', 'The calculation does not match the readings');
  end if;
  for v_reading in select * from jsonb_array_elements(p_readings) loop
    v_calc := null;
    select x into v_calc from jsonb_array_elements(c -> 'counters') x
    where x ->> 'counter_type' = v_reading ->> 'counter_type';
    if v_calc is null
       or (v_calc ->> 'previous_value')::bigint is distinct from (v_reading ->> 'previous_value')::bigint
       or (v_calc ->> 'current_value')::bigint is distinct from (v_reading ->> 'current_value')::bigint
       or coalesce((v_calc ->> 'rolled_over')::boolean, false)
          is distinct from coalesce((v_reading ->> 'rolled_over')::boolean, false) then
      perform app.fail('RD400', 'The calculation does not match the readings');
    end if;
    if app.last_known_reading(t.agreement_id, (v_reading ->> 'counter_type')::public.counter_type)
       is distinct from (v_reading ->> 'previous_value')::bigint then
      perform app.fail('RD409', 'The previous meter reading has changed; recalculate the invoice');
    end if;
  end loop;
  if p_anomaly_flag is distinct from (c ->> 'anomaly') then
    perform app.fail('RD400', 'The anomaly flag does not match the calculation');
  end if;

  for v_line in select * from jsonb_array_elements(p_invoice -> 'lines') loop
    v_amount := (v_line ->> 'amount_cents')::bigint;
    if v_amount is distinct from (v_line ->> 'quantity')::bigint * (v_line ->> 'rate_cents')::bigint then
      perform app.fail('RD400', 'Every invoice line must be quantity x rate');
    end if;
    if v_line ->> 'line_type' = 'LATE_FEE' then
      perform app.fail('RD400', 'A new invoice has no late fee');
    elsif v_line ->> 'line_type' = 'CREDIT' then
      v_credit := v_credit - v_amount;
    else
      v_subtotal := v_subtotal + v_amount;
    end if;
  end loop;
  if v_subtotal is distinct from (p_invoice ->> 'subtotal_cents')::bigint
     or v_credit is distinct from coalesce((p_invoice ->> 'credit_applied_cents')::bigint, 0)
     or v_subtotal - v_credit is distinct from (p_invoice ->> 'total_cents')::bigint then
    perform app.fail('RD400', 'Invoice lines do not add up to the subtotal, credit and total');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- submit_meter_reading (replaces 0008's): verifies and stores the calculation.
-- -----------------------------------------------------------------------------
create or replace function app.submit_meter_reading(
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
  -- INV-05: the amounts come from the billing engine (src/lib/billing); check that it
  -- used this ticket's facts and that its arithmetic is consistent.
  perform app.verify_meter_invoice(t, p_readings, p_invoice, p_anomaly_flag);

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
    period_start, period_end, cycles_covered, subtotal_cents, credit_applied_cents, total_cents, calculation
  ) values (
    t.owner_id, t.customer_id, t.agreement_id, t.machine_id, t.id,
    coalesce(p_invoice ->> 'type', 'NORMAL')::public.invoice_type, 'DRAFT',
    coalesce((p_invoice ->> 'period_start')::date, t.period_start),
    coalesce((p_invoice ->> 'period_end')::date, t.period_end),
    coalesce((p_invoice ->> 'cycles_covered')::smallint, 1),
    (p_invoice ->> 'subtotal_cents')::bigint,
    coalesce((p_invoice ->> 'credit_applied_cents')::bigint, 0),
    (p_invoice ->> 'total_cents')::bigint,
    p_invoice -> 'calculation'
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
-- confirm_meter_submission (replaces 0008's): adds p_rollover_confirmed.
-- The signature changes, so the old function and its wrapper are dropped first.
-- -----------------------------------------------------------------------------
drop function public.rpc_confirm_meter_submission(uuid, uuid, uuid, date, timestamptz, jsonb, jsonb);
drop function app.confirm_meter_submission(uuid, uuid, uuid, date, timestamptz, jsonb, jsonb);

create function app.confirm_meter_submission(
  p_ticket_id uuid,
  p_submission_id uuid,
  p_actor_id uuid,
  p_due_date date,
  p_stage_due_at timestamptz,
  p_branding_snapshot jsonb default null,
  p_notifications jsonb default '[]'::jsonb,
  p_rollover_confirmed boolean default false
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
  v_rolled boolean;
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

  -- A counter rollover is billed only after the owner explicitly confirms it
  -- (docs/decisions.md); the confirmation is stored on the reading.
  select exists (select 1 from public.meter_readings r where r.submission_id = s.id and r.rolled_over) into v_rolled;
  if v_rolled then
    if not coalesce(p_rollover_confirmed, false) then
      perform app.fail('RD409', 'ROLLOVER_UNCONFIRMED: Confirm the counter rollover before issuing the invoice');
    end if;
    update public.meter_readings
    set rollover_confirmed_by = p_actor_id, rollover_confirmed_at = now()
    where submission_id = s.id and rolled_over;
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
    jsonb_build_object('submission_id', s.id, 'invoice_id', s.invoice_id, 'invoice_no', v_invoice_no,
                       'rollover_confirmed', v_rolled));
  perform app.enter_stage(t.id, v_to, p_stage_due_at);
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'invoice_id', s.invoice_id, 'invoice_no', v_invoice_no,
                            'status', v_to, 'photo_paths', to_jsonb(v_paths));
end;
$$;

create function public.rpc_confirm_meter_submission(
  p_ticket_id uuid,
  p_submission_id uuid,
  p_actor_id uuid,
  p_due_date date,
  p_stage_due_at timestamptz,
  p_branding_snapshot jsonb default null,
  p_notifications jsonb default '[]'::jsonb,
  p_rollover_confirmed boolean default false
) returns jsonb
language sql
set search_path = ''
as $$
  select app.confirm_meter_submission(p_ticket_id, p_submission_id, p_actor_id, p_due_date,
                                      p_stage_due_at, p_branding_snapshot, p_notifications, p_rollover_confirmed);
$$;

revoke execute on function
  app.verify_meter_invoice(public.billing_cycle_tickets, jsonb, jsonb, text),
  app.confirm_meter_submission(uuid, uuid, uuid, date, timestamptz, jsonb, jsonb, boolean),
  public.rpc_confirm_meter_submission(uuid, uuid, uuid, date, timestamptz, jsonb, jsonb, boolean)
from public, anon, authenticated;

grant execute on function
  app.verify_meter_invoice(public.billing_cycle_tickets, jsonb, jsonb, text),
  app.confirm_meter_submission(uuid, uuid, uuid, date, timestamptz, jsonb, jsonb, boolean),
  public.rpc_confirm_meter_submission(uuid, uuid, uuid, date, timestamptz, jsonb, jsonb, boolean)
to service_role;
