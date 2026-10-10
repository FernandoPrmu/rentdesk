-- =============================================================================
-- 0019 Billing cycle tickets and the daily job (TKT-01..13, PAY-10, PAY-13,
-- LATE-01; docs/decisions.md rules 20-25).
--
--   A. Stage clock: billing_cycle_tickets.stage_entered_at (reminders count from it).
--   B. cron_runs: one row per run of the daily job (admin log).
--   C. open_billing_cycle takes the job's "now" and flags an earlier ticket that
--      still waits for its reading as Overdue (spec 11.6).
--   D. submit_meter_reading: a reading covering several cycles closes the older
--      meter-stage tickets it bills ("Billed in the cycle N invoice"), and is
--      refused while an older reading waits for the owner's review.
--   E. Estimated invoices (spec 11.6): created by the daily job as a DRAFT; the
--      owner confirms or rejects it like a reading (never automatic, 11.1).
--   F. transition_ticket: cancel cleans up a pending reading and resolves an open
--      dispute; clearing an overdue payment needs a new due date.
--   G. Disputes: raise_dispute / resolve_dispute (spec 11.4).
--   H. Daily job steps: overdue, reminders, escalation, late fee, pause/resume,
--      photo purge, weekly overdue summary. Every write is a compare-and-set under
--      the ticket lock, so running the job twice (or two runs at once) changes
--      nothing the second time.
--
-- Times: the daily job passes its own "now" (a simulated one outside production,
-- see src/lib/cron/time.ts); calendar dates are taken in Asia/Colombo.
-- =============================================================================

-- =============================================================================
-- A. Stage clock
-- =============================================================================
alter table public.billing_cycle_tickets add column stage_entered_at timestamptz;
update public.billing_cycle_tickets t
set stage_entered_at = coalesce(
  (select max(e.created_at) from public.ticket_events e where e.ticket_id = t.id and e.to_status = t.status),
  t.created_at
);
alter table public.billing_cycle_tickets
  alter column stage_entered_at set default now(),
  alter column stage_entered_at set not null;
comment on column public.billing_cycle_tickets.stage_entered_at is
  'When the ticket entered its current status; stage reminders and escalation count from it.';

-- The daily sweep pages through open tickets by id.
create index billing_cycle_tickets_open_idx on public.billing_cycle_tickets (id)
  where status not in ('CLOSED', 'CANCELLED');
-- Escalations list (admin).
create index billing_cycle_tickets_escalated_idx on public.billing_cycle_tickets (escalation_level)
  where escalation_level > 0 and status not in ('CLOSED', 'CANCELLED');

