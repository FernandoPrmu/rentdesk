-- =============================================================================
-- 0027 Disputes, ticket comments and the section 11 scenarios (task 8;
-- docs/decisions.md rules 47-56, docs/scenarios.md).
--   A. Settings: dispute reminders (day 3 and 5) and admin escalation (day 7).
--   B. Meter baselines through one audited function (11.2, 11.8). The owner may
--      give the old meter's last reading: the copies printed on it since the last
--      reading are carried into the next invoice (app.carried_copies, checked by
--      verify_meter_invoice / verify_final_invoice).
--   C. Ticket comments (TKT-11): customer and owner, 1,000 characters, edits by the
--      author for 5 minutes, idempotent, rate-limited, audited.
--   D. Disputes (11.4, CP-06): one per invoice, optional photo or PDF (own private
--      bucket), answered by rejecting (optional new due date), correcting the
--      invoice (E) or giving a credit; a fresh meter photo may be requested.
--   E. Correction after confirmation (11.3, 11.4, 11.1): the invoice is cancelled
--      (number voided, money paid kept as credit) and a corrected invoice with a new
--      number replaces it on the same ticket; never an edit in place.
--   F. Resend an invoice notification (11.4).
--   G. Admin alerts when the daily job fails or has not run for 30 hours (11.7).
--   H. Grants and public.rpc_* wrappers (service role only).
-- =============================================================================

-- =============================================================================
-- A. Settings (platform level; the admin may change them)
-- =============================================================================
alter table public.platform_settings
  add column dispute_reminder_days integer[] not null default '{3,5}',
  add column dispute_escalation_days integer not null default 7
    constraint platform_settings_dispute_escalation_days check (dispute_escalation_days between 1 and 60);

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
  p.dispute_escalation_days
from public.owners o
cross join public.platform_settings p
left join public.owner_settings s on s.owner_id = o.id;

-- =============================================================================
-- B. Meter baselines (spec 6.4, 11.2, 11.8; rule 11)
-- =============================================================================
alter table public.meter_baselines
  add column previous_value bigint check (previous_value >= 0),
  add column old_meter_reading bigint check (old_meter_reading >= 0),
  add column carried_copies bigint not null default 0 check (carried_copies >= 0),
  add constraint meter_baselines_carried check (
    carried_copies = 0 or (old_meter_reading is not null and old_meter_reading - coalesce(previous_value, 0) = carried_copies)
  );
comment on column public.meter_baselines.carried_copies is
  'Copies printed on the replaced meter since the last known reading (old meter''s last reading - previous_value); billed with the next reading.';

-- Owners record baselines only through app.record_meter_baseline (server-write-only).
drop policy meter_baselines_insert on public.meter_baselines;
revoke insert on public.meter_baselines from authenticated;

-- Copies from replaced meters not billed yet: baselines recorded since the newest
-- initial or confirmed reading (a baseline wins a tie, as in app.last_known_reading).
-- Mirrors carriedCopies in src/lib/billing/usage.ts.
create function app.carried_copies(p_agreement_id uuid, p_counter public.counter_type) returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(b.carried_copies), 0)::bigint
  from public.meter_baselines b
  where b.agreement_id = p_agreement_id
    and b.counter_type = p_counter
    and b.recorded_at >= (
      select max(k.at) from (
        select a.created_at as at
        from public.rental_agreements a
        where a.id = p_agreement_id
          and (case p_counter when 'BW' then a.initial_bw_reading else a.initial_colour_reading end) is not null
        union all
        select coalesce(s.reviewed_at, s.submitted_at)
        from public.meter_readings r
        join public.meter_submissions s on s.id = r.submission_id
        join public.billing_cycle_tickets t on t.id = s.ticket_id
        where t.agreement_id = p_agreement_id and s.status = 'CONFIRMED' and r.counter_type = p_counter
      ) k
    );
$$;

-- The engine's calculation must carry exactly the copies the baselines hold.
create function app.verify_carried_copies(p_agreement_id uuid, p_calc jsonb) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_counter jsonb;
begin
  for v_counter in select * from jsonb_array_elements(coalesce(p_calc -> 'counters', '[]'::jsonb)) loop
    if coalesce((v_counter ->> 'carried_copies')::bigint, 0)
       is distinct from app.carried_copies(p_agreement_id, (v_counter ->> 'counter_type')::public.counter_type) then
      perform app.fail('RD409', 'The copies from a replaced meter have changed; recalculate the invoice');
    end if;
  end loop;
end;
$$;

