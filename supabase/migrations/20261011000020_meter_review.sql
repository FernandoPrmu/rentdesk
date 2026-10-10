-- =============================================================================
-- 0020 Meter review (INV-01..14, CP-03, DEP-02; docs/decisions.md rules 28-32).
--
--   A. submit_meter_reading (same signature): a customer reading is refused once the
--      ticket reached the maximum number of rejections; the owner enters it (11.3).
--   B. confirm_meter_submission (same signature): also returns the photo row ids, so
--      server code deletes the files right after confirming and marks the rows.
--   C. correct_meter_reading: the owner corrects a reading waiting for review (INV-08);
--      the billing engine recalculates, the database checks it, the customer's value
--      is kept as corrected_from_value, audited, the customer notified.
--   D. cron_orphan_photos: photo files uploaded but never submitted (rule 30).
-- =============================================================================

-- =============================================================================
-- A. Meter readings (replaces 0019's)
-- =============================================================================
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
  o public.billing_cycle_tickets;
  v_existing public.meter_submissions;
  v_to constant public.ticket_status := 'PENDING_OWNER_REVIEW';
  v_submission_id uuid;
  v_invoice_id uuid;
  v_attempt smallint;
  v_reading jsonb;
  v_line jsonb;
  v_sort smallint := 0;
  v_late boolean;
  v_waiting integer;
  v_last_confirmed integer;
  v_billed jsonb := '[]'::jsonb;
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
  -- Spec 11.3 / rule 28: after the maximum number of rejections the owner enters the reading.
  if p_source = 'CUSTOMER' and t.rejection_count >= coalesce(
       (select s.max_meter_rejections from public.owner_settings_effective s where s.owner_id = t.owner_id), 3) then
    perform app.fail('RD409', 'TOO_MANY_REJECTIONS: Your rental company will enter this reading for you');
  end if;

  -- Lock the agreement's older open tickets (always newest first: no deadlock), then
  -- refuse while one of them waits for review: this reading would bill its cycle too.
  perform 1 from public.billing_cycle_tickets bt
  where bt.agreement_id = t.agreement_id and bt.cycle_no < t.cycle_no and bt.status not in ('CLOSED', 'CANCELLED')
  order by bt.cycle_no desc
  for update;
  select bt.cycle_no into v_waiting from public.billing_cycle_tickets bt
  where bt.agreement_id = t.agreement_id and bt.cycle_no < t.cycle_no and bt.status = 'PENDING_OWNER_REVIEW'
  order by bt.cycle_no
  limit 1;
  if v_waiting is not null then
    perform app.fail('RD409', format('PREVIOUS_REVIEW_PENDING: The reading for cycle %s is waiting for the owner''s review', v_waiting));
  end if;

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
  -- INV-05: the amounts come from the billing engine (src/lib/billing); check that it
  -- used this ticket's facts, the customer's credits, and that it adds up.
  perform app.verify_meter_invoice(t, p_readings, p_invoice, p_anomaly_flag);
  perform app.verify_invoice_credits(t.owner_id, t.customer_id, p_invoice, null);

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
    insert into public.invoice_lines (owner_id, invoice_id, line_type, description, quantity, rate_cents, amount_cents,
                                      sort_order, credit_id)
    values (
      t.owner_id, v_invoice_id,
      (v_line ->> 'line_type')::public.invoice_line_type,
      v_line ->> 'description',
      coalesce((v_line ->> 'quantity')::bigint, 1),
      (v_line ->> 'rate_cents')::bigint,
      (v_line ->> 'amount_cents')::bigint,
      v_sort,
      nullif(v_line ->> 'credit_id', '')::uuid
    );
    v_sort := v_sort + 1;
  end loop;

  update public.meter_submissions set invoice_id = v_invoice_id where id = v_submission_id;

  -- Rule 12 / spec 11.6: this reading bills every cycle since the last confirmed one.
  -- The older tickets of those cycles still waiting for a reading are closed here,
  -- in the same transaction, so no cycle can be billed twice.
  select coalesce(max(tt.cycle_no), 0) into v_last_confirmed
  from public.meter_submissions s
  join public.billing_cycle_tickets tt on tt.id = s.ticket_id
  where tt.agreement_id = t.agreement_id and s.status = 'CONFIRMED';
  for o in
    select * from public.billing_cycle_tickets bt
    where bt.agreement_id = t.agreement_id
      and bt.cycle_no < t.cycle_no and bt.cycle_no > v_last_confirmed
      and (bt.status = 'METER_REQUESTED' or (bt.status = 'OVERDUE' and bt.status_before_overdue = 'METER_REQUESTED'))
    order by bt.cycle_no
  loop
    if not exists (select 1 from public.invoices i where i.ticket_id = o.id and i.status not in ('REJECTED', 'CANCELLED')) then
      perform app.insert_ticket_event(o, 'STATUS_CHANGE', 'CANCELLED', null,
        format('Billed in the cycle %s invoice', t.cycle_no),
        jsonb_build_object('billed_in_ticket_id', t.id, 'billed_in_cycle_no', t.cycle_no,
                           'submission_id', v_submission_id, 'invoice_id', v_invoice_id));
      perform app.enter_stage(o.id, 'CANCELLED', null);
      update public.meter_photos ph
      set delete_requested_at = now()
      from public.meter_submissions s
      where s.id = ph.submission_id and s.ticket_id = o.id and ph.delete_requested_at is null and ph.deleted_at is null;
      v_billed := v_billed || to_jsonb(o.cycle_no);
    end if;
  end loop;

  -- Spec 11.6: a submission after the stage deadline is accepted and marked Late.
  v_late := t.status = 'OVERDUE' or (t.stage_due_at is not null and now() > t.stage_due_at);

  perform app.insert_ticket_event(
    t,
    (case p_source when 'OWNER_MANUAL' then 'MANUAL_ENTRY' else 'STATUS_CHANGE' end)::public.ticket_event_type,
    v_to, p_actor_id, p_note,
    jsonb_build_object('submission_id', v_submission_id, 'invoice_id', v_invoice_id,
                       'attempt_no', v_attempt, 'late', v_late, 'anomaly_flag', p_anomaly_flag,
                       'cycles_covered', (p_invoice ->> 'cycles_covered')::integer, 'closed_cycles', v_billed)
  );
  perform app.enter_stage(t.id, v_to, p_stage_due_at);
  update public.billing_cycle_tickets
  set current_invoice_id = v_invoice_id, is_late = is_late or v_late
  where id = t.id;

  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'submission_id', v_submission_id, 'invoice_id', v_invoice_id,
                            'status', v_to, 'is_late', v_late, 'replayed', false, 'closed_cycles', v_billed);