-- Move a (locked) ticket into a new stage at a given time and reset the stage clock.
create function app.enter_stage_at(p_ticket_id uuid, p_to public.ticket_status, p_stage_due_at timestamptz, p_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.billing_cycle_tickets
  set status = p_to,
      status_before_overdue = case when p_to = 'OVERDUE' then status end,
      stage_due_at = p_stage_due_at,
      stage_entered_at = p_at,
      escalation_level = 0,
      reminder_count = 0,
      last_reminder_at = null
  where id = p_ticket_id;
$$;

create or replace function app.enter_stage(p_ticket_id uuid, p_to public.ticket_status, p_stage_due_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  select app.enter_stage_at(p_ticket_id, p_to, p_stage_due_at, now());
$$;

-- Calendar date in Sri Lanka.
create function app.colombo_date(p_at timestamptz) returns date
language sql
immutable
set search_path = ''
as $$
  select (p_at at time zone 'Asia/Colombo')::date;
$$;

-- Customer and owner of a ticket are both active (spec 11.8: otherwise it is paused).
create function app.ticket_accounts_active(p_customer_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles c join public.profiles o on o.id = c.owner_id
    where c.id = p_customer_id and c.status = 'ACTIVE' and o.status = 'ACTIVE'
  );
$$;

-- =============================================================================
-- B. cron_runs (admin log of the daily job)
-- =============================================================================
create table public.cron_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null default 'daily' check (job ~ '^[a-z_]+$'),
  trigger text not null check (trigger in ('CRON', 'ADMIN', 'LOCAL')),
  triggered_by uuid references public.profiles (id),
  -- The "now" the run used; simulated only outside production.
  run_now timestamptz not null,
  simulated boolean not null default false,
  run_date date not null,
  status text not null default 'RUNNING' check (status in ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED')),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  -- Work left for the next run (time budget reached).
  remaining boolean not null default false
);
comment on table public.cron_runs is 'One row per run of the daily job. SERVER-WRITE-ONLY; admins read.';
create index cron_runs_started_idx on public.cron_runs (job, started_at desc);
create index cron_runs_triggered_by_idx on public.cron_runs (triggered_by);

-- New tables get no automatic grants in this project.
revoke all on public.cron_runs from anon, authenticated, service_role;
grant select on public.cron_runs to authenticated, service_role;
alter table public.cron_runs enable row level security;
create policy cron_runs_select on public.cron_runs for select to authenticated using ((select app.is_admin()));

-- Starts a run. A run still RUNNING and younger than 10 minutes holds the lease:
-- a second run started meanwhile is recorded as SKIPPED and does nothing.
create function app.cron_begin_run(
  p_job text,
  p_trigger text,
  p_triggered_by uuid,
  p_now timestamptz,
  p_simulated boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_busy uuid;
begin
  perform pg_advisory_xact_lock(hashtext('rentdesk.cron.' || p_job));
  -- A run that never finished (function killed at its time limit) gives up the lease.
  update public.cron_runs
  set status = 'FAILED', finished_at = clock_timestamp(),
      errors = errors || jsonb_build_array(jsonb_build_object('step', 'run', 'message', 'Stopped before it finished'))
  where job = p_job and status = 'RUNNING' and started_at < clock_timestamp() - interval '10 minutes';

  select id into v_busy from public.cron_runs where job = p_job and status = 'RUNNING' limit 1;
  insert into public.cron_runs (job, trigger, triggered_by, run_now, simulated, run_date, status, finished_at)
  values (p_job, p_trigger, p_triggered_by, p_now, coalesce(p_simulated, false), app.colombo_date(p_now),
          case when v_busy is null then 'RUNNING' else 'SKIPPED' end,
          case when v_busy is null then null else clock_timestamp() end)
  returning id into v_id;
  return jsonb_build_object('run_id', v_id, 'skipped', v_busy is not null, 'busy_run_id', v_busy);
end;
$$;

create function app.cron_finish_run(
  p_run_id uuid,
  p_status text,
  p_counts jsonb,
  p_errors jsonb,
  p_remaining boolean
) returns void
language sql
security definer
set search_path = ''
as $$
  update public.cron_runs
  set status = p_status, finished_at = clock_timestamp(), counts = coalesce(p_counts, '{}'::jsonb),
      errors = coalesce(p_errors, '[]'::jsonb), remaining = coalesce(p_remaining, false)
  where id = p_run_id and status = 'RUNNING';
$$;

-- What every run needs once: admins (escalations) and the platform late fee.
create function app.cron_context() returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'admin_ids', coalesce((select jsonb_agg(p.id order by p.created_at) from public.profiles p
                           where p.role = 'ADMIN' and p.status = 'ACTIVE'), '[]'::jsonb),
    'platform_late_fee', (select jsonb_build_object('enabled', s.late_fee_enabled, 'fee_cents', s.late_fee_cents,
                                                    'grace_days', s.grace_period_days)
                          from public.platform_settings s)
  );
$$;

-- =============================================================================
-- C. Opening a cycle (replaces 0017's: the job's "now"; spec 11.6 overdue flag)
-- =============================================================================
drop function public.rpc_open_billing_cycle(uuid, integer, timestamptz, jsonb);
drop function app.open_billing_cycle(uuid, integer, timestamptz, jsonb);

create function app.open_billing_cycle(
  p_agreement_id uuid,
  p_cycle_no integer,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb,
  p_now timestamptz default now(),
  p_overdue_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.rental_agreements;
  h public.agreement_terms_history;
  t public.billing_cycle_tickets;
  v_ticket_id uuid;
  v_machine_type public.machine_type;
  v_cycle_date date;
  v_period_start date;
  v_flagged jsonb := '[]'::jsonb;
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
  if not app.ticket_accounts_active(a.customer_id) then
    return jsonb_build_object('skipped', 'ACCOUNT_NOT_ACTIVE', 'cycle_no', p_cycle_no);
  end if;

  -- Which cycles are due is decided by app.cron_due_agreements (next_cycle_date <= today).
  v_cycle_date := app.cycle_date(a.first_billing_date, p_cycle_no);
  v_period_start := app.cycle_date(a.first_billing_date, p_cycle_no - 1);
  if p_cycle_no = 1 then
    v_period_start := greatest(v_period_start, a.start_date);
  end if;
  select m.type into v_machine_type from public.machines m where m.id = a.machine_id;

  -- Terms in force for this cycle (AGR-02): latest version effective by now.
  select * into h from public.agreement_terms_history th
  where th.agreement_id = a.id and th.effective_from_cycle_no <= p_cycle_no
  order by th.effective_from_cycle_no desc, th.version desc
  limit 1;
  if found and (h.monthly_commitment_cents, h.bw_included, h.bw_rate_cents, h.colour_included,
                h.colour_rate_cents, h.due_days, h.late_fee_mode, h.late_fee_cents)
     is distinct from (a.monthly_commitment_cents, a.bw_included, a.bw_rate_cents, a.colour_included,
                       a.colour_rate_cents, a.due_days, a.late_fee_mode, a.late_fee_cents) then
    update public.rental_agreements
    set monthly_commitment_cents = h.monthly_commitment_cents, bw_included = h.bw_included,
        bw_rate_cents = h.bw_rate_cents, colour_included = h.colour_included,
        colour_rate_cents = h.colour_rate_cents, due_days = h.due_days,
        late_fee_mode = h.late_fee_mode, late_fee_cents = h.late_fee_cents
    where id = a.id
    returning * into a;
  end if;

  insert into public.billing_cycle_tickets (
    owner_id, customer_id, agreement_id, machine_id, cycle_no, cycle_date, period_start, period_end,
    status, stage_due_at, stage_entered_at, machine_type, cycle_length_days, commitment_cents,
    bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days, late_fee_mode, late_fee_cents
  ) values (
    a.owner_id, a.customer_id, a.id, a.machine_id, p_cycle_no, v_cycle_date, v_period_start, v_cycle_date - 1,
    'METER_REQUESTED', p_stage_due_at, p_now, v_machine_type, app.cycle_days(a.first_billing_date, p_cycle_no),
    a.monthly_commitment_cents, a.bw_included, a.bw_rate_cents, a.colour_included, a.colour_rate_cents, a.due_days,
    a.late_fee_mode, a.late_fee_cents
  )
  returning id into v_ticket_id;

  insert into public.ticket_events (owner_id, ticket_id, event_type, to_status, actor_id, metadata)
  values (a.owner_id, v_ticket_id, 'CREATED', 'METER_REQUESTED', null,
          jsonb_build_object('cycle_no', p_cycle_no, 'cycle_date', v_cycle_date));

  -- TKT-07: the next cycle follows the calendar, not the close date.
  update public.rental_agreements
  set next_cycle_no = p_cycle_no + 1,
      next_cycle_date = app.cycle_date(a.first_billing_date, p_cycle_no + 1)
  where id = a.id;

  perform app.enqueue_notifications(a.owner_id, p_notifications, 'billing_cycle_ticket', v_ticket_id);

  -- Spec 11.6: an earlier ticket still waiting for its reading is flagged Overdue
  -- (owner alerted). Its cycle is billed by the next reading (rule 12, section D).
  for t in
    select * from public.billing_cycle_tickets bt
    where bt.agreement_id = a.id and bt.cycle_no < p_cycle_no and bt.status = 'METER_REQUESTED'
    order by bt.cycle_no
    for update
  loop
    perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'OVERDUE', null,
      format('The cycle %s ticket opened before this reading arrived', p_cycle_no),
      jsonb_build_object('next_cycle_no', p_cycle_no));
    perform app.enter_stage_at(t.id, 'OVERDUE', null, p_now);
    update public.billing_cycle_tickets set escalation_level = 1 where id = t.id;
    perform app.enqueue_notifications(a.owner_id, p_overdue_notifications, 'billing_cycle_ticket', t.id);
    v_flagged := v_flagged || to_jsonb(t.cycle_no);
  end loop;

  return jsonb_build_object('ticket_id', v_ticket_id, 'cycle_no', p_cycle_no, 'cycle_date', v_cycle_date,
                            'replayed', false, 'flagged_overdue', v_flagged);
end;
$$;

-- =============================================================================
-- D. Meter readings (replaces 0017's; same signature)
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
-- E. Estimated invoices (spec 11.6; rule 22)
-- =============================================================================

-- The engine built a commitment-only invoice for one cycle with the ticket's terms.
create function app.verify_estimated_invoice(t public.billing_cycle_tickets, p_invoice jsonb) returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  c jsonb := p_invoice -> 'calculation';
begin
  if jsonb_typeof(c) is distinct from 'object' or coalesce(c ->> 'engine', '') = '' then
    perform app.fail('RD400', 'The invoice must be calculated by the billing engine');
  end if;
  if (p_invoice ->> 'type') is distinct from 'ESTIMATED' or (c ->> 'type') is distinct from 'ESTIMATED' then
    perform app.fail('RD400', 'An estimate creates an estimated invoice');
  end if;
  if (p_invoice ->> 'cycles_covered')::integer is distinct from 1
     or (c ->> 'cycles_covered')::integer is distinct from 1
     or (c ->> 'full_cycles')::integer is distinct from 1
     or jsonb_typeof(c -> 'partial') is distinct from 'null' then
    perform app.fail('RD400', 'An estimated invoice covers exactly one cycle');
  end if;
  if coalesce(jsonb_array_length(c -> 'counters'), -1) <> 0
     or coalesce(jsonb_array_length(c -> 'estimate_credits'), -1) <> 0 then
    perform app.fail('RD400', 'An estimated invoice has no readings');
  end if;
  if (c -> 'terms') is distinct from jsonb_build_object(
    'commitment_cents', t.commitment_cents, 'bw_included', t.bw_included, 'bw_rate_cents', t.bw_rate_cents,
    'colour_included', t.colour_included, 'colour_rate_cents', t.colour_rate_cents
  ) then
    perform app.fail('RD409', 'The invoice was calculated with other terms than this ticket''s');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_invoice -> 'lines') l
    where l ->> 'line_type' not in ('COMMITMENT', 'CREDIT')
  ) then
    perform app.fail('RD400', 'An estimated invoice charges the commitment only');
  end if;
  perform app.verify_invoice_lines(p_invoice);
end;
$$;

-- Daily job: the customer missed the meter deadline and the owner bills estimates.
-- DRAFT invoice -> ticket PENDING_OWNER_REVIEW. At most one estimate per ticket.
create function app.create_estimated_invoice(
  p_ticket_id uuid,
  p_invoice jsonb,
  p_stage_due_at timestamptz,
  p_now timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  v_to constant public.ticket_status := 'PENDING_OWNER_REVIEW';
  v_invoice_id uuid;
  v_line jsonb;
  v_sort smallint := 0;
  v_enabled boolean;
begin
  perform app.set_actor(null);
  t := app.lock_ticket(p_ticket_id);

  if not (t.status = 'METER_REQUESTED' or (t.status = 'OVERDUE' and t.status_before_overdue = 'METER_REQUESTED')) then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'STATUS', 'status', t.status);
  end if;
  if t.paused_at is not null then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'PAUSED');
  end if;
  if exists (select 1 from public.invoices i where i.ticket_id = t.id and i.type = 'ESTIMATED') then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'ALREADY_ESTIMATED');
  end if;
  if t.status = 'METER_REQUESTED' and (t.stage_due_at is null or t.stage_due_at > p_now) then
    perform app.fail('RD409', 'The meter deadline has not passed yet');
  end if;
  select s.estimated_billing_enabled into v_enabled from public.owner_settings_effective s where s.owner_id = t.owner_id;
  if not coalesce(v_enabled, false) then
    perform app.fail('RD409', 'Estimated billing is off for this owner');
  end if;

  perform app.verify_estimated_invoice(t, p_invoice);
  perform app.verify_invoice_credits(t.owner_id, t.customer_id, p_invoice, null);

  insert into public.invoices (
    owner_id, customer_id, agreement_id, machine_id, ticket_id, type, status,
    period_start, period_end, cycles_covered, subtotal_cents, credit_applied_cents, total_cents, calculation
  ) values (
    t.owner_id, t.customer_id, t.agreement_id, t.machine_id, t.id, 'ESTIMATED', 'DRAFT',
    t.period_start, t.period_end, 1,
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
      t.owner_id, v_invoice_id, (v_line ->> 'line_type')::public.invoice_line_type, v_line ->> 'description',
      coalesce((v_line ->> 'quantity')::bigint, 1), (v_line ->> 'rate_cents')::bigint,
      (v_line ->> 'amount_cents')::bigint, v_sort, nullif(v_line ->> 'credit_id', '')::uuid
    );
    v_sort := v_sort + 1;
  end loop;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, null,
    'Estimated invoice: no meter reading by the deadline',
    jsonb_build_object('invoice_id', v_invoice_id, 'estimated', true, 'total_cents', (p_invoice ->> 'total_cents')::bigint));
  perform app.enter_stage_at(t.id, v_to, p_stage_due_at, p_now);
  update public.billing_cycle_tickets set current_invoice_id = v_invoice_id, is_late = true where id = t.id;
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'invoice_id', v_invoice_id, 'status', v_to);
end;
$$;