-- Replaces 0017's: + the carried copies.
create or replace function app.verify_meter_invoice(
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
  perform app.verify_carried_copies(t.agreement_id, c);
  if p_anomaly_flag is distinct from (c ->> 'anomaly') then
    perform app.fail('RD400', 'The anomaly flag does not match the calculation');
  end if;

  perform app.verify_invoice_lines(p_invoice);
end;
$$;

-- Replaces 0017's: + the carried copies.
create or replace function app.verify_final_invoice(
  a public.rental_agreements,
  p_facts jsonb,
  h public.agreement_terms_history,
  p_readings jsonb,
  p_invoice jsonb,
  p_anomaly_flag text,
  p_rule text
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := p_invoice -> 'calculation';
  v_full integer := (p_facts ->> 'full_cycles')::integer;
  v_reading jsonb;
  v_calc jsonb;
begin
  if jsonb_typeof(c) is distinct from 'object' or coalesce(c ->> 'engine', '') = '' then
    perform app.fail('RD400', 'The invoice must be calculated by the billing engine');
  end if;
  if coalesce(p_invoice ->> 'type', 'NORMAL') <> 'NORMAL' or (c ->> 'type') is distinct from 'NORMAL' then
    perform app.fail('RD400', 'A final invoice is a normal invoice');
  end if;
  if (c -> 'terms') is distinct from jsonb_build_object(
    'commitment_cents', h.monthly_commitment_cents, 'bw_included', h.bw_included, 'bw_rate_cents', h.bw_rate_cents,
    'colour_included', h.colour_included, 'colour_rate_cents', h.colour_rate_cents
  ) then
    perform app.fail('RD409', 'The final invoice was calculated with other terms than the agreement''s');
  end if;
  if (c ->> 'full_cycles')::integer is distinct from v_full
     or (c ->> 'cycles_covered')::integer is distinct from v_full + 1
     or (p_invoice ->> 'cycles_covered')::integer is distinct from v_full + 1 then
    perform app.fail('RD409', format('The final invoice covers %s whole cycle(s) and the cycle in progress; recalculate it', v_full));
  end if;
  if (c -> 'partial') is distinct from jsonb_build_object(
    'days_used', (p_facts ->> 'days_used')::integer,
    'days_in_cycle', (p_facts ->> 'days_in_cycle')::integer,
    'rule', p_rule
  ) then
    perform app.fail('RD409', format('The final cycle has %s of %s days used today; recalculate the invoice',
                                     p_facts ->> 'days_used', p_facts ->> 'days_in_cycle'));
  end if;

  if jsonb_typeof(c -> 'counters') is distinct from 'array'
     or jsonb_array_length(c -> 'counters') <> jsonb_array_length(p_readings) then
    perform app.fail('RD400', 'The calculation does not match the closing readings');
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
      perform app.fail('RD400', 'The calculation does not match the closing readings');
    end if;
    if app.last_known_reading(a.id, (v_reading ->> 'counter_type')::public.counter_type)
       is distinct from (v_reading ->> 'previous_value')::bigint then
      perform app.fail('RD409', 'The previous meter reading has changed; recalculate the invoice');
    end if;
  end loop;
  perform app.verify_carried_copies(a.id, c);
  if p_anomaly_flag is distinct from (c ->> 'anomaly') then
    perform app.fail('RD400', 'The anomaly flag does not match the calculation');
  end if;

  perform app.verify_invoice_lines(p_invoice);
end;
$$;

-- The owner records a new baseline after a meter reset or replacement (11.2, 11.8).
--   p_counters: [{counter_type, value, old_meter_reading (optional)}]
create function app.record_meter_baseline(
  p_agreement_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_counters jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.rental_agreements;
  v_type public.machine_type;
  t public.billing_cycle_tickets;
  v_item jsonb;
  v_counter public.counter_type;
  v_value bigint;
  v_old bigint;
  v_prev bigint;
  v_carried bigint;
  v_seen public.counter_type[] := '{}';
  v_rows jsonb := '[]'::jsonb;
begin
  perform app.set_actor(p_actor_id);
  select * into a from public.rental_agreements where id = p_agreement_id for update;
  if not found then
    perform app.fail('RD404', 'Agreement not found');
  end if;
  perform app.assert_actor(p_actor_id, a.owner_id, a.customer_id, array['OWNER']::public.user_role[]);
  if a.status <> 'ACTIVE' then
    perform app.fail('RD409', 'A new meter baseline can be recorded only on a live agreement');
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    perform app.fail('RD400', 'A reason is required');
  end if;
  select m.type into v_type from public.machines m where m.id = a.machine_id;

  -- Same lock order as submit_meter_reading (newest first). A reading waiting for
  -- review was calculated from the old previous reading: it is checked first.
  perform 1 from public.billing_cycle_tickets bt
  where bt.agreement_id = a.id and bt.status not in ('CLOSED', 'CANCELLED')
  order by bt.cycle_no desc
  for update;
  if exists (select 1 from public.billing_cycle_tickets bt where bt.agreement_id = a.id and bt.status = 'PENDING_OWNER_REVIEW') then
    perform app.fail('RD409', 'REVIEW_PENDING: A meter reading or estimate is waiting for your review. Confirm or reject it first.');
  end if;

  if jsonb_typeof(p_counters) is distinct from 'array' or jsonb_array_length(p_counters) = 0 then
    perform app.fail('RD400', 'Enter at least one new starting reading');
  end if;
  for v_item in select * from jsonb_array_elements(p_counters) loop
    v_counter := (v_item ->> 'counter_type')::public.counter_type;
    if v_counter = any (v_seen) then
      perform app.fail('RD400', 'A counter is listed twice');
    end if;
    if v_counter = 'COLOUR' and v_type <> 'COLOUR' then
      perform app.fail('RD400', 'A mono machine has only a B&W counter');
    end if;
    v_seen := v_seen || v_counter;
    v_value := (v_item ->> 'value')::bigint;
    if v_value is null or v_value < 0 then
      perform app.fail('RD400', 'The new starting reading must be 0 or more');
    end if;
    v_old := nullif(v_item ->> 'old_meter_reading', '')::bigint;
    v_prev := app.last_known_reading(a.id, v_counter);
    v_carried := 0;
    if v_old is not null then
      if v_old < coalesce(v_prev, 0) then
        perform app.fail('RD400', format('OLD_BELOW_PREVIOUS: The old meter''s last %s reading (%s) is lower than the last known reading (%s)',
                                         case v_counter when 'BW' then 'B&W' else 'colour' end, v_old, coalesce(v_prev, 0)));
      end if;
      v_carried := v_old - coalesce(v_prev, 0);
    end if;
    insert into public.meter_baselines (owner_id, agreement_id, counter_type, value, reason, recorded_by,
                                        previous_value, old_meter_reading, carried_copies)
    values (a.owner_id, a.id, v_counter, v_value, btrim(p_reason), p_actor_id, v_prev, v_old, v_carried);
    v_rows := v_rows || jsonb_build_object('counter_type', v_counter, 'value', v_value, 'previous_value', v_prev,
                                           'old_meter_reading', v_old, 'carried_copies', v_carried);
  end loop;

  -- On the agreement's newest open ticket, so both sides see it in the history.
  select * into t from public.billing_cycle_tickets bt
  where bt.agreement_id = a.id and bt.status not in ('CLOSED', 'CANCELLED')
  order by bt.cycle_no desc
  limit 1;
  if t.id is not null then
    perform app.insert_ticket_event(t, 'BASELINE', t.status, p_actor_id, p_reason, jsonb_build_object('counters', v_rows));
  end if;
  perform app.write_audit(p_actor_id, 'METER_BASELINE_RECORDED', 'rental_agreement', a.id, a.owner_id,
                          jsonb_build_object('reason', btrim(p_reason), 'counters', v_rows, 'ticket_id', t.id));
  perform app.enqueue_notifications(a.owner_id, p_notifications, 'rental_agreement', a.id);
  return jsonb_build_object('agreement_id', a.id, 'ticket_id', t.id, 'counters', v_rows);
end;
$$;

-- =============================================================================
-- C. Ticket comments (TKT-11, CP-06; rule 50)
-- =============================================================================
alter table public.ticket_comments
  add column author_role public.user_role,
  add column idempotency_key uuid,
  add column edited_at timestamptz,
  add constraint ticket_comments_idempotency_key unique (idempotency_key),
  add constraint ticket_comments_body_max check (length(btrim(body)) <= 1000) not valid;
update public.ticket_comments c set author_role = p.role from public.profiles p where p.id = c.author_id and c.author_role is null;

create trigger ticket_comments_audit after insert or update on public.ticket_comments
  for each row execute function app.audit_row_change('all');

create function app.add_ticket_comment(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_body text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  c public.ticket_comments;
  v_role public.user_role;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  perform app.set_actor(p_actor_id);
  if p_idempotency_key is null then
    perform app.fail('RD400', 'An idempotency key is required');
  end if;
  select * into c from public.ticket_comments where idempotency_key = p_idempotency_key;
  if found then
    if c.ticket_id <> p_ticket_id or c.author_id is distinct from p_actor_id then
      perform app.fail('RD409', 'Idempotency key already used');
    end if;
    return jsonb_build_object('comment_id', c.id, 'replayed', true);
  end if;

  t := app.lock_ticket(p_ticket_id);
  v_role := app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER', 'CUSTOMER']::public.user_role[]);
  if length(v_body) = 0 or length(v_body) > 1000 then
    perform app.fail('RD400', 'A message has 1 to 1,000 characters');
  end if;
  if (select count(*) from public.ticket_comments x
      where x.ticket_id = t.id and x.author_id = p_actor_id and x.created_at > now() - interval '1 hour') >= 30 then
    perform app.fail('RD409', 'TOO_MANY_COMMENTS: Too many messages on this ticket in the last hour. Please wait a little.');
  end if;

  insert into public.ticket_comments (owner_id, ticket_id, author_id, author_role, body, idempotency_key)
  values (t.owner_id, t.id, p_actor_id, v_role, v_body, p_idempotency_key)
  returning id into v_id;
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('comment_id', v_id, 'replayed', false);
end;
$$;

-- The author may change a comment for 5 minutes (server time); the audit trigger
-- keeps the old and the new text.
create function app.edit_ticket_comment(p_comment_id uuid, p_actor_id uuid, p_body text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.ticket_comments;
  t public.billing_cycle_tickets;
  v_body text := btrim(coalesce(p_body, ''));
begin
  perform app.set_actor(p_actor_id);
  select * into c from public.ticket_comments where id = p_comment_id for update;
  if not found then
    perform app.fail('RD404', 'Message not found');
  end if;
  select * into t from public.billing_cycle_tickets where id = c.ticket_id;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER', 'CUSTOMER']::public.user_role[]);
  if c.author_id <> p_actor_id then
    perform app.fail('RD403', 'Only the author can change a message');
  end if;
  if now() > c.created_at + interval '5 minutes' then
    perform app.fail('RD409', 'EDIT_WINDOW_OVER: A message can be changed only in the first 5 minutes');
  end if;
  if length(v_body) = 0 or length(v_body) > 1000 then
    perform app.fail('RD400', 'A message has 1 to 1,000 characters');
  end if;
  if v_body = c.body then
    return jsonb_build_object('comment_id', c.id, 'changed', false);
  end if;
  update public.ticket_comments set body = v_body, edited_at = now() where id = c.id;
  return jsonb_build_object('comment_id', c.id, 'changed', true);
end;
$$;

-- =============================================================================
-- D. Disputes (spec 11.4, CP-06; rules 47-49)
-- =============================================================================
create type public.dispute_resolution_kind as enum ('REJECTED', 'CORRECTED', 'CREDIT', 'CANCELLED');

alter table public.disputes
  add column idempotency_key uuid,
  add column attachment_path text,
  add column attachment_sha256 text check (attachment_sha256 ~ '^[0-9a-f]{64}$'),
  add column attachment_mime text check (attachment_mime in ('image/jpeg', 'image/png', 'application/pdf')),
  add column attachment_size integer check (attachment_size between 1 and 5242880),
  add column resolution_kind public.dispute_resolution_kind,
  add column credit_id uuid references public.credits (id),
  add column replacement_invoice_id uuid,
  add column new_due_date date,
  add column photo_requested_at timestamptz,
  add column photo_requested_by uuid references public.profiles (id),
  add column photo_request_note text,
  add column photo_received_at timestamptz,
  add column photo_readings jsonb;

update public.disputes d
set resolution_kind = case
  when d.status = 'REJECTED' then 'REJECTED'
  when exists (select 1 from public.billing_cycle_tickets t where t.id = d.ticket_id and t.status = 'CANCELLED') then 'CANCELLED'
  else 'REJECTED'
end::public.dispute_resolution_kind
where d.status <> 'OPEN' and d.resolution_kind is null;

alter table public.disputes
  add constraint disputes_idempotency_key unique (idempotency_key),
  add constraint disputes_attachment_path_key unique (attachment_path),
  add constraint disputes_id_owner_key unique (id, owner_id),
  add constraint disputes_attachment_complete check (
    num_nonnulls(attachment_path, attachment_sha256, attachment_mime, attachment_size) in (0, 4)
  ),
  add constraint disputes_attachment_in_tenant check (
    attachment_path is null or attachment_path like owner_id::text || '/' || customer_id::text || '/%'
  ),
  add constraint disputes_resolution_kind check ((status = 'OPEN') = (resolution_kind is null)),
  add constraint disputes_replacement_fkey foreign key (replacement_invoice_id, owner_id)
    references public.invoices (id, owner_id);
create index disputes_credit_idx on public.disputes (credit_id);
create index disputes_replacement_idx on public.disputes (replacement_invoice_id, owner_id);
create index disputes_photo_requested_by_idx on public.disputes (photo_requested_by);

-- Whatever ends a dispute (an answer, or the ticket cancelled) records how, and the
-- fresh meter photo of the dispute is deleted (spec 6.5: meter photos are temporary).
create function app.dispute_closing() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'OPEN' and new.status <> 'OPEN' then
    new.resolution_kind := coalesce(new.resolution_kind,
      case new.status when 'REJECTED' then 'REJECTED' else 'CANCELLED' end::public.dispute_resolution_kind);
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  return new;
end;
$$;
create trigger disputes_closing before update on public.disputes
  for each row execute function app.dispute_closing();

create function app.dispute_closed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'OPEN' and new.status <> 'OPEN' then
    update public.meter_photos
    set delete_requested_at = coalesce(delete_requested_at, now())
    where dispute_id = new.id and deleted_at is null;
  end if;
  return null;
end;
$$;

-- A fresh meter photo asked for during a dispute is a meter photo of the dispute.
alter table public.meter_photos
  alter column submission_id drop not null,
  add column dispute_id uuid,
  add constraint meter_photos_dispute_fkey foreign key (dispute_id, owner_id) references public.disputes (id, owner_id),
  add constraint meter_photos_one_parent check (num_nonnulls(submission_id, dispute_id) = 1);
create index meter_photos_dispute_idx on public.meter_photos (dispute_id, owner_id);

create trigger disputes_closed after update on public.disputes
  for each row execute function app.dispute_closed();

-- Storage: the dispute's photo or PDF (same limits as payment slips).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('dispute-files', 'dispute-files', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "dispute-files: customer uploads to own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'dispute-files'
  and (select app.current_user_role()) = 'CUSTOMER'
  and array_length(storage.foldername(objects.name), 1) = 2
  and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
  and (storage.foldername(objects.name))[2] = (select app.current_customer_id())::text
);

create policy "dispute-files: read recorded files"
on storage.objects for select to authenticated
using (
  bucket_id = 'dispute-files'
  and (
    ((select app.is_admin()) and exists (select 1 from public.disputes d where d.attachment_path = objects.name))
    or ((select app.current_user_role()) = 'OWNER'
        and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
        and exists (select 1 from public.disputes d where d.attachment_path = objects.name))
    or ((select app.current_user_role()) = 'CUSTOMER'
        and (storage.foldername(objects.name))[2] = (select app.current_customer_id())::text)
  )
);

-- The fresh meter photo: live camera, uploaded while the owner's request is open.
create policy "meter-photos: customer uploads a fresh photo for a dispute"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'meter-photos'
  and (select app.current_user_role()) = 'CUSTOMER'
  and exists (
    select 1
    from public.billing_cycle_tickets t
    join public.disputes d on d.ticket_id = t.id
    where t.owner_id::text = (storage.foldername(objects.name))[1]
      and t.id::text = (storage.foldername(objects.name))[2]
      and t.customer_id = (select app.current_customer_id())
      and t.status = 'DISPUTED'
      and d.status = 'OPEN'
      and d.photo_requested_at is not null
      and d.photo_received_at is null
  )
);

-- Dispute files uploaded but never sent with a dispute, older than 2 days.
create function app.cron_orphan_dispute_files(p_now timestamptz, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(o.name order by o.created_at), '[]'::jsonb)
  from (
    select so.name, so.created_at
    from storage.objects so
    where so.bucket_id = 'dispute-files'
      and so.created_at < p_now - interval '2 days'
      and not exists (select 1 from public.disputes d where d.attachment_path = so.name)
    order by so.created_at
    limit p_limit
  ) o;
$$;

-- Closes a ticket whose bill is now fully paid (by a credit, or a corrected invoice
-- covered by credits), along the payment edges like an owner-recorded payment (rule 42).
create function app.close_if_settled(p_ticket_id uuid, p_actor_id uuid, p_reason text, p_metadata jsonb) returns public.billing_cycle_tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
begin
  select * into t from public.billing_cycle_tickets where id = p_ticket_id;
  select * into inv from public.invoices where id = t.current_invoice_id for update;
  if inv.amount_paid_cents < inv.total_cents then
    return t;
  end if;
  update public.invoices set status = 'PAID' where id = inv.id;
  if t.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE') then
    t := app.ticket_hop(t.id, 'PAYMENT_SUBMITTED', p_actor_id, p_reason, p_metadata, null);
    t := app.ticket_hop(t.id, 'CLOSED', p_actor_id, p_reason, p_metadata, null);
  end if;
  return t;
end;
$$;

-- Replaces 0019's: an idempotency key, an optional file, and one dispute per invoice (rule 47).
drop function public.rpc_raise_dispute(uuid, uuid, text, jsonb);
drop function app.raise_dispute(uuid, uuid, text, jsonb);
-- Answers now go through reject_dispute, credit_dispute or correct_issued_invoice.
drop function public.rpc_resolve_dispute(uuid, uuid, public.dispute_status, text, timestamptz, jsonb);
drop function app.resolve_dispute(uuid, uuid, public.dispute_status, text, timestamptz, jsonb);

create function app.raise_dispute(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_reason text,
  p_attachment jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  inv public.invoices;
  d public.disputes;
  v_dispute_id uuid;
  v_path text := nullif(btrim(p_attachment ->> 'storage_path'), '');
begin
  perform app.set_actor(p_actor_id);
  if p_idempotency_key is null then
    perform app.fail('RD400', 'An idempotency key is required');
  end if;
  select * into d from public.disputes where idempotency_key = p_idempotency_key;
  if found then
    if d.ticket_id <> p_ticket_id then
      perform app.fail('RD409', 'Idempotency key already used for another ticket');
    end if;
    return jsonb_build_object('ticket_id', d.ticket_id, 'dispute_id', d.id, 'status', 'DISPUTED', 'replayed', true);
  end if;

  t := app.lock_ticket(p_ticket_id);
  if not (t.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID')
          or (t.status = 'OVERDUE' and t.status_before_overdue in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED'))) then
    perform app.fail('RD409', format('Ticket is %s; this invoice cannot be disputed now', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['CUSTOMER']::public.user_role[]);
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) > 1000 then
    perform app.fail('RD400', 'A reason (up to 1,000 characters) is required to dispute an invoice');
  end if;
  select * into inv from public.invoices where id = t.current_invoice_id for update;
  if not found or inv.invoice_no is null or inv.status not in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE') then
    perform app.fail('RD409', 'There is no issued invoice to dispute');
  end if;
  if exists (select 1 from public.disputes x where x.invoice_id = inv.id) then
    perform app.fail('RD409', 'ALREADY_DISPUTED: This bill was already disputed once. Please write to your rental company in the ticket''s messages.');
  end if;
  if v_path is not null and (
       v_path not like t.owner_id::text || '/' || t.customer_id::text || '/%'
       or coalesce(p_attachment ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       or coalesce(p_attachment ->> 'mime_type', '') not in ('image/jpeg', 'image/png', 'application/pdf')
       or coalesce((p_attachment ->> 'size_bytes')::integer, 0) not between 1 and 5242880) then
    perform app.fail('RD400', 'The attached file is not valid');
  end if;

  insert into public.disputes (owner_id, invoice_id, ticket_id, customer_id, raised_by, reason, idempotency_key,
                               attachment_path, attachment_sha256, attachment_mime, attachment_size)
  values (t.owner_id, inv.id, t.id, t.customer_id, p_actor_id, btrim(p_reason), p_idempotency_key,
          v_path,
          case when v_path is not null then p_attachment ->> 'sha256' end,
          case when v_path is not null then p_attachment ->> 'mime_type' end,
          case when v_path is not null then (p_attachment ->> 'size_bytes')::integer end)
  returning id into v_dispute_id;
  update public.invoices set status = 'DISPUTED' where id = inv.id;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'DISPUTED', p_actor_id, p_reason,
    jsonb_build_object('dispute_id', v_dispute_id, 'invoice_id', inv.id, 'invoice_no', inv.invoice_no,
                       'attachment', v_path is not null));
  perform app.enter_stage(t.id, 'DISPUTED', null);
  perform app.write_audit(p_actor_id, 'DISPUTE_RAISED', 'dispute', v_dispute_id, t.owner_id,
                          jsonb_build_object('ticket_id', t.id, 'invoice_id', inv.id, 'reason', btrim(p_reason)));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'dispute_id', v_dispute_id, 'status', 'DISPUTED', 'replayed', false);
end;
$$;

-- The open dispute of a locked DISPUTED ticket, after the owner check.
create function app.open_dispute(t public.billing_cycle_tickets, p_actor_id uuid) returns public.disputes
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.disputes;
begin
  if t.status <> 'DISPUTED' then
    perform app.fail('RD409', format('Ticket is %s, not DISPUTED', t.status));
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[]);
  select * into d from public.disputes where ticket_id = t.id and status = 'OPEN' for update;
  if not found then
    perform app.fail('RD409', 'This ticket has no open dispute');
  end if;
  return d;
end;
$$;

-- "Reject dispute": the invoice stands; a new due date (today or later) is optional.
create function app.reject_dispute(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_due_date date,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  d public.disputes;
  inv public.invoices;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);
  d := app.open_dispute(t, p_actor_id);
  if coalesce(btrim(p_reason), '') = '' then
    perform app.fail('RD400', 'An explanation is required');
  end if;
  if p_due_date is not null and p_due_date < app.colombo_date(now()) then
    perform app.fail('RD400', 'The new due date cannot be in the past');
  end if;
  select * into inv from public.invoices where id = t.current_invoice_id for update;

  update public.disputes
  set status = 'REJECTED', resolution_kind = 'REJECTED', resolution = btrim(p_reason), resolved_by = p_actor_id,
      resolved_at = now(), new_due_date = p_due_date
  where id = d.id;
  update public.invoices
  set status = case when inv.amount_paid_cents > 0 then 'PARTIALLY_PAID' else 'AWAITING_PAYMENT' end::public.invoice_status,
      due_date = coalesce(p_due_date, inv.due_date)
  where id = inv.id;

  perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'AWAITING_PAYMENT', p_actor_id, p_reason,
    jsonb_build_object('dispute_id', d.id, 'dispute_outcome', 'REJECTED', 'invoice_id', inv.id,
                       'due_date_from', inv.due_date, 'due_date_to', coalesce(p_due_date, inv.due_date)));
  perform app.enter_stage(t.id, 'AWAITING_PAYMENT', p_stage_due_at);
  perform app.write_audit(p_actor_id, 'DISPUTE_REJECTED', 'dispute', d.id, t.owner_id,
                          jsonb_build_object('ticket_id', t.id, 'reason', btrim(p_reason), 'new_due_date', p_due_date));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'dispute_id', d.id, 'status', 'AWAITING_PAYMENT', 'outcome', 'REJECTED',
                            'due_date', coalesce(p_due_date, inv.due_date));
end;
$$;

-- "Give a credit" (rule 48): a credit of kind DISPUTE goes on this bill as a CREDIT
-- line, up to what is left to pay (creditOnIssuedInvoice in src/lib/billing/dispute.ts);
-- the rest stays available for the next bills (rule 13). A covered bill closes.
create function app.credit_dispute(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_credit_id uuid,
  p_amount_cents bigint,
  p_line jsonb,
  p_total_cents bigint,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  d public.disputes;
  inv public.invoices;
  v_left bigint;
  v_applied bigint;
  v_meta jsonb;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);
  d := app.open_dispute(t, p_actor_id);
  if coalesce(btrim(p_reason), '') = '' then
    perform app.fail('RD400', 'A reason is required');
  end if;
  if p_credit_id is null or p_amount_cents is null or p_amount_cents <= 0 then
    perform app.fail('RD400', 'The credit must be more than zero');
  end if;
  select * into inv from public.invoices where id = t.current_invoice_id for update;
  v_left := inv.total_cents - inv.amount_paid_cents;
  if v_left <= 0 then
    perform app.fail('RD409', 'Nothing is left to pay on this bill');
  end if;
  v_applied := least(p_amount_cents, v_left);
  if p_line ->> 'line_type' is distinct from 'CREDIT'
     or (p_line ->> 'quantity')::bigint is distinct from 1
     or (p_line ->> 'rate_cents')::bigint is distinct from -v_applied
     or (p_line ->> 'amount_cents')::bigint is distinct from -v_applied
     or (p_line ->> 'credit_id') is distinct from p_credit_id::text
     or coalesce(btrim(p_line ->> 'description'), '') = '' then
    perform app.fail('RD400', 'The credit line does not match the credit');
  end if;
  if p_total_cents is distinct from inv.total_cents - v_applied then
    perform app.fail('RD400', 'The new total does not add up');
  end if;

  insert into public.credits (id, owner_id, customer_id, source_invoice_id, kind, amount_cents, reason, created_by)
  values (p_credit_id, t.owner_id, t.customer_id, inv.id, 'DISPUTE', p_amount_cents,
          format('Dispute on %s: %s', inv.invoice_no, btrim(p_reason)), p_actor_id);
  insert into public.invoice_lines (owner_id, invoice_id, line_type, description, quantity, rate_cents, amount_cents, sort_order, credit_id)
  values (t.owner_id, inv.id, 'CREDIT', btrim(p_line ->> 'description'), 1, -v_applied, -v_applied,
          coalesce((select max(l.sort_order) + 1 from public.invoice_lines l where l.invoice_id = inv.id), 0), p_credit_id);
  update public.invoices
  set credit_applied_cents = credit_applied_cents + v_applied,
      total_cents = p_total_cents,
      status = case when inv.amount_paid_cents > 0 then 'PARTIALLY_PAID' else 'AWAITING_PAYMENT' end::public.invoice_status
  where id = inv.id;

  update public.disputes
  set status = 'RESOLVED', resolution_kind = 'CREDIT', resolution = btrim(p_reason), resolved_by = p_actor_id,
      resolved_at = now(), credit_id = p_credit_id
  where id = d.id;

  v_meta := jsonb_build_object('dispute_id', d.id, 'dispute_outcome', 'CREDIT', 'invoice_id', inv.id,
                               'credit_id', p_credit_id, 'credit_cents', p_amount_cents, 'applied_cents', v_applied,
                               'total_from', inv.total_cents, 'total_to', p_total_cents);
  t := app.ticket_hop(t.id, 'AWAITING_PAYMENT', p_actor_id, p_reason, v_meta, p_stage_due_at);
  t := app.close_if_settled(t.id, p_actor_id, 'Paid in full after the credit', v_meta);

  perform app.write_audit(p_actor_id, 'DISPUTE_CREDIT_GIVEN', 'dispute', d.id, t.owner_id,
                          v_meta || jsonb_build_object('ticket_id', t.id, 'reason', btrim(p_reason)));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'dispute_id', d.id, 'status', t.status, 'outcome', 'CREDIT',
                            'credit_id', p_credit_id, 'applied_cents', v_applied, 'left_over_cents', p_amount_cents - v_applied,
                            'total_cents', p_total_cents);
end;
$$;

-- The owner asks for a fresh live meter photo during the dispute (spec 11.4, 16.2).
create function app.request_dispute_photo(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_note text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  d public.disputes;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);
  d := app.open_dispute(t, p_actor_id);
  if d.photo_requested_at is not null and d.photo_received_at is null then
    perform app.fail('RD409', 'A fresh meter photo was already asked for');
  end if;
  if length(coalesce(btrim(p_note), '')) > 500 then
    perform app.fail('RD400', 'The note has at most 500 characters');
  end if;
  update public.disputes
  set photo_requested_at = now(), photo_requested_by = p_actor_id, photo_request_note = nullif(btrim(p_note), ''),
      photo_received_at = null, photo_readings = null
  where id = d.id;
  perform app.insert_ticket_event(t, 'NOTE', t.status, p_actor_id, p_note,
    jsonb_build_object('kind', 'PHOTO_REQUESTED', 'dispute_id', d.id));
  perform app.write_audit(p_actor_id, 'DISPUTE_PHOTO_REQUESTED', 'dispute', d.id, t.owner_id, jsonb_build_object('ticket_id', t.id));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'dispute_id', d.id);