end;
$$;

-- =============================================================================
-- B. Owner confirms (replaces 0019's)
-- =============================================================================
create or replace function app.confirm_meter_submission(
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
  inv public.invoices;
  v_to constant public.ticket_status := 'AWAITING_PAYMENT';
  v_invoice_no text;
  v_paths text[] := '{}';
  v_photo_ids uuid[] := '{}';
  v_rolled boolean := false;
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

  if p_submission_id is null then
    select * into inv from public.invoices where id = t.current_invoice_id for update;
    if not found or inv.type <> 'ESTIMATED' or inv.status <> 'DRAFT' then
      perform app.fail('RD409', 'There is no estimated invoice waiting for review');
    end if;
  else
    select * into s from public.meter_submissions where id = p_submission_id and ticket_id = t.id for update;
    if not found then
      perform app.fail('RD404', 'Submission not found on this ticket');
    end if;
    if s.status <> 'PENDING_REVIEW' or s.invoice_id is distinct from t.current_invoice_id then
      perform app.fail('RD409', 'This submission is no longer awaiting review');
    end if;
    select * into inv from public.invoices where id = s.invoice_id for update;

    -- A counter rollover is billed only after the owner explicitly confirms it.
    select exists (select 1 from public.meter_readings r where r.submission_id = s.id and r.rolled_over) into v_rolled;
    if v_rolled then
      if not coalesce(p_rollover_confirmed, false) then
        perform app.fail('RD409', 'ROLLOVER_UNCONFIRMED: Confirm the counter rollover before issuing the invoice');
      end if;
      update public.meter_readings
      set rollover_confirmed_by = p_actor_id, rollover_confirmed_at = now()
      where submission_id = s.id and rolled_over;
    end if;
  end if;

  -- Number first (still DRAFT); if anything below fails, the number is released too.
  v_invoice_no := app.assign_invoice_number(inv.id);

  update public.invoices
  set status = 'AWAITING_PAYMENT', due_date = p_due_date, confirmed_by = p_actor_id,
      confirmed_at = now(), issued_at = now(), branding_snapshot = p_branding_snapshot
  where id = inv.id and status = 'DRAFT';
  if not found then
    perform app.fail('RD409', 'The draft invoice is no longer a draft');
  end if;

  if p_submission_id is not null then
    update public.meter_submissions
    set status = 'CONFIRMED', reviewed_by = p_actor_id, reviewed_at = now()
    where id = s.id;

    with marked as (
      update public.meter_photos
      set delete_requested_at = coalesce(delete_requested_at, now())
      where submission_id = s.id and deleted_at is null
      returning id, storage_path
    )
    select coalesce(array_agg(storage_path), '{}'), coalesce(array_agg(id), '{}') into v_paths, v_photo_ids from marked;
  end if;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, p_actor_id, null,
    jsonb_build_object('submission_id', p_submission_id, 'invoice_id', inv.id, 'invoice_no', v_invoice_no,
                       'rollover_confirmed', v_rolled, 'estimated', inv.type = 'ESTIMATED'));
  perform app.enter_stage(t.id, v_to, p_stage_due_at);
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'invoice_id', inv.id, 'invoice_no', v_invoice_no,
                            'status', v_to, 'photo_paths', to_jsonb(v_paths),
                            'photo_ids', to_jsonb(v_photo_ids));