-- Owner confirms (replaces 0015's; same signature). p_submission_id null = the
-- ticket's estimated draft invoice (no reading, no photo).
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
      returning storage_path
    )
    select coalesce(array_agg(storage_path), '{}') into v_paths from marked;
  end if;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, p_actor_id, null,
    jsonb_build_object('submission_id', p_submission_id, 'invoice_id', inv.id, 'invoice_no', v_invoice_no,
                       'rollover_confirmed', v_rolled, 'estimated', inv.type = 'ESTIMATED'));
  perform app.enter_stage(t.id, v_to, p_stage_due_at);
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);

  return jsonb_build_object('ticket_id', t.id, 'invoice_id', inv.id, 'invoice_no', v_invoice_no,
                            'status', v_to, 'photo_paths', to_jsonb(v_paths));
end;
$$;

-- Owner rejects (replaces 0008's; same signature). p_submission_id null = the
-- estimated draft: the ticket goes back to waiting for a reading.
create or replace function app.reject_meter_submission(
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
  inv public.invoices;
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

  if p_submission_id is null then
    select * into inv from public.invoices where id = t.current_invoice_id for update;
    if not found or inv.type <> 'ESTIMATED' or inv.status <> 'DRAFT' then
      perform app.fail('RD409', 'There is no estimated invoice waiting for review');
    end if;
    update public.invoices set status = 'REJECTED' where id = inv.id;
    perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, p_actor_id, p_reason,
      jsonb_build_object('invoice_id', inv.id, 'estimated', true));
    perform app.enter_stage(t.id, v_to, p_stage_due_at);
    update public.billing_cycle_tickets set current_invoice_id = null where id = t.id;
    perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
    return jsonb_build_object('ticket_id', t.id, 'status', v_to, 'rejection_count', t.rejection_count);
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

-- =============================================================================
-- F. Generic owner/system transitions (replaces 0008's; adds p_due_date)
-- =============================================================================
drop function public.rpc_transition_ticket(uuid, public.ticket_status, public.ticket_status, uuid, text, timestamptz,
                                           public.invoice_status, public.ticket_event_type, jsonb, jsonb);
drop function app.transition_ticket(uuid, public.ticket_status, public.ticket_status, uuid, text, timestamptz,
                                    public.invoice_status, public.ticket_event_type, jsonb, jsonb);

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
  p_notifications jsonb default '[]'::jsonb,
  p_due_date date default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
  v_invoice_status public.invoice_status;
  v_old_due date;
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
     or (p_from = 'PENDING_OWNER_REVIEW' and p_to <> 'CANCELLED')
     or (p_from = 'DISPUTED' and p_to <> 'CANCELLED') then
    perform app.fail('RD400', format('Transition %s -> %s needs its dedicated workflow function', p_from, p_to));
  end if;
  -- TKT-10 / spec 11: cancelling, reopening and clearing an overdue need a reason.
  if (p_to in ('CANCELLED', 'REOPENED') or p_from = 'OVERDUE') and coalesce(btrim(p_reason), '') = '' then
    perform app.fail('RD400', 'A reason is required');
  end if;
  -- Clearing an overdue payment (owner override, spec 11.1) gives the customer a new due date.
  if p_from = 'OVERDUE' and p_to in ('AWAITING_PAYMENT', 'PARTIALLY_PAID') and p_due_date is null then
    perform app.fail('RD400', 'A new due date is required');
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[], true);

  perform app.insert_ticket_event(t, p_event_type, p_to, p_actor_id, p_reason, p_metadata);
  perform app.enter_stage(t.id, p_to, p_stage_due_at);
  if p_to = 'REOPENED' then
    update public.billing_cycle_tickets set closed_at = null, closed_by = null where id = t.id;
  end if;

  if p_to = 'CANCELLED' then
    -- A reading still waiting for review is superseded; its photo is purged.
    update public.meter_submissions set status = 'SUPERSEDED'
    where ticket_id = t.id and status = 'PENDING_REVIEW';
    update public.meter_photos ph
    set delete_requested_at = coalesce(ph.delete_requested_at, now())
    from public.meter_submissions s
    where s.id = ph.submission_id and s.ticket_id = t.id and ph.deleted_at is null;
    -- An open dispute ends with the cancellation (spec 11.4: cancel and reissue).
    update public.disputes
    set status = 'RESOLVED', resolution = btrim(p_reason), resolved_by = p_actor_id, resolved_at = now()
    where ticket_id = t.id and status = 'OPEN';
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

    if p_due_date is not null and p_from = 'OVERDUE' then
      v_old_due := inv.due_date;
      update public.invoices set due_date = p_due_date where id = inv.id;
      update public.ticket_events
      set metadata = metadata || jsonb_build_object('due_date_from', v_old_due, 'due_date_to', p_due_date)
      where id = (select e.id from public.ticket_events e where e.ticket_id = t.id order by e.created_at desc limit 1);
    end if;
  end if;

  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'from', p_from, 'status', p_to);