end;
$$;

-- The customer sends it (live camera, rule 30 checks done by the server first) with the
-- reading(s) the meter shows. Deleted when the dispute ends (trigger above).
create function app.submit_dispute_photo(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_photo jsonb,
  p_readings jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
  d public.disputes;
  v_path text := btrim(coalesce(p_photo ->> 'storage_path', ''));
  v_existing uuid;
  v_reading jsonb;
  v_types text[] := '{}';
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);
  select ph.id into v_existing from public.meter_photos ph where ph.storage_path = v_path;
  if v_existing is not null then
    return jsonb_build_object('ticket_id', t.id, 'photo_id', v_existing, 'replayed', true);
  end if;
  if t.status <> 'DISPUTED' then
    perform app.fail('RD409', 'This ticket is not disputed any more');
  end if;
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['CUSTOMER']::public.user_role[]);
  select * into d from public.disputes where ticket_id = t.id and status = 'OPEN' for update;
  if not found or d.photo_requested_at is null or d.photo_received_at is not null then
    perform app.fail('RD409', 'No fresh meter photo is asked for');
  end if;
  if v_path not like t.owner_id::text || '/' || t.id::text || '/%' then
    perform app.fail('RD400', 'Photo path must be {owner_id}/{ticket_id}/...');
  end if;
  if jsonb_typeof(p_readings) is distinct from 'array'
     or jsonb_array_length(p_readings) <> (case t.machine_type when 'COLOUR' then 2 else 1 end) then
    perform app.fail('RD400', 'Enter the reading(s) the meter shows');
  end if;
  for v_reading in select * from jsonb_array_elements(p_readings) loop
    if (v_reading ->> 'counter_type') not in ('BW', 'COLOUR')
       or (v_reading ->> 'counter_type') = any (v_types)
       or (t.machine_type = 'MONO' and v_reading ->> 'counter_type' = 'COLOUR')
       or coalesce((v_reading ->> 'value')::bigint, -1) < 0 then
      perform app.fail('RD400', 'Enter the reading(s) the meter shows');
    end if;
    v_types := v_types || (v_reading ->> 'counter_type');
  end loop;

  insert into public.meter_photos (owner_id, dispute_id, storage_path, captured_at)
  values (t.owner_id, d.id, v_path, nullif(p_photo ->> 'captured_at', '')::timestamptz)
  returning id into v_existing;
  update public.disputes set photo_received_at = now(), photo_readings = p_readings where id = d.id;
  perform app.insert_ticket_event(t, 'NOTE', t.status, p_actor_id, null,
    jsonb_build_object('kind', 'PHOTO_RECEIVED', 'dispute_id', d.id, 'readings', p_readings));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'photo_id', v_existing, 'replayed', false);