end;
$$;

-- =============================================================================
-- C. Correct a reading (INV-08, spec 11.3, rule 29)
--   p_readings: every counter of the submission [{counter_type, previous_value,
--               current_value, rolled_over}] with the corrected values;
--   p_invoice:  the draft recalculated by the billing engine with them (same
--               credits removed by the owner).
-- =============================================================================
create function app.correct_meter_reading(
  p_ticket_id uuid,
  p_submission_id uuid,
  p_actor_id uuid,
  p_readings jsonb,
  p_invoice jsonb,
  p_anomaly_flag text,
  p_note text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  s public.meter_submissions;
  inv public.invoices;
  r public.meter_readings;
  v_new jsonb;
  v_line jsonb;
  v_sort smallint := 0;
  v_changes jsonb := '[]'::jsonb;
  v_old_excluded jsonb;
  v_new_excluded jsonb;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);
  if t.status <> 'PENDING_OWNER_REVIEW' then
    perform app.fail('RD409', format('Ticket is %s, not PENDING_OWNER_REVIEW', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[]);
  if coalesce(btrim(p_note), '') = '' then
    perform app.fail('RD400', 'A note is required to correct a reading');
  end if;

  select * into s from public.meter_submissions where id = p_submission_id and ticket_id = t.id for update;
  if not found then
    perform app.fail('RD404', 'Submission not found on this ticket');
  end if;
  if s.status <> 'PENDING_REVIEW' or s.invoice_id is distinct from t.current_invoice_id then
    perform app.fail('RD409', 'This submission is no longer awaiting review');
  end if;
  select * into inv from public.invoices where id = s.invoice_id for update;
  if inv.status <> 'DRAFT' then
    perform app.fail('RD409', 'The draft invoice is no longer a draft');
  end if;
  if jsonb_typeof(p_readings) is distinct from 'array'
     or jsonb_array_length(p_readings) <> (select count(*) from public.meter_readings where submission_id = s.id) then
    perform app.fail('RD400', 'Every counter of the reading is required');
  end if;

  -- The engine used this ticket's facts and the customer's credits; the owner's removed
  -- credits stay removed (rule 13).
  perform app.verify_meter_invoice(t, p_readings, p_invoice, p_anomaly_flag);
  perform app.verify_invoice_credits(t.owner_id, t.customer_id, p_invoice, inv.id);
  select coalesce(jsonb_agg(e order by e), '[]'::jsonb) into v_old_excluded
  from jsonb_array_elements_text(coalesce(inv.calculation -> 'credits_excluded', '[]'::jsonb)) e;
  select coalesce(jsonb_agg(e order by e), '[]'::jsonb) into v_new_excluded
  from jsonb_array_elements_text(coalesce(p_invoice -> 'calculation' -> 'credits_excluded', '[]'::jsonb)) e;
  if v_old_excluded is distinct from v_new_excluded then
    perform app.fail('RD409', 'The credits on this invoice changed; reload it');
  end if;

  for v_new in select * from jsonb_array_elements(p_readings) loop
    select * into r from public.meter_readings
    where submission_id = s.id and counter_type = (v_new ->> 'counter_type')::public.counter_type
    for update;
    if not found then
      perform app.fail('RD400', 'This counter is not part of the reading');
    end if;
    if (v_new ->> 'previous_value')::bigint is distinct from r.previous_value then
      perform app.fail('RD409', 'The previous meter reading has changed; recalculate the invoice');
    end if;
    if (v_new ->> 'current_value')::bigint is distinct from r.current_value
       or coalesce((v_new ->> 'rolled_over')::boolean, false) is distinct from r.rolled_over then
      update public.meter_readings
      set corrected_from_value = coalesce(r.corrected_from_value, r.current_value),
          current_value = (v_new ->> 'current_value')::bigint,
          rolled_over = coalesce((v_new ->> 'rolled_over')::boolean, false),
          rollover_confirmed_by = null,
          rollover_confirmed_at = null,
          correction_note = btrim(p_note),
          corrected_by = p_actor_id,
          corrected_at = now()
      where id = r.id;
      v_changes := v_changes || jsonb_build_object('counter_type', r.counter_type, 'from', r.current_value,
                                                   'to', (v_new ->> 'current_value')::bigint);
    end if;
  end loop;
  if jsonb_array_length(v_changes) = 0 then
    perform app.fail('RD400', 'The corrected reading is the same as before');
  end if;

  delete from public.invoice_lines where invoice_id = inv.id;
  for v_line in select * from jsonb_array_elements(p_invoice -> 'lines') loop
    insert into public.invoice_lines (owner_id, invoice_id, line_type, description, quantity, rate_cents, amount_cents,
                                      sort_order, credit_id)
    values (
      t.owner_id, inv.id, (v_line ->> 'line_type')::public.invoice_line_type, v_line ->> 'description',
      coalesce((v_line ->> 'quantity')::bigint, 1), (v_line ->> 'rate_cents')::bigint,
      (v_line ->> 'amount_cents')::bigint, v_sort, nullif(v_line ->> 'credit_id', '')::uuid
    );
    v_sort := v_sort + 1;
  end loop;
  update public.invoices
  set subtotal_cents = (p_invoice ->> 'subtotal_cents')::bigint,
      credit_applied_cents = coalesce((p_invoice ->> 'credit_applied_cents')::bigint, 0),
      total_cents = (p_invoice ->> 'total_cents')::bigint,
      calculation = p_invoice -> 'calculation'
  where id = inv.id;
  update public.meter_submissions set anomaly_flag = p_anomaly_flag where id = s.id;

  perform app.insert_ticket_event(t, 'CORRECTION', t.status, p_actor_id, p_note,
    jsonb_build_object('submission_id', s.id, 'invoice_id', inv.id, 'changes', v_changes,
                       'total_before_cents', inv.total_cents, 'total_after_cents', (p_invoice ->> 'total_cents')::bigint));
  perform app.write_audit(p_actor_id, 'METER_READING_CORRECTED', 'meter_submissions', s.id, t.owner_id,
    jsonb_build_object('ticket_id', t.id, 'note', btrim(p_note), 'changes', v_changes,
                       'total_before_cents', inv.total_cents, 'total_after_cents', (p_invoice ->> 'total_cents')::bigint));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'invoice_id', inv.id, 'changes', v_changes,
                            'total_cents', (p_invoice ->> 'total_cents')::bigint);