end;
$$;

-- =============================================================================
-- G. Disputes (spec 11.4, CP-06)
-- =============================================================================
create function app.raise_dispute(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
  v_dispute_id uuid;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);

  if not (t.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID')
          or (t.status = 'OVERDUE' and t.status_before_overdue in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED'))) then
    perform app.fail('RD409', format('Ticket is %s; this invoice cannot be disputed now', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['CUSTOMER']::public.user_role[]);
  if coalesce(btrim(p_reason), '') = '' then
    perform app.fail('RD400', 'A reason is required to dispute an invoice');
  end if;
  select * into inv from public.invoices where id = t.current_invoice_id for update;
  if not found or inv.status not in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE') then
    perform app.fail('RD409', 'There is no issued invoice to dispute');
  end if;

  insert into public.disputes (owner_id, invoice_id, ticket_id, customer_id, raised_by, reason)
  values (t.owner_id, inv.id, t.id, t.customer_id, p_actor_id, btrim(p_reason))
  returning id into v_dispute_id;
  update public.invoices set status = 'DISPUTED' where id = inv.id;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'DISPUTED', p_actor_id, p_reason,
    jsonb_build_object('dispute_id', v_dispute_id, 'invoice_id', inv.id));
  perform app.enter_stage(t.id, 'DISPUTED', null);
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'dispute_id', v_dispute_id, 'status', 'DISPUTED');
end;
$$;

-- The owner answers a dispute without cancelling the invoice: rejected (with an
-- explanation) or resolved (e.g. a credit was given). The invoice is payable again.
create function app.resolve_dispute(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_outcome public.dispute_status,
  p_resolution text,
  p_stage_due_at timestamptz default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);

  if t.status <> 'DISPUTED' then
    perform app.fail('RD409', format('Ticket is %s, not DISPUTED', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[]);
  if p_outcome not in ('RESOLVED', 'REJECTED') then
    perform app.fail('RD400', 'The outcome is resolved or rejected');
  end if;
  if coalesce(btrim(p_resolution), '') = '' then
    perform app.fail('RD400', 'An explanation is required');
  end if;

  update public.disputes
  set status = p_outcome, resolution = btrim(p_resolution), resolved_by = p_actor_id, resolved_at = now()
  where ticket_id = t.id and status = 'OPEN';
  select * into inv from public.invoices where id = t.current_invoice_id for update;
  update public.invoices
  set status = case when inv.amount_paid_cents > 0 then 'PARTIALLY_PAID' else 'AWAITING_PAYMENT' end::public.invoice_status
  where id = inv.id;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'AWAITING_PAYMENT', p_actor_id, p_resolution,
    jsonb_build_object('dispute_outcome', p_outcome, 'invoice_id', inv.id));
  perform app.enter_stage(t.id, 'AWAITING_PAYMENT', p_stage_due_at);
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'status', 'AWAITING_PAYMENT', 'outcome', p_outcome);
end;
$$;

-- =============================================================================
-- H. Daily job steps
-- =============================================================================

-- a. Agreements with a cycle due by p_today (monthly calendar, rule 1). Accounts must
--    be active: a suspended one is caught up after reactivation.
create function app.cron_due_agreements(p_today date, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.next_cycle_date, x.agreement_id), '[]'::jsonb)
  from (
    select a.id as agreement_id, a.owner_id, a.customer_id, a.next_cycle_no, a.next_cycle_date,
           m.brand || ' ' || m.model as machine_name, m.serial_no, s.meter_deadline_days
    from public.rental_agreements a
    join public.machines m on m.id = a.machine_id
    join public.owner_settings_effective s on s.owner_id = a.owner_id
    where a.status = 'ACTIVE'
      and a.next_cycle_date <= p_today
      and app.ticket_accounts_active(a.customer_id)
    order by a.next_cycle_date, a.id
    limit p_limit
  ) x;
$$;

-- b-f. Open tickets after p_after (keyset), with what the decision logic needs.
create function app.cron_ticket_candidates(p_after uuid, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb)
  from (
    select t.id, t.owner_id, t.customer_id, t.agreement_id, t.cycle_no, t.cycle_date, t.status,
           t.status_before_overdue, t.stage_due_at, t.stage_entered_at, t.escalation_level, t.reminder_count,
           t.paused_at, t.machine_type, t.commitment_cents, t.bw_included, t.bw_rate_cents, t.colour_included,
           t.colour_rate_cents, t.late_fee_mode, t.late_fee_cents,
           m.brand || ' ' || m.model as machine_name, m.serial_no, cu.name as customer_name,
           app.ticket_accounts_active(t.customer_id) as accounts_active,
           exists (select 1 from public.invoices e where e.ticket_id = t.id and e.type = 'ESTIMATED') as has_estimate,
           (select to_jsonb(i) from (
              select inv.id, inv.invoice_no, inv.type, inv.status, inv.due_date, inv.subtotal_cents, inv.late_fee_cents,
                     inv.credit_applied_cents, inv.total_cents, inv.amount_paid_cents
              from public.invoices inv where inv.id = t.current_invoice_id) i) as invoice,
           to_jsonb(s) - 'owner_id' as settings,
           jsonb_build_object('enabled', os.late_fee_enabled, 'fee_cents', os.late_fee_cents,
                              'grace_days', os.grace_period_days) as owner_late_fee,
           -- Rule 13: only needed when an estimate may be built now.
           case when s.estimated_billing_enabled and t.paused_at is null
                     and (t.status = 'METER_REQUESTED' or (t.status = 'OVERDUE' and t.status_before_overdue = 'METER_REQUESTED'))
                then (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'available_cents', (cr.x ->> 'available_cents')::bigint,
                                                                   'kind', k.kind) order by cr.ord), '[]'::jsonb)
                      from jsonb_array_elements(app.available_credits(t.customer_id, null)) with ordinality as cr(x, ord)
                      join public.credits k on k.id = (cr.x ->> 'id')::uuid)
           end as credits
    from public.billing_cycle_tickets t
    join public.machines m on m.id = t.machine_id
    join public.customers cu on cu.id = t.customer_id
    join public.owner_settings_effective s on s.owner_id = t.owner_id
    left join public.owner_settings os on os.owner_id = t.owner_id
    where t.status not in ('CLOSED', 'CANCELLED')
      and (p_after is null or t.id > p_after)
    order by t.id
    limit p_limit
  ) x;