end;
$$;

-- =============================================================================
-- E. Correction after confirmation (11.1, 11.3, 11.4; rule 49)
-- =============================================================================
alter table public.invoices add column revision smallint not null default 1 check (revision >= 1);
comment on column public.invoices.revision is
  '1 for an invoice as first issued; n + 1 for the corrected invoice that replaces revision n (replaces_invoice_id).';

-- The corrected invoice keeps everything of the original except the readings the owner
-- corrected and the adjustment lines: same terms, cycles, final cycle, previous
-- readings, carried copies and estimated charges credited. A late fee is not carried over.
create function app.verify_corrected_invoice(inv public.invoices, p_readings jsonb, p_invoice jsonb) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := p_invoice -> 'calculation';
  o jsonb := inv.calculation;
  v_new jsonb;
  v_old jsonb;
  v_reading jsonb;
begin
  if jsonb_typeof(o) is distinct from 'object' then
    perform app.fail('RD409', 'NO_CALCULATION: This invoice has no stored calculation; cancel the ticket and bill again');
  end if;
  if jsonb_typeof(c) is distinct from 'object' or coalesce(c ->> 'engine', '') = '' then
    perform app.fail('RD400', 'The invoice must be calculated by the billing engine');
  end if;
  if (c ->> 'type') is distinct from inv.type::text or coalesce(p_invoice ->> 'type', 'NORMAL') <> inv.type::text then
    perform app.fail('RD400', 'A corrected invoice keeps the type of the original');
  end if;
  if (c -> 'terms') is distinct from (o -> 'terms')
     or (c -> 'partial') is distinct from (o -> 'partial')
     or (c ->> 'cycles_covered') is distinct from (o ->> 'cycles_covered')
     or (c ->> 'full_cycles') is distinct from (o ->> 'full_cycles')
     or (p_invoice ->> 'cycles_covered')::integer is distinct from inv.cycles_covered::integer
     or coalesce(c -> 'estimate_credits', '[]'::jsonb) is distinct from coalesce(o -> 'estimate_credits', '[]'::jsonb) then
    perform app.fail('RD409', 'A corrected invoice keeps the terms, cycles and estimated charges of the original');
  end if;
  if jsonb_array_length(coalesce(c -> 'counters', '[]'::jsonb)) <> jsonb_array_length(coalesce(o -> 'counters', '[]'::jsonb)) then
    perform app.fail('RD400', 'The corrected invoice has other counters than the original');
  end if;
  for v_old in select * from jsonb_array_elements(coalesce(o -> 'counters', '[]'::jsonb)) loop
    v_new := null;
    select x into v_new from jsonb_array_elements(c -> 'counters') x where x ->> 'counter_type' = v_old ->> 'counter_type';
    if v_new is null
       or (v_new ->> 'previous_value') is distinct from (v_old ->> 'previous_value')
       or coalesce((v_new ->> 'carried_copies')::bigint, 0) is distinct from coalesce((v_old ->> 'carried_copies')::bigint, 0) then
      perform app.fail('RD400', 'A corrected invoice keeps the previous readings of the original');
    end if;
    if p_readings is null then
      if (v_new ->> 'current_value') is distinct from (v_old ->> 'current_value') then
        perform app.fail('RD400', 'The readings were not changed, so they must stay the same');
      end if;
    else
      v_reading := null;
      select x into v_reading from jsonb_array_elements(p_readings) x where x ->> 'counter_type' = v_old ->> 'counter_type';
      if v_reading is null
         or (v_reading ->> 'previous_value')::bigint is distinct from (v_old ->> 'previous_value')::bigint
         or (v_reading ->> 'current_value')::bigint is distinct from (v_new ->> 'current_value')::bigint
         or coalesce((v_reading ->> 'rolled_over')::boolean, false) is distinct from coalesce((v_new ->> 'rolled_over')::boolean, false) then
        perform app.fail('RD400', 'The calculation does not match the corrected readings');
      end if;
    end if;
  end loop;
  if p_readings is not null and jsonb_array_length(p_readings) <> jsonb_array_length(coalesce(o -> 'counters', '[]'::jsonb)) then
    perform app.fail('RD400', 'Give every counter of the reading');
  end if;
  perform app.verify_invoice_lines(p_invoice);