end;
$$;

-- =============================================================================
-- D. Orphan photos (rule 30): files in meter-photos older than 2 days that no
--    submission recorded (the customer uploaded but never submitted).
-- =============================================================================
create function app.cron_orphan_photos(p_now timestamptz, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(o.name order by o.created_at), '[]'::jsonb)
  from (
    select so.name, so.created_at
    from storage.objects so
    where so.bucket_id = 'meter-photos'
      and so.created_at < p_now - interval '2 days'
      and not exists (select 1 from public.meter_photos ph where ph.storage_path = so.name)
    order by so.created_at
    limit p_limit
  ) o;
$$;

-- =============================================================================
-- Grants and wrappers (service role only)
-- =============================================================================
revoke execute on function
  app.correct_meter_reading(uuid, uuid, uuid, jsonb, jsonb, text, text, jsonb),
  app.cron_orphan_photos(timestamptz, integer)
from public, anon, authenticated;
grant execute on function
  app.correct_meter_reading(uuid, uuid, uuid, jsonb, jsonb, text, text, jsonb),
  app.cron_orphan_photos(timestamptz, integer)
to service_role;

create function public.rpc_correct_meter_reading(
  p_ticket_id uuid, p_submission_id uuid, p_actor_id uuid, p_readings jsonb, p_invoice jsonb,
  p_anomaly_flag text, p_note text, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.correct_meter_reading(p_ticket_id, p_submission_id, p_actor_id, p_readings, p_invoice, p_anomaly_flag,
                                   p_note, p_notifications);
$$;

create function public.rpc_cron_orphan_photos(p_now timestamptz, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_orphan_photos(p_now, p_limit);
$$;

revoke execute on function
  public.rpc_correct_meter_reading(uuid, uuid, uuid, jsonb, jsonb, text, text, jsonb),
  public.rpc_cron_orphan_photos(timestamptz, integer)
from public, anon, authenticated;
grant execute on function
  public.rpc_correct_meter_reading(uuid, uuid, uuid, jsonb, jsonb, text, text, jsonb),
  public.rpc_cron_orphan_photos(timestamptz, integer)
to service_role;