$$;

-- A customer-stage deadline passed: ticket (and invoice) -> OVERDUE, owner alerted
-- (escalation level 1, rule 21). Compare-and-set: a second run is a no-op.
create function app.mark_ticket_overdue(
  p_ticket_id uuid,
  p_from public.ticket_status,
  p_now timestamptz,
  p_reason text,
  p_reminder_no smallint,
  p_escalation_level smallint,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
begin
  perform app.set_actor(null);
  t := app.lock_ticket(p_ticket_id);

  if t.status <> p_from or t.paused_at is not null then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'STATE', 'status', t.status);
  end if;
  if p_from not in ('METER_REQUESTED', 'AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED') then
    perform app.fail('RD400', format('A %s ticket does not become overdue', p_from));
  end if;
  if p_from = 'METER_REQUESTED' then
    if t.stage_due_at is null or t.stage_due_at > p_now then
      perform app.fail('RD409', 'The meter deadline has not passed yet');
    end if;
  else
    select * into inv from public.invoices where id = t.current_invoice_id for update;
    if inv.id is null or inv.due_date is null or inv.due_date >= app.colombo_date(p_now) then
      perform app.fail('RD409', 'The invoice is not past its due date');
    end if;
    if inv.amount_paid_cents >= inv.total_cents then
      perform app.fail('RD409', 'Nothing is left to pay on this invoice');
    end if;
  end if;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'OVERDUE', null, p_reason,
    jsonb_build_object('due_date', inv.due_date, 'stage_due_at', t.stage_due_at));
  perform app.enter_stage_at(t.id, 'OVERDUE', null, p_now);
  update public.billing_cycle_tickets
  set reminder_count = greatest(coalesce(p_reminder_no, 0), 0),
      last_reminder_at = case when coalesce(p_reminder_no, 0) > 0 then p_now end,
      escalation_level = greatest(coalesce(p_escalation_level, 0), 0)
  where id = t.id;
  if inv.id is not null and inv.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID') then
    update public.invoices set status = 'OVERDUE' where id = inv.id;
  end if;
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'status', 'OVERDUE');
end;
$$;

-- Stage reminder number p_reminder_no (1-based, in the stage's schedule).
create function app.record_ticket_reminder(
  p_ticket_id uuid,
  p_status public.ticket_status,
  p_reminder_no smallint,
  p_now timestamptz,
  p_metadata jsonb default '{}'::jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
begin
  perform app.set_actor(null);
  t := app.lock_ticket(p_ticket_id);
  if t.status <> p_status or t.paused_at is not null or t.reminder_count >= p_reminder_no then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'STATE');
  end if;
  perform app.insert_ticket_event(t, 'REMINDER', t.status, null, null,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('reminder_no', p_reminder_no));
  update public.billing_cycle_tickets
  set reminder_count = p_reminder_no, last_reminder_at = p_now
  where id = t.id;
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'reminder_no', p_reminder_no);
end;
$$;

-- Escalation to level p_level (1 = owner alerted, 2 = admin alerted).
create function app.escalate_ticket(
  p_ticket_id uuid,
  p_status public.ticket_status,
  p_level smallint,
  p_now timestamptz,
  p_reason text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
begin
  perform app.set_actor(null);
  t := app.lock_ticket(p_ticket_id);
  if t.status <> p_status or t.paused_at is not null or t.escalation_level >= p_level then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'STATE');
  end if;
  perform app.insert_ticket_event(t, 'ESCALATION', t.status, null, p_reason,
    jsonb_build_object('level', p_level, 'stage_entered_at', t.stage_entered_at, 'at', p_now));
  update public.billing_cycle_tickets set escalation_level = p_level where id = t.id;
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'level', p_level);
end;
$$;

-- PAY-13 / LATE-01: the late fee line built by the engine (addLateFee), charged once.
-- The database re-checks the amount against the settings (agreement snapshot on the
-- ticket, then owner, then platform; rule 7) and the grace period; it never charges
-- while a slip waits for verification or the invoice is disputed.
create function app.apply_late_fee(
  p_ticket_id uuid,
  p_invoice_id uuid,
  p_line jsonb,
  p_total_cents bigint,
  p_now timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
  os public.owner_settings;
  ps public.platform_settings;
  v_fee bigint;
  v_grace integer;
  v_amount bigint := (p_line ->> 'amount_cents')::bigint;
begin
  perform app.set_actor(null);
  t := app.lock_ticket(p_ticket_id);
  select * into inv from public.invoices where id = p_invoice_id and ticket_id = t.id for update;
  if not found then
    perform app.fail('RD404', 'Invoice not found on this ticket');
  end if;
  if inv.id is distinct from t.current_invoice_id or inv.late_fee_cents > 0 or t.paused_at is not null
     or t.status in ('PAYMENT_SUBMITTED', 'DISPUTED')
     or inv.status not in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE')
     or inv.amount_paid_cents >= inv.total_cents then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'STATE');
  end if;

  select * into os from public.owner_settings where owner_id = t.owner_id;
  select * into ps from public.platform_settings;
  v_grace := coalesce(os.grace_period_days, ps.grace_period_days);
  v_fee := case t.late_fee_mode
    when 'NONE' then null
    when 'CUSTOM' then t.late_fee_cents
    else case when coalesce(os.late_fee_enabled, ps.late_fee_enabled) then coalesce(os.late_fee_cents, ps.late_fee_cents) end
  end;
  if v_fee is null or v_fee <= 0 then
    perform app.fail('RD409', 'No late fee applies to this invoice');
  end if;
  if inv.due_date is null or app.colombo_date(p_now) <= inv.due_date + v_grace then
    perform app.fail('RD409', 'The grace period is not over');
  end if;
  if p_line ->> 'line_type' is distinct from 'LATE_FEE' or (p_line ->> 'quantity')::bigint is distinct from 1
     or (p_line ->> 'rate_cents')::bigint is distinct from v_fee or v_amount is distinct from v_fee
     or coalesce(btrim(p_line ->> 'description'), '') = '' then
    perform app.fail('RD409', 'The late fee does not match the settings');
  end if;
  if p_total_cents is distinct from inv.subtotal_cents + v_fee - inv.credit_applied_cents then
    perform app.fail('RD400', 'The new total does not add up');
  end if;

  insert into public.invoice_lines (owner_id, invoice_id, line_type, description, quantity, rate_cents, amount_cents, sort_order)
  values (t.owner_id, inv.id, 'LATE_FEE', btrim(p_line ->> 'description'), 1, v_fee, v_fee,
          coalesce((select max(l.sort_order) + 1 from public.invoice_lines l where l.invoice_id = inv.id), 0));
  update public.invoices set late_fee_cents = v_fee, total_cents = p_total_cents where id = inv.id;

  perform app.insert_ticket_event(t, 'LATE_FEE', t.status, null, null,
    jsonb_build_object('invoice_id', inv.id, 'invoice_no', inv.invoice_no, 'late_fee_cents', v_fee,
                       'total_cents', p_total_cents, 'due_date', inv.due_date, 'grace_days', v_grace));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'invoice_id', inv.id, 'late_fee_cents', v_fee, 'total_cents', p_total_cents);