end;
$$;

create function app.correct_issued_invoice(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_invoice_id uuid,
  p_reason text,
  p_readings jsonb,
  p_invoice jsonb,
  p_paid_credit_id uuid,
  p_due_date date,
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
  s public.meter_submissions;
  v_new_id uuid;
  v_no text;
  v_line jsonb;
  v_reading jsonb;
  v_sort smallint := 0;
  v_sub_id uuid;
  v_old_current bigint;
  v_meta jsonb;
  v_was_disputed boolean;
begin
  perform app.set_actor(p_actor_id);
  t := app.lock_ticket(p_ticket_id);
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[]);
  if coalesce(btrim(p_reason), '') = '' then
    perform app.fail('RD400', 'A reason is required');
  end if;
  if t.status = 'PAYMENT_SUBMITTED' then
    perform app.fail('RD409', 'SLIP_WAITING: A payment slip is waiting for your check. Accept or reject it first.');
  end if;
  if t.status = 'CLOSED' then
    perform app.fail('RD409', 'REOPEN_FIRST: This ticket is closed. Reopen it first, with a reason.');
  end if;
  if not (t.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'DISPUTED', 'REOPENED')
          or (t.status = 'OVERDUE' and t.status_before_overdue in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED'))) then
    perform app.fail('RD409', format('Ticket is %s; its invoice cannot be corrected now', t.status));
  end if;
  select * into inv from public.invoices where id = t.current_invoice_id for update;
  if not found or inv.id is distinct from p_invoice_id then
    perform app.fail('RD409', 'The invoice of this ticket has changed; reload the page');
  end if;
  if inv.invoice_no is null or inv.status not in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED', 'PAID') then
    perform app.fail('RD409', 'Only an issued invoice can be corrected');
  end if;
  if exists (select 1 from public.payment_allocations pa where pa.invoice_id = inv.id and pa.waiting) then
    perform app.fail('RD409', 'SLIP_WAITING: A payment slip is waiting for your check. Accept or reject it first.');
  end if;
  if p_due_date is null or p_due_date < app.colombo_date(now()) then
    perform app.fail('RD400', 'The due date must be today or later');
  end if;

  if p_readings is not null then
    if inv.type <> 'NORMAL' then
      perform app.fail('RD400', 'An estimated invoice has no reading; correct it with an adjustment line');
    end if;
    select * into s from public.meter_submissions where invoice_id = inv.id and status = 'CONFIRMED' for update;
    if not found then
      perform app.fail('RD409', 'NO_READING: This invoice has no confirmed reading to correct; use an adjustment line');
    end if;
    -- The next bill measures from this reading: it can change only while it is the latest.
    if exists (
         select 1 from public.meter_submissions s2
         join public.billing_cycle_tickets t2 on t2.id = s2.ticket_id
         where t2.agreement_id = t.agreement_id and t2.cycle_no > t.cycle_no and s2.status in ('PENDING_REVIEW', 'CONFIRMED'))
       or exists (
         select 1 from public.meter_baselines b
         where b.agreement_id = t.agreement_id and b.recorded_at >= coalesce(s.reviewed_at, s.submitted_at)) then
      perform app.fail('RD409', 'LATER_READING: A later reading or a new meter baseline exists, so this reading can no longer change. Correct the amount with an adjustment line instead.');
    end if;
  end if;

  -- 1. The old invoice is cancelled (its number is voided, a CANCELLED PDF version is
  --    made); money paid on it is kept as a credit (spec 11.4), taken off the new one.
  update public.invoices
  set status = 'CANCELLED', cancelled_by = p_actor_id, cancelled_at = now(),
      cancel_reason = format('Corrected: %s', btrim(p_reason))
  where id = inv.id;
  if inv.amount_paid_cents > 0 then
    if p_paid_credit_id is null then
      perform app.fail('RD400', 'The credit for the money already paid is missing; recalculate the invoice');
    end if;
    -- clock_timestamp(): newest of the customer's credits, as the engine assumed (rule 13).
    insert into public.credits (id, owner_id, customer_id, source_invoice_id, kind, amount_cents, reason, created_by, created_at)
    values (p_paid_credit_id, t.owner_id, t.customer_id, inv.id, 'CANCELLED_INVOICE', inv.amount_paid_cents,
            format('Paid on invoice %s (corrected)', inv.invoice_no), p_actor_id, clock_timestamp());
  elsif p_paid_credit_id is not null then
    perform app.fail('RD400', 'Nothing was paid on this invoice; recalculate the invoice');
  end if;

  -- 2. The engine's corrected invoice, against the original and the customer's credits.
  perform app.verify_corrected_invoice(inv, p_readings, p_invoice);
  perform app.verify_invoice_credits(t.owner_id, t.customer_id, p_invoice, null);

  -- 3. The corrected invoice: a new number, issued at once (the owner typed it).
  insert into public.invoices (
    owner_id, customer_id, agreement_id, machine_id, ticket_id, type, status, period_start, period_end, cycles_covered,
    subtotal_cents, credit_applied_cents, total_cents, calculation, due_date, confirmed_by, confirmed_at,
    replaces_invoice_id, revision, branding_snapshot
  ) values (
    t.owner_id, t.customer_id, inv.agreement_id, inv.machine_id, t.id, inv.type, 'DRAFT', inv.period_start, inv.period_end,
    inv.cycles_covered, (p_invoice ->> 'subtotal_cents')::bigint, coalesce((p_invoice ->> 'credit_applied_cents')::bigint, 0),
    (p_invoice ->> 'total_cents')::bigint, p_invoice -> 'calculation', p_due_date, p_actor_id, now(),
    inv.id, inv.revision + 1, inv.branding_snapshot
  )
  returning id into v_new_id;
  for v_line in select * from jsonb_array_elements(p_invoice -> 'lines') loop
    insert into public.invoice_lines (owner_id, invoice_id, line_type, description, quantity, rate_cents, amount_cents,
                                      sort_order, credit_id)
    values (t.owner_id, v_new_id, (v_line ->> 'line_type')::public.invoice_line_type, v_line ->> 'description',
            coalesce((v_line ->> 'quantity')::bigint, 1), (v_line ->> 'rate_cents')::bigint, (v_line ->> 'amount_cents')::bigint,
            v_sort, nullif(v_line ->> 'credit_id', '')::uuid);
    v_sort := v_sort + 1;
  end loop;
  v_no := app.assign_invoice_number(v_new_id);
  update public.invoices set status = 'AWAITING_PAYMENT', issued_at = now() where id = v_new_id;
  update public.invoices set cancel_reason = format('Corrected: replaced by %s. %s', v_no, btrim(p_reason)) where id = inv.id;

  -- 4. Corrected readings: a new confirmed owner reading replaces the old one, which is
  --    kept (SUPERSEDED) with its values; the customer's values stay on record.
  if p_readings is not null then
    update public.meter_submissions set status = 'SUPERSEDED' where id = s.id;
    insert into public.meter_submissions (owner_id, ticket_id, customer_id, attempt_no, source, status, idempotency_key,
                                          submitted_by, note, anomaly_flag, invoice_id, reviewed_by, reviewed_at)
    values (t.owner_id, t.id, t.customer_id,
            (select coalesce(max(x.attempt_no), 0) + 1 from public.meter_submissions x where x.ticket_id = t.id),
            'OWNER_MANUAL', 'CONFIRMED', gen_random_uuid(), p_actor_id,
            format('Corrected after confirmation: %s', btrim(p_reason)), p_invoice -> 'calculation' ->> 'anomaly',
            v_new_id, p_actor_id, now())
    returning id into v_sub_id;
    for v_reading in select * from jsonb_array_elements(p_readings) loop
      select r.current_value into v_old_current from public.meter_readings r
      where r.submission_id = s.id and r.counter_type = (v_reading ->> 'counter_type')::public.counter_type;
      insert into public.meter_readings (owner_id, submission_id, counter_type, previous_value, current_value, rolled_over,
                                         corrected_from_value, correction_note, rollover_confirmed_by, rollover_confirmed_at)
      values (t.owner_id, v_sub_id, (v_reading ->> 'counter_type')::public.counter_type,
              (v_reading ->> 'previous_value')::bigint, (v_reading ->> 'current_value')::bigint,
              coalesce((v_reading ->> 'rolled_over')::boolean, false),
              case when v_old_current is distinct from (v_reading ->> 'current_value')::bigint then v_old_current end,
              case when v_old_current is distinct from (v_reading ->> 'current_value')::bigint then btrim(p_reason) end,
              case when coalesce((v_reading ->> 'rolled_over')::boolean, false) then p_actor_id end,
              case when coalesce((v_reading ->> 'rolled_over')::boolean, false) then now() end);
    end loop;
  end if;

  -- 5. The ticket carries the corrected invoice and asks for payment of it.
  update public.billing_cycle_tickets set current_invoice_id = v_new_id where id = t.id;
  select * into t from public.billing_cycle_tickets where id = t.id;
  v_was_disputed := t.status = 'DISPUTED';
  v_meta := jsonb_build_object('invoice_id', v_new_id, 'invoice_no', v_no, 'replaces_invoice_id', inv.id,
                               'replaces_invoice_no', inv.invoice_no, 'total_from', inv.total_cents,
                               'total_to', (p_invoice ->> 'total_cents')::bigint, 'paid_credit_cents', inv.amount_paid_cents,
                               'revision', inv.revision + 1, 'readings_changed', p_readings is not null,
                               'due_date', p_due_date);
  perform app.insert_ticket_event(t, 'CORRECTION', t.status, p_actor_id, p_reason, v_meta);
  if v_was_disputed then
    update public.disputes
    set status = 'RESOLVED', resolution_kind = 'CORRECTED', resolution = btrim(p_reason), resolved_by = p_actor_id,
        resolved_at = now(), replacement_invoice_id = v_new_id
    where ticket_id = t.id and status = 'OPEN';
  end if;
  if t.status = 'AWAITING_PAYMENT' then
    perform app.enter_stage(t.id, 'AWAITING_PAYMENT', p_stage_due_at);
  else
    t := app.ticket_hop(t.id, 'AWAITING_PAYMENT', p_actor_id, p_reason, v_meta, p_stage_due_at);
  end if;
  t := app.close_if_settled(t.id, p_actor_id, 'Paid in full by credit', v_meta);

  perform app.write_audit(p_actor_id, 'INVOICE_CORRECTED', 'invoice', v_new_id, t.owner_id,
                          v_meta || jsonb_build_object('ticket_id', t.id, 'reason', btrim(p_reason), 'dispute', v_was_disputed));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('ticket_id', t.id, 'status', t.status, 'invoice_id', v_new_id, 'invoice_no', v_no,
                            'old_invoice_id', inv.id, 'old_invoice_no', inv.invoice_no,
                            'total_cents', (p_invoice ->> 'total_cents')::bigint, 'paid_credit_cents', inv.amount_paid_cents);
end;
$$;

-- =============================================================================
-- F. Resend an invoice notification (11.4: "Owner can resend")
-- =============================================================================
create function app.resend_invoice_notification(
  p_invoice_id uuid,
  p_actor_id uuid,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  t public.billing_cycle_tickets;
begin
  perform app.set_actor(p_actor_id);
  select * into inv from public.invoices where id = p_invoice_id;
  if not found then
    perform app.fail('RD404', 'Invoice not found');
  end if;
  t := app.lock_ticket(inv.ticket_id);
  perform app.assert_actor(p_actor_id, t.owner_id, t.customer_id, array['OWNER']::public.user_role[]);
  if inv.invoice_no is null or inv.status in ('DRAFT', 'REJECTED', 'CANCELLED') then
    perform app.fail('RD409', 'Only an issued invoice can be sent again');
  end if;
  if exists (select 1 from public.ticket_events e
             where e.ticket_id = t.id and e.event_type = 'NOTE' and e.metadata ->> 'kind' = 'INVOICE_RESENT'
               and e.metadata ->> 'invoice_id' = inv.id::text and e.created_at > now() - interval '10 minutes') then
    perform app.fail('RD409', 'RESENT_RECENTLY: This invoice was sent again a few minutes ago');
  end if;
  perform app.insert_ticket_event(t, 'NOTE', t.status, p_actor_id, null,
    jsonb_build_object('kind', 'INVOICE_RESENT', 'invoice_id', inv.id, 'invoice_no', inv.invoice_no));
  perform app.write_audit(p_actor_id, 'INVOICE_NOTIFICATION_RESENT', 'invoice', inv.id, t.owner_id, jsonb_build_object('ticket_id', t.id));
  perform app.enqueue_notifications(t.owner_id, p_notifications, 'billing_cycle_ticket', t.id);
  return jsonb_build_object('invoice_id', inv.id, 'ticket_id', t.id);
end;
$$;

-- =============================================================================
-- G. Admin alerts for the daily job (11.7: "Scheduler fails or runs late: Admin alerted")
-- =============================================================================
-- Platform notifications (owner_id null) sent once per key.
create function app.notify_admins_once(p_dedupe_key text, p_notifications jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  perform app.set_actor(null);
  if coalesce(btrim(p_dedupe_key), '') = '' then
    perform app.fail('RD400', 'A key is required');
  end if;
  perform pg_advisory_xact_lock(hashtext('rentdesk.notify.platform.' || p_dedupe_key));
  if exists (select 1 from public.notifications n where n.owner_id is null and n.data ->> 'dedupe_key' = p_dedupe_key) then
    return jsonb_build_object('skipped', true);
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_notifications, '[]'::jsonb)) x
             where not exists (select 1 from public.profiles p where p.id = (x ->> 'user_id')::uuid and p.role = 'ADMIN')) then
    perform app.fail('RD400', 'Platform alerts go to admins only');
  end if;
  select coalesce(jsonb_agg(x || jsonb_build_object('data', coalesce(x -> 'data', '{}'::jsonb)
                                                    || jsonb_build_object('dedupe_key', p_dedupe_key))), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(coalesce(p_notifications, '[]'::jsonb)) x;
  return jsonb_build_object('sent', app.enqueue_notifications(null, v_items, 'cron_run', null));
end;
$$;

-- The latest finished run (success or partial) before p_before, other than p_run_id.
create function app.cron_last_success(p_job text, p_before timestamptz, p_run_id uuid) returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(r.run_now) from public.cron_runs r
  where r.job = p_job and r.status in ('SUCCESS', 'PARTIAL') and r.id is distinct from p_run_id and r.run_now < p_before;
$$;

-- =============================================================================
-- H. Grants and public.rpc_* wrappers (service role only)
-- =============================================================================
revoke all on function
  app.carried_copies(uuid, public.counter_type),
  app.verify_carried_copies(uuid, jsonb),
  app.record_meter_baseline(uuid, uuid, text, jsonb, jsonb),
  app.add_ticket_comment(uuid, uuid, uuid, text, jsonb),
  app.edit_ticket_comment(uuid, uuid, text),
  app.dispute_closing(),
  app.dispute_closed(),
  app.cron_orphan_dispute_files(timestamptz, integer),
  app.close_if_settled(uuid, uuid, text, jsonb),
  app.raise_dispute(uuid, uuid, uuid, text, jsonb, jsonb),
  app.open_dispute(public.billing_cycle_tickets, uuid),
  app.reject_dispute(uuid, uuid, text, date, timestamptz, jsonb),
  app.credit_dispute(uuid, uuid, text, uuid, bigint, jsonb, bigint, timestamptz, jsonb),
  app.request_dispute_photo(uuid, uuid, text, jsonb),
  app.submit_dispute_photo(uuid, uuid, jsonb, jsonb, jsonb),
  app.verify_corrected_invoice(public.invoices, jsonb, jsonb),
  app.correct_issued_invoice(uuid, uuid, uuid, text, jsonb, jsonb, uuid, date, timestamptz, jsonb),
  app.resend_invoice_notification(uuid, uuid, jsonb),
  app.notify_admins_once(text, jsonb),
  app.cron_last_success(text, timestamptz, uuid)
from public, anon, authenticated;

grant execute on function
  app.carried_copies(uuid, public.counter_type),
  app.record_meter_baseline(uuid, uuid, text, jsonb, jsonb),
  app.add_ticket_comment(uuid, uuid, uuid, text, jsonb),
  app.edit_ticket_comment(uuid, uuid, text),
  app.cron_orphan_dispute_files(timestamptz, integer),
  app.raise_dispute(uuid, uuid, uuid, text, jsonb, jsonb),
  app.reject_dispute(uuid, uuid, text, date, timestamptz, jsonb),
  app.credit_dispute(uuid, uuid, text, uuid, bigint, jsonb, bigint, timestamptz, jsonb),
  app.request_dispute_photo(uuid, uuid, text, jsonb),
  app.submit_dispute_photo(uuid, uuid, jsonb, jsonb, jsonb),
  app.correct_issued_invoice(uuid, uuid, uuid, text, jsonb, jsonb, uuid, date, timestamptz, jsonb),
  app.resend_invoice_notification(uuid, uuid, jsonb),
  app.notify_admins_once(text, jsonb),
  app.cron_last_success(text, timestamptz, uuid)
to service_role;

create function public.rpc_carried_copies(p_agreement_id uuid, p_counter public.counter_type) returns bigint
language sql set search_path = '' as $$
  select app.carried_copies(p_agreement_id, p_counter);
$$;

create function public.rpc_record_meter_baseline(
  p_agreement_id uuid, p_actor_id uuid, p_reason text, p_counters jsonb, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.record_meter_baseline(p_agreement_id, p_actor_id, p_reason, p_counters, p_notifications);
$$;

create function public.rpc_add_ticket_comment(
  p_ticket_id uuid, p_actor_id uuid, p_idempotency_key uuid, p_body text, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.add_ticket_comment(p_ticket_id, p_actor_id, p_idempotency_key, p_body, p_notifications);
$$;

create function public.rpc_edit_ticket_comment(p_comment_id uuid, p_actor_id uuid, p_body text) returns jsonb
language sql set search_path = '' as $$
  select app.edit_ticket_comment(p_comment_id, p_actor_id, p_body);
$$;

create function public.rpc_cron_orphan_dispute_files(p_now timestamptz, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_orphan_dispute_files(p_now, p_limit);
$$;

create function public.rpc_raise_dispute(
  p_ticket_id uuid, p_actor_id uuid, p_idempotency_key uuid, p_reason text, p_attachment jsonb default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.raise_dispute(p_ticket_id, p_actor_id, p_idempotency_key, p_reason, p_attachment, p_notifications);
$$;

create function public.rpc_reject_dispute(
  p_ticket_id uuid, p_actor_id uuid, p_reason text, p_due_date date, p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.reject_dispute(p_ticket_id, p_actor_id, p_reason, p_due_date, p_stage_due_at, p_notifications);
$$;

create function public.rpc_credit_dispute(
  p_ticket_id uuid, p_actor_id uuid, p_reason text, p_credit_id uuid, p_amount_cents bigint, p_line jsonb,
  p_total_cents bigint, p_stage_due_at timestamptz, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.credit_dispute(p_ticket_id, p_actor_id, p_reason, p_credit_id, p_amount_cents, p_line, p_total_cents,
                            p_stage_due_at, p_notifications);
$$;

create function public.rpc_request_dispute_photo(
  p_ticket_id uuid, p_actor_id uuid, p_note text, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.request_dispute_photo(p_ticket_id, p_actor_id, p_note, p_notifications);
$$;

create function public.rpc_submit_dispute_photo(
  p_ticket_id uuid, p_actor_id uuid, p_photo jsonb, p_readings jsonb, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.submit_dispute_photo(p_ticket_id, p_actor_id, p_photo, p_readings, p_notifications);
$$;

create function public.rpc_correct_issued_invoice(
  p_ticket_id uuid, p_actor_id uuid, p_invoice_id uuid, p_reason text, p_readings jsonb, p_invoice jsonb,
  p_paid_credit_id uuid, p_due_date date, p_stage_due_at timestamptz, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.correct_issued_invoice(p_ticket_id, p_actor_id, p_invoice_id, p_reason, p_readings, p_invoice,
                                    p_paid_credit_id, p_due_date, p_stage_due_at, p_notifications);
$$;

create function public.rpc_resend_invoice_notification(
  p_invoice_id uuid, p_actor_id uuid, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.resend_invoice_notification(p_invoice_id, p_actor_id, p_notifications);
$$;

create function public.rpc_notify_admins_once(p_dedupe_key text, p_notifications jsonb) returns jsonb
language sql set search_path = '' as $$
  select app.notify_admins_once(p_dedupe_key, p_notifications);
$$;

create function public.rpc_cron_last_success(p_job text, p_before timestamptz, p_run_id uuid) returns timestamptz
language sql set search_path = '' as $$
  select app.cron_last_success(p_job, p_before, p_run_id);
$$;

revoke execute on function
  public.rpc_carried_copies(uuid, public.counter_type),
  public.rpc_record_meter_baseline(uuid, uuid, text, jsonb, jsonb),
  public.rpc_add_ticket_comment(uuid, uuid, uuid, text, jsonb),
  public.rpc_edit_ticket_comment(uuid, uuid, text),
  public.rpc_cron_orphan_dispute_files(timestamptz, integer),
  public.rpc_raise_dispute(uuid, uuid, uuid, text, jsonb, jsonb),
  public.rpc_reject_dispute(uuid, uuid, text, date, timestamptz, jsonb),
  public.rpc_credit_dispute(uuid, uuid, text, uuid, bigint, jsonb, bigint, timestamptz, jsonb),
  public.rpc_request_dispute_photo(uuid, uuid, text, jsonb),
  public.rpc_submit_dispute_photo(uuid, uuid, jsonb, jsonb, jsonb),
  public.rpc_correct_issued_invoice(uuid, uuid, uuid, text, jsonb, jsonb, uuid, date, timestamptz, jsonb),
  public.rpc_resend_invoice_notification(uuid, uuid, jsonb),
  public.rpc_notify_admins_once(text, jsonb),
  public.rpc_cron_last_success(text, timestamptz, uuid)
from public, anon, authenticated;
grant execute on function
  public.rpc_carried_copies(uuid, public.counter_type),
  public.rpc_record_meter_baseline(uuid, uuid, text, jsonb, jsonb),
  public.rpc_add_ticket_comment(uuid, uuid, uuid, text, jsonb),
  public.rpc_edit_ticket_comment(uuid, uuid, text),
  public.rpc_cron_orphan_dispute_files(timestamptz, integer),
  public.rpc_raise_dispute(uuid, uuid, uuid, text, jsonb, jsonb),
  public.rpc_reject_dispute(uuid, uuid, text, date, timestamptz, jsonb),
  public.rpc_credit_dispute(uuid, uuid, text, uuid, bigint, jsonb, bigint, timestamptz, jsonb),
  public.rpc_request_dispute_photo(uuid, uuid, text, jsonb),
  public.rpc_submit_dispute_photo(uuid, uuid, jsonb, jsonb, jsonb),
  public.rpc_correct_issued_invoice(uuid, uuid, uuid, text, jsonb, jsonb, uuid, date, timestamptz, jsonb),
  public.rpc_resend_invoice_notification(uuid, uuid, jsonb),
  public.rpc_notify_admins_once(text, jsonb),
  public.rpc_cron_last_success(text, timestamptz, uuid)
to service_role;