end;
$$;

-- h. Tickets to pause (customer or owner not active) or resume (both active again).
create function app.cron_pause_candidates(p_owner_id uuid, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb)
  from (
    select t.id, t.owner_id, t.customer_id, t.cycle_no, t.status, t.paused_at,
           case when t.paused_at is null then 'PAUSE' else 'RESUME' end as action,
           c.status as customer_status, o.status as owner_status,
           m.brand || ' ' || m.model as machine_name
    from public.billing_cycle_tickets t
    join public.profiles c on c.id = t.customer_id
    join public.profiles o on o.id = t.owner_id
    join public.machines m on m.id = t.machine_id
    where t.status not in ('CLOSED', 'CANCELLED')
      and (p_owner_id is null or t.owner_id = p_owner_id)
      and ((t.paused_at is null and (c.status <> 'ACTIVE' or o.status <> 'ACTIVE'))
           or (t.paused_at is not null and c.status = 'ACTIVE' and o.status = 'ACTIVE'))
    order by t.id
    limit p_limit
  ) x;
$$;

-- TKT-12 / spec 11.8 (rule 24): freeze or resume a ticket. On resume the stage clock
-- and the due date of an unpaid invoice that was not yet overdue move forward by the
-- paused days, so the customer loses no time.
create function app.set_ticket_pause(
  p_ticket_id uuid,
  p_pause boolean,
  p_now timestamptz,
  p_reason text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
  v_active boolean;
  v_shift interval;
  v_days integer;
  v_due_to date;
begin
  perform app.set_actor(null);
  t := app.lock_ticket(p_ticket_id);
  v_active := app.ticket_accounts_active(t.customer_id);
  if t.status in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'STATE');
  end if;

  if p_pause then
    if t.paused_at is not null or v_active then
      return jsonb_build_object('ticket_id', t.id, 'skipped', 'STATE');
    end if;
    update public.billing_cycle_tickets set paused_at = p_now where id = t.id;
    perform app.insert_ticket_event(t, 'PAUSED', t.status, null, p_reason, jsonb_build_object('paused_at', p_now));
    perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
    return jsonb_build_object('ticket_id', t.id, 'paused', true);
  end if;

  if t.paused_at is null or not v_active then
    return jsonb_build_object('ticket_id', t.id, 'skipped', 'STATE');
  end if;
  v_shift := greatest(p_now - t.paused_at, interval '0');
  v_days := greatest(app.colombo_date(p_now) - app.colombo_date(t.paused_at), 0);
  update public.billing_cycle_tickets
  set paused_at = null,
      stage_due_at = stage_due_at + v_shift,
      stage_entered_at = stage_entered_at + v_shift,
      last_reminder_at = last_reminder_at + v_shift
  where id = t.id;

  select * into inv from public.invoices where id = t.current_invoice_id for update;
  if inv.id is not null and v_days > 0 and inv.due_date is not null
     and inv.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'PAYMENT_SUBMITTED', 'DISPUTED') then
    v_due_to := inv.due_date + v_days;
    update public.invoices set due_date = v_due_to where id = inv.id;
  end if;

  perform app.insert_ticket_event(t, 'RESUMED', t.status, null, p_reason,
    jsonb_build_object('paused_at', t.paused_at, 'paused_days', v_days,
                       'due_date_from', case when v_due_to is not null then inv.due_date end, 'due_date_to', v_due_to));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'resumed', true, 'paused_days', v_days, 'due_date', v_due_to);
end;
$$;

-- g. Meter photos to delete: confirmed / superseded (delete requested) or past
--    their retention (rejected attempts, rule in spec 6.5).
create function app.cron_expired_photos(p_now timestamptz, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'storage_path', x.storage_path) order by x.due, x.id), '[]'::jsonb)
  from (
    select ph.id, ph.storage_path, coalesce(ph.delete_requested_at, ph.expires_at) as due
    from public.meter_photos ph
    where ph.deleted_at is null
      and (ph.delete_requested_at is not null or ph.expires_at <= p_now)
    order by due, ph.id
    limit p_limit
  ) x;
$$;

-- The storage objects are gone (server code removed them): mark the rows. The row
-- stays as the audit record (INV-10).
create function app.mark_photos_deleted(p_ids jsonb, p_now timestamptz) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform app.set_actor(null);
  update public.meter_photos
  set deleted_at = p_now, delete_requested_at = coalesce(delete_requested_at, p_now)
  where deleted_at is null and id in (select (x #>> '{}')::uuid from jsonb_array_elements(p_ids) x);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Weekly overdue summary (spec 8.3): owners with overdue invoices whose summary for
-- the current week (from their summary weekday) was not sent yet.
create function app.cron_overdue_summaries(p_today date) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.owner_id), '[]'::jsonb)
  from (
    select o.id as owner_id, w.week_of, count(*)::integer as invoice_count,
           sum(i.total_cents - i.amount_paid_cents)::bigint as outstanding_cents
    from public.owners o
    join public.profiles op on op.id = o.id and op.status = 'ACTIVE'
    join public.owner_settings_effective s on s.owner_id = o.id
    cross join lateral (
      select p_today - ((extract(dow from p_today)::integer - s.weekly_summary_dow + 7) % 7) as week_of
    ) w
    join public.invoices i on i.owner_id = o.id and i.status = 'OVERDUE' and i.amount_paid_cents < i.total_cents
    where not exists (
      select 1 from public.notifications n
      where n.owner_id = o.id and n.event = 'payment.overdue_summary'
        and n.data ->> 'dedupe_key' = 'overdue-summary:' || w.week_of::text
    )
    group by o.id, w.week_of
  ) x;
$$;

-- Notifications sent at most once per key (weekly summaries).
create function app.notify_once(p_owner_id uuid, p_dedupe_key text, p_notifications jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_count integer;
begin
  perform app.set_actor(null);
  if coalesce(btrim(p_dedupe_key), '') = '' then
    perform app.fail('RD400', 'A key is required');
  end if;
  perform pg_advisory_xact_lock(hashtext('rentdesk.notify.' || p_owner_id::text || '.' || p_dedupe_key));
  if exists (select 1 from public.notifications n where n.owner_id = p_owner_id and n.data ->> 'dedupe_key' = p_dedupe_key) then
    return jsonb_build_object('skipped', true);
  end if;
  select coalesce(jsonb_agg(x || jsonb_build_object('data', coalesce(x -> 'data', '{}'::jsonb)
                                                    || jsonb_build_object('dedupe_key', p_dedupe_key))), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(coalesce(p_notifications, '[]'::jsonb)) x;
  v_count := app.enqueue_notifications(p_owner_id, v_items, null, null);
  return jsonb_build_object('sent', v_count);
end;
$$;

-- =============================================================================
-- Grants: app.* service_role only; public.rpc_* wrappers service_role only.
-- =============================================================================
revoke execute on function
  app.enter_stage_at(uuid, public.ticket_status, timestamptz, timestamptz),
  app.colombo_date(timestamptz),
  app.ticket_accounts_active(uuid),
  app.cron_begin_run(text, text, uuid, timestamptz, boolean),
  app.cron_finish_run(uuid, text, jsonb, jsonb, boolean),
  app.cron_context(),
  app.open_billing_cycle(uuid, integer, timestamptz, jsonb, timestamptz, jsonb),
  app.verify_estimated_invoice(public.billing_cycle_tickets, jsonb),
  app.create_estimated_invoice(uuid, jsonb, timestamptz, timestamptz, jsonb),
  app.transition_ticket(uuid, public.ticket_status, public.ticket_status, uuid, text, timestamptz,
                        public.invoice_status, public.ticket_event_type, jsonb, jsonb, date),
  app.raise_dispute(uuid, uuid, text, jsonb),
  app.resolve_dispute(uuid, uuid, public.dispute_status, text, timestamptz, jsonb),
  app.cron_due_agreements(date, integer),
  app.cron_ticket_candidates(uuid, integer),
  app.mark_ticket_overdue(uuid, public.ticket_status, timestamptz, text, smallint, smallint, jsonb),
  app.record_ticket_reminder(uuid, public.ticket_status, smallint, timestamptz, jsonb, jsonb),
  app.escalate_ticket(uuid, public.ticket_status, smallint, timestamptz, text, jsonb),
  app.apply_late_fee(uuid, uuid, jsonb, bigint, timestamptz, jsonb),
  app.cron_pause_candidates(uuid, integer),
  app.set_ticket_pause(uuid, boolean, timestamptz, text, jsonb),
  app.cron_expired_photos(timestamptz, integer),
  app.mark_photos_deleted(jsonb, timestamptz),
  app.cron_overdue_summaries(date),
  app.notify_once(uuid, text, jsonb)
from public, anon, authenticated;

grant execute on function
  app.enter_stage_at(uuid, public.ticket_status, timestamptz, timestamptz),
  app.colombo_date(timestamptz),
  app.ticket_accounts_active(uuid),
  app.cron_begin_run(text, text, uuid, timestamptz, boolean),
  app.cron_finish_run(uuid, text, jsonb, jsonb, boolean),
  app.cron_context(),
  app.open_billing_cycle(uuid, integer, timestamptz, jsonb, timestamptz, jsonb),
  app.verify_estimated_invoice(public.billing_cycle_tickets, jsonb),
  app.create_estimated_invoice(uuid, jsonb, timestamptz, timestamptz, jsonb),
  app.transition_ticket(uuid, public.ticket_status, public.ticket_status, uuid, text, timestamptz,
                        public.invoice_status, public.ticket_event_type, jsonb, jsonb, date),
  app.raise_dispute(uuid, uuid, text, jsonb),
  app.resolve_dispute(uuid, uuid, public.dispute_status, text, timestamptz, jsonb),
  app.cron_due_agreements(date, integer),
  app.cron_ticket_candidates(uuid, integer),
  app.mark_ticket_overdue(uuid, public.ticket_status, timestamptz, text, smallint, smallint, jsonb),
  app.record_ticket_reminder(uuid, public.ticket_status, smallint, timestamptz, jsonb, jsonb),
  app.escalate_ticket(uuid, public.ticket_status, smallint, timestamptz, text, jsonb),
  app.apply_late_fee(uuid, uuid, jsonb, bigint, timestamptz, jsonb),
  app.cron_pause_candidates(uuid, integer),
  app.set_ticket_pause(uuid, boolean, timestamptz, text, jsonb),
  app.cron_expired_photos(timestamptz, integer),
  app.mark_photos_deleted(jsonb, timestamptz),
  app.cron_overdue_summaries(date),
  app.notify_once(uuid, text, jsonb)
to service_role;

-- -----------------------------------------------------------------------------
-- public.rpc_* wrappers (service role only; each forwards to app.*)
-- -----------------------------------------------------------------------------
create function public.rpc_open_billing_cycle(
  p_agreement_id uuid,
  p_cycle_no integer,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb,
  p_now timestamptz default now(),
  p_overdue_notifications jsonb default '[]'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.open_billing_cycle(p_agreement_id, p_cycle_no, p_stage_due_at, p_notifications, p_now, p_overdue_notifications);
$$;

create function public.rpc_transition_ticket(
  p_ticket_id uuid,
  p_from public.ticket_status,
  p_to public.ticket_status,
  p_actor_id uuid,
  p_reason text default null,
  p_stage_due_at timestamptz default null,
  p_invoice_status public.invoice_status default null,
  p_event_type public.ticket_event_type default 'STATUS_CHANGE',
  p_metadata jsonb default '{}'::jsonb,
  p_notifications jsonb default '[]'::jsonb,
  p_due_date date default null
) returns jsonb
language sql
set search_path = ''
as $$
  select app.transition_ticket(p_ticket_id, p_from, p_to, p_actor_id, p_reason, p_stage_due_at, p_invoice_status,
                               p_event_type, p_metadata, p_notifications, p_due_date);
$$;

create function public.rpc_create_estimated_invoice(
  p_ticket_id uuid, p_invoice jsonb, p_stage_due_at timestamptz, p_now timestamptz, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.create_estimated_invoice(p_ticket_id, p_invoice, p_stage_due_at, p_now, p_notifications);
$$;

create function public.rpc_raise_dispute(
  p_ticket_id uuid, p_actor_id uuid, p_reason text, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.raise_dispute(p_ticket_id, p_actor_id, p_reason, p_notifications);
$$;

create function public.rpc_resolve_dispute(
  p_ticket_id uuid, p_actor_id uuid, p_outcome public.dispute_status, p_resolution text,
  p_stage_due_at timestamptz default null, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.resolve_dispute(p_ticket_id, p_actor_id, p_outcome, p_resolution, p_stage_due_at, p_notifications);
$$;

create function public.rpc_cron_begin_run(
  p_job text, p_trigger text, p_triggered_by uuid, p_now timestamptz, p_simulated boolean
) returns jsonb language sql set search_path = '' as $$
  select app.cron_begin_run(p_job, p_trigger, p_triggered_by, p_now, p_simulated);
$$;

create function public.rpc_cron_finish_run(
  p_run_id uuid, p_status text, p_counts jsonb, p_errors jsonb, p_remaining boolean
) returns void language sql set search_path = '' as $$
  select app.cron_finish_run(p_run_id, p_status, p_counts, p_errors, p_remaining);
$$;

create function public.rpc_cron_context() returns jsonb language sql set search_path = '' as $$
  select app.cron_context();
$$;

create function public.rpc_cron_due_agreements(p_today date, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_due_agreements(p_today, p_limit);
$$;

create function public.rpc_cron_ticket_candidates(p_after uuid, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_ticket_candidates(p_after, p_limit);
$$;

create function public.rpc_mark_ticket_overdue(
  p_ticket_id uuid, p_from public.ticket_status, p_now timestamptz, p_reason text,
  p_reminder_no smallint, p_escalation_level smallint, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.mark_ticket_overdue(p_ticket_id, p_from, p_now, p_reason, p_reminder_no, p_escalation_level, p_notifications);
$$;

create function public.rpc_record_ticket_reminder(
  p_ticket_id uuid, p_status public.ticket_status, p_reminder_no smallint, p_now timestamptz,
  p_metadata jsonb default '{}'::jsonb, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.record_ticket_reminder(p_ticket_id, p_status, p_reminder_no, p_now, p_metadata, p_notifications);
$$;

create function public.rpc_escalate_ticket(
  p_ticket_id uuid, p_status public.ticket_status, p_level smallint, p_now timestamptz, p_reason text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.escalate_ticket(p_ticket_id, p_status, p_level, p_now, p_reason, p_notifications);
$$;

create function public.rpc_apply_late_fee(
  p_ticket_id uuid, p_invoice_id uuid, p_line jsonb, p_total_cents bigint, p_now timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.apply_late_fee(p_ticket_id, p_invoice_id, p_line, p_total_cents, p_now, p_notifications);
$$;

create function public.rpc_cron_pause_candidates(p_owner_id uuid, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_pause_candidates(p_owner_id, p_limit);
$$;

create function public.rpc_set_ticket_pause(
  p_ticket_id uuid, p_pause boolean, p_now timestamptz, p_reason text, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.set_ticket_pause(p_ticket_id, p_pause, p_now, p_reason, p_notifications);
$$;

create function public.rpc_cron_expired_photos(p_now timestamptz, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_expired_photos(p_now, p_limit);
$$;

create function public.rpc_mark_photos_deleted(p_ids jsonb, p_now timestamptz) returns integer
language sql set search_path = '' as $$
  select app.mark_photos_deleted(p_ids, p_now);
$$;

create function public.rpc_cron_overdue_summaries(p_today date) returns jsonb
language sql set search_path = '' as $$
  select app.cron_overdue_summaries(p_today);
$$;

create function public.rpc_notify_once(p_owner_id uuid, p_dedupe_key text, p_notifications jsonb) returns jsonb
language sql set search_path = '' as $$
  select app.notify_once(p_owner_id, p_dedupe_key, p_notifications);
$$;

revoke execute on function
  public.rpc_open_billing_cycle(uuid, integer, timestamptz, jsonb, timestamptz, jsonb),
  public.rpc_transition_ticket(uuid, public.ticket_status, public.ticket_status, uuid, text, timestamptz,
                               public.invoice_status, public.ticket_event_type, jsonb, jsonb, date),
  public.rpc_create_estimated_invoice(uuid, jsonb, timestamptz, timestamptz, jsonb),
  public.rpc_raise_dispute(uuid, uuid, text, jsonb),
  public.rpc_resolve_dispute(uuid, uuid, public.dispute_status, text, timestamptz, jsonb),
  public.rpc_cron_begin_run(text, text, uuid, timestamptz, boolean),
  public.rpc_cron_finish_run(uuid, text, jsonb, jsonb, boolean),
  public.rpc_cron_context(),
  public.rpc_cron_due_agreements(date, integer),
  public.rpc_cron_ticket_candidates(uuid, integer),
  public.rpc_mark_ticket_overdue(uuid, public.ticket_status, timestamptz, text, smallint, smallint, jsonb),
  public.rpc_record_ticket_reminder(uuid, public.ticket_status, smallint, timestamptz, jsonb, jsonb),
  public.rpc_escalate_ticket(uuid, public.ticket_status, smallint, timestamptz, text, jsonb),
  public.rpc_apply_late_fee(uuid, uuid, jsonb, bigint, timestamptz, jsonb),
  public.rpc_cron_pause_candidates(uuid, integer),
  public.rpc_set_ticket_pause(uuid, boolean, timestamptz, text, jsonb),
  public.rpc_cron_expired_photos(timestamptz, integer),
  public.rpc_mark_photos_deleted(jsonb, timestamptz),
  public.rpc_cron_overdue_summaries(date),
  public.rpc_notify_once(uuid, text, jsonb)
from public, anon, authenticated;

grant execute on function
  public.rpc_open_billing_cycle(uuid, integer, timestamptz, jsonb, timestamptz, jsonb),
  public.rpc_transition_ticket(uuid, public.ticket_status, public.ticket_status, uuid, text, timestamptz,
                               public.invoice_status, public.ticket_event_type, jsonb, jsonb, date),
  public.rpc_create_estimated_invoice(uuid, jsonb, timestamptz, timestamptz, jsonb),
  public.rpc_raise_dispute(uuid, uuid, text, jsonb),
  public.rpc_resolve_dispute(uuid, uuid, public.dispute_status, text, timestamptz, jsonb),
  public.rpc_cron_begin_run(text, text, uuid, timestamptz, boolean),
  public.rpc_cron_finish_run(uuid, text, jsonb, jsonb, boolean),
  public.rpc_cron_context(),
  public.rpc_cron_due_agreements(date, integer),
  public.rpc_cron_ticket_candidates(uuid, integer),
  public.rpc_mark_ticket_overdue(uuid, public.ticket_status, timestamptz, text, smallint, smallint, jsonb),
  public.rpc_record_ticket_reminder(uuid, public.ticket_status, smallint, timestamptz, jsonb, jsonb),
  public.rpc_escalate_ticket(uuid, public.ticket_status, smallint, timestamptz, text, jsonb),
  public.rpc_apply_late_fee(uuid, uuid, jsonb, bigint, timestamptz, jsonb),
  public.rpc_cron_pause_candidates(uuid, integer),
  public.rpc_set_ticket_pause(uuid, boolean, timestamptz, text, jsonb),
  public.rpc_cron_expired_photos(timestamptz, integer),
  public.rpc_mark_photos_deleted(jsonb, timestamptz),
  public.rpc_cron_overdue_summaries(date),
  public.rpc_notify_once(uuid, text, jsonb)
to service_role;
