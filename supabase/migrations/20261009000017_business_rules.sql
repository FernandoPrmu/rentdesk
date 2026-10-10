-- =============================================================================
-- 0017 Client business-rule decisions (docs/decisions.md, spec section 18).
--
--   A  Rule 1: cycles are MONTHLY on the day of the first billing date (the last
--      day of the month when that day does not exist, never drifting). The
--      agreement's cycle_length_days is dropped; tickets keep cycle_length_days
--      as the real number of days of their cycle. billing_day = that day.
--   B  Rule 4 / RET-01: a machine can be returned with unpaid invoices. The
--      return issues the final invoice (billing engine, prorated by real days or
--      full) and leaves unpaid invoices payable. Only a meter reading waiting for
--      the owner's review blocks a return.
--   C  Rule 13: available customer credits are added automatically to every new
--      invoice (CREDIT lines linked to the credit). Drafts reserve them; the owner
--      can remove one from a draft (it stays available), audited.
--   D  LATE-01: late fee per agreement (owner default / custom amount / none),
--      versioned in agreement_terms_history and snapshot on each ticket.
--   E  DEP-01..04: money received at assignment. ADVANCE_PAYMENT becomes a credit
--      (kind ADVANCE); SECURITY_DEPOSIT is held in deposit_transactions (never a
--      credit) and settled on return or later: deduct from unpaid invoices
--      (payments of method SECURITY_DEPOSIT), refund, retain with a reason.
--      Deduct + refund + retain = held, always.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- "Rs. 10,000" / "Rs. 2.50" for notification texts (same as formatRupees).
create function app.format_rupees(p_cents bigint) returns text
language sql
immutable
set search_path = ''
as $$
  select 'Rs. ' || to_char(p_cents / 100, 'FM999,999,999,999,990')
         || case when p_cents % 100 <> 0 then '.' || lpad((p_cents % 100)::text, 2, '0') else '' end;
$$;

-- =============================================================================
-- A. Monthly cycle calendar (mirrored by src/lib/agreements/cycle-calendar.ts)
-- =============================================================================

-- Cycle n is due on first_billing_date + (n - 1) months. Postgres keeps the day of
-- the month and uses the month's last day when it does not exist; counting from
-- the first billing date every time means no drift (Jan 31, Feb 28, Mar 31).
-- Cycle 0 = one month before the first billing date.
create function app.cycle_date(p_first_billing_date date, p_cycle_no integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select (p_first_billing_date + make_interval(months => p_cycle_no - 1))::date;
$$;

-- Real calendar days of cycle n (28 to 31): proration uses these.
create function app.cycle_days(p_first_billing_date date, p_cycle_no integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select app.cycle_date(p_first_billing_date, p_cycle_no) - app.cycle_date(p_first_billing_date, p_cycle_no - 1);
$$;

-- The cycle whose usage period contains p_today: the first cycle due after it.
create function app.cycle_in_progress(p_first_billing_date date, p_today date)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_today < p_first_billing_date then 1
    when app.cycle_date(p_first_billing_date, x.m + 1) <= p_today then x.m + 2
    else x.m + 1
  end
  from (
    select ((extract(year from p_today) - extract(year from p_first_billing_date)) * 12
            + extract(month from p_today) - extract(month from p_first_billing_date))::integer as m
  ) x;
$$;

-- Agreement write rules (replaces 0014's): monthly calendar, billing_day kept in
-- step with the first billing date, cycle length gone.
create or replace function app.rental_agreement_before_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_machine public.machines;
begin
  select * into v_machine from public.machines m where m.id = new.machine_id;

  if v_machine.type = 'COLOUR' and (new.colour_included is null or new.colour_rate_cents is null) then
    raise exception using errcode = 'RD400', message = 'Colour machines need colour included copies and a colour rate';
  end if;
  if v_machine.type = 'MONO' and (new.colour_included is not null or new.colour_rate_cents is not null
                                  or new.initial_colour_reading is not null or new.closing_colour_reading is not null) then
    raise exception using errcode = 'RD400', message = 'Mono machines cannot have colour terms or readings';
  end if;
  if v_machine.type = 'COLOUR' and new.initial_colour_reading is null then
    new.initial_colour_reading := 0;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'TERMINATED' and v_machine.status <> 'AVAILABLE' then
      raise exception using errcode = 'RD409',
        message = format('Only an available machine can be assigned (this one is %s)', v_machine.status);
    end if;
    -- First ticket on first_billing_date (default: one month after the start).
    new.first_billing_date := coalesce(new.first_billing_date, (new.start_date + interval '1 month')::date);
    new.next_cycle_no := 1;
    new.next_cycle_date := new.first_billing_date;
  else
    if new.owner_id <> old.owner_id or new.customer_id <> old.customer_id or new.machine_id <> old.machine_id
       or new.start_date <> old.start_date or new.first_billing_date <> old.first_billing_date
       or new.initial_bw_reading <> old.initial_bw_reading
       or new.initial_colour_reading is distinct from old.initial_colour_reading then
      raise exception using errcode = 'RD400',
        message = 'Customer, machine, start date, first billing date and initial readings cannot be changed';
    end if;
    if old.status = 'TERMINATED' and new.status <> 'TERMINATED' then
      raise exception using errcode = 'RD409', message = 'A terminated agreement cannot be reactivated';
    end if;
  end if;

  -- Bills on this day of the month (the last day when the month is shorter).
  new.billing_day := extract(day from new.first_billing_date)::smallint;
  if new.status = 'TERMINATED' and new.terminated_at is null then
    new.terminated_at := now();
  end if;
  return new;
end;
$$;

alter table public.rental_agreements drop column cycle_length_days;
comment on column public.rental_agreements.billing_day is
  'Day of the month cycles are due: the day of first_billing_date (the last day in shorter months). Set by trigger.';
comment on column public.rental_agreements.first_billing_date is
  'Cycle 1 date. Cycle n is due on first_billing_date + (n - 1) months (monthly, no drift).';
comment on column public.billing_cycle_tickets.cycle_length_days is
  'Real calendar days of this cycle (28 to 31), snapshot when the ticket is created.';

-- Existing agreements move to the monthly calendar from the next cycle on.
update public.rental_agreements
set next_cycle_date = app.cycle_date(first_billing_date, next_cycle_no);

-- The per-owner and platform default cycle length are gone too.
drop view public.owner_settings_effective;
alter table public.owner_settings drop column default_cycle_length_days;
alter table public.platform_settings drop column default_cycle_length_days;

create view public.owner_settings_effective
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
  coalesce(s.weekly_summary_dow, p.weekly_summary_dow) as weekly_summary_dow
from public.owners o
cross join public.platform_settings p
left join public.owner_settings s on s.owner_id = o.id;

revoke all on public.owner_settings_effective from anon, authenticated;
grant select on public.owner_settings_effective to authenticated;

-- =============================================================================
-- D. Late fee per agreement (LATE-01)
-- =============================================================================
create type public.late_fee_mode as enum ('OWNER_DEFAULT', 'CUSTOM', 'NONE');

alter table public.rental_agreements
  add column late_fee_mode public.late_fee_mode not null default 'OWNER_DEFAULT',
  add column late_fee_cents bigint check (late_fee_cents >= 0),
  add constraint rental_agreements_late_fee check ((late_fee_mode = 'CUSTOM') = (late_fee_cents is not null));
alter table public.agreement_terms_history
  add column late_fee_mode public.late_fee_mode not null default 'OWNER_DEFAULT',
  add column late_fee_cents bigint check (late_fee_cents >= 0),
  add constraint agreement_terms_history_late_fee check ((late_fee_mode = 'CUSTOM') = (late_fee_cents is not null));
alter table public.billing_cycle_tickets
  add column late_fee_mode public.late_fee_mode not null default 'OWNER_DEFAULT',
  add column late_fee_cents bigint check (late_fee_cents >= 0),
  add constraint billing_cycle_tickets_late_fee check ((late_fee_mode = 'CUSTOM') = (late_fee_cents is not null));

comment on column public.rental_agreements.late_fee_mode is
  'OWNER_DEFAULT: owner settings, else platform. CUSTOM: late_fee_cents (even when the owner''s late fee is off). NONE: never.';

-- Version 1 also carries the late fee setting.
create or replace function app.rental_agreement_initial_terms() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.agreement_terms_history (
    owner_id, agreement_id, version, effective_from_cycle_no, monthly_commitment_cents,
    bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days,
    late_fee_mode, late_fee_cents, note, changed_by
  ) values (
    new.owner_id, new.id, 1, 1, new.monthly_commitment_cents, new.bw_included, new.bw_rate_cents,
    new.colour_included, new.colour_rate_cents, new.due_days,
    new.late_fee_mode, new.late_fee_cents, 'Initial terms', app.resolve_actor()
  );
  return null;
end;
$$;

-- Reads the late fee setting from JSON (assign / edit terms).
create function app.json_late_fee(p_value jsonb, p_mode_default public.late_fee_mode, p_cents_default bigint,
                                  out mode public.late_fee_mode, out cents bigint)
language plpgsql
immutable
set search_path = ''
as $$
begin
  mode := p_mode_default;
  cents := p_cents_default;
  if p_value ? 'late_fee_mode' then
    if coalesce(p_value ->> 'late_fee_mode', '') not in ('OWNER_DEFAULT', 'CUSTOM', 'NONE') then
      perform app.fail('RD400', 'Late fee must be OWNER_DEFAULT, CUSTOM or NONE');
    end if;
    mode := (p_value ->> 'late_fee_mode')::public.late_fee_mode;
    cents := case when mode = 'CUSTOM' then app.json_count(p_value, 'late_fee_cents', 'Late fee') end;
  end if;
  if mode = 'CUSTOM' and cents is null then
    perform app.fail('RD400', 'A custom late fee needs an amount');
  end if;
  if mode <> 'CUSTOM' then
    cents := null;
  end if;
end;
$$;

-- =============================================================================
-- C. Credits on invoices (rule 13)
-- =============================================================================
alter table public.credits
  add constraint credits_id_owner_key unique (id, owner_id),
  add column agreement_id uuid,
  add column received_on date,
  add column method public.payment_method,
  add column reference text check (length(reference) <= 100),
  add constraint credits_agreement_fkey foreign key (agreement_id, owner_id)
    references public.rental_agreements (id, owner_id);
create index credits_agreement_idx on public.credits (agreement_id, owner_id);
comment on column public.credits.agreement_id is 'Advance payments (DEP-02): the agreement it was received with.';

alter table public.invoice_lines
  add column credit_id uuid,
  add constraint invoice_lines_credit_line check (credit_id is null or line_type = 'CREDIT'),
  add constraint invoice_lines_credit_fkey foreign key (credit_id, owner_id)
    references public.credits (id, owner_id);
create index invoice_lines_credit_idx on public.invoice_lines (credit_id, owner_id) where credit_id is not null;
comment on column public.invoice_lines.credit_id is
  'The customer credit a CREDIT line uses (rule 13). Lines on live invoices (drafts too) reserve it.';

-- Amount of a credit used by live invoices (drafts reserve), except p_exclude_invoice.
create function app.credit_used(p_credit_id uuid, p_exclude_invoice uuid default null) returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(-l.amount_cents), 0)::bigint
  from public.invoice_lines l
  join public.invoices i on i.id = l.invoice_id
  where l.credit_id = p_credit_id
    and i.status not in ('REJECTED', 'CANCELLED')
    and i.id is distinct from p_exclude_invoice;
$$;

-- The customer's credits with something left, oldest first: [{id, available_cents}].
-- Same list as loadAvailableCredits (src/lib/billing/context.ts).
create function app.available_credits(p_customer_id uuid, p_exclude_invoice uuid default null) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'available_cents', x.available) order by x.created_at, x.id), '[]'::jsonb)
  from (
    select c.id, c.created_at, c.amount_cents - app.credit_used(c.id, p_exclude_invoice) as available
    from public.credits c
    where c.customer_id = p_customer_id and c.status = 'AVAILABLE'
  ) x
  where x.available > 0;
$$;

-- APPLIED once issued invoices use all of it; AVAILABLE again when such an invoice
-- is cancelled. Drafts only reserve (the credit stays AVAILABLE).
create function app.refresh_credit_status(p_credit_ids uuid[]) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.credits;
  v_used bigint;
  v_last uuid;
  v_status public.credit_status;
begin
  for c in select * from public.credits where id = any (p_credit_ids) and status <> 'REFUNDED' for update loop
    select coalesce(sum(-l.amount_cents), 0) into v_used
    from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
    where l.credit_id = c.id and i.status not in ('DRAFT', 'REJECTED', 'CANCELLED');
    v_status := case when v_used >= c.amount_cents then 'APPLIED' else 'AVAILABLE' end;
    if v_status = 'APPLIED' then
      select l.invoice_id into v_last
      from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
      where l.credit_id = c.id and i.status not in ('DRAFT', 'REJECTED', 'CANCELLED')
      order by i.issued_at desc nulls last, i.created_at desc
      limit 1;
    else
      v_last := null;
    end if;
    if v_status <> c.status or v_last is distinct from c.applied_to_invoice_id then
      update public.credits
      set status = v_status,
          applied_to_invoice_id = v_last,
          applied_at = case when v_status = 'APPLIED' then coalesce(applied_at, now()) end
      where id = c.id;
    end if;
  end loop;
end;
$$;

create function app.invoice_credit_status() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'invoices' then
    perform app.refresh_credit_status(array(
      select l.credit_id from public.invoice_lines l where l.invoice_id = new.id and l.credit_id is not null
    ));
  elsif tg_op = 'INSERT' and new.credit_id is not null then
    perform app.refresh_credit_status(array[new.credit_id]);
  elsif tg_op = 'DELETE' and old.credit_id is not null then
    perform app.refresh_credit_status(array[old.credit_id]);
  end if;
  return null;
end;
$$;

create trigger invoices_credit_status after update of status on public.invoices
  for each row when (old.status is distinct from new.status)
  execute function app.invoice_credit_status();
create trigger invoice_lines_credit_status after insert or delete on public.invoice_lines
  for each row execute function app.invoice_credit_status();

-- =============================================================================
-- E. Security deposits (DEP-01, DEP-03, DEP-04)
-- =============================================================================
create type public.deposit_transaction_kind as enum ('RECEIVED', 'DEDUCTED', 'REFUNDED', 'RETAINED');

create table public.deposit_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  customer_id uuid not null,
  agreement_id uuid not null,
  kind public.deposit_transaction_kind not null,
  amount_cents bigint not null check (amount_cents > 0),
  -- RECEIVED: date received; DEDUCTED: settlement date; REFUNDED: refund date; RETAINED: settlement date.
  occurred_on date not null,
  method public.payment_method,
  reference text check (length(reference) <= 100),
  -- RECEIVED: owner's note; RETAINED: the reason (required).
  note text check (length(note) <= 500),
  invoice_id uuid,
  payment_id uuid,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default clock_timestamp(),
  constraint deposit_transactions_method check (kind not in ('RECEIVED', 'REFUNDED', 'DEDUCTED') or method is not null),
  constraint deposit_transactions_retain_reason check (kind <> 'RETAINED' or coalesce(length(btrim(note)), 0) > 0),
  constraint deposit_transactions_deduction check ((kind = 'DEDUCTED') = (invoice_id is not null and payment_id is not null)),
  constraint deposit_transactions_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id),
  constraint deposit_transactions_agreement_fkey foreign key (agreement_id, owner_id)
    references public.rental_agreements (id, owner_id),
  constraint deposit_transactions_invoice_fkey foreign key (invoice_id, owner_id)
    references public.invoices (id, owner_id),
  constraint deposit_transactions_payment_fkey foreign key (payment_id, owner_id)
    references public.payments (id, owner_id)
);
comment on table public.deposit_transactions is
  'Security deposit ledger per agreement (DEP-01..04): received, deducted from invoices, refunded, retained. '
  'Held = received - the rest, never below zero. SERVER-WRITE-ONLY, append-only.';
create index deposit_transactions_owner_id_idx on public.deposit_transactions (owner_id);
create index deposit_transactions_agreement_idx on public.deposit_transactions (agreement_id, owner_id);
create index deposit_transactions_customer_idx on public.deposit_transactions (customer_id, owner_id);
create index deposit_transactions_invoice_idx on public.deposit_transactions (invoice_id, owner_id) where invoice_id is not null;
create index deposit_transactions_payment_idx on public.deposit_transactions (payment_id, owner_id) where payment_id is not null;
create index deposit_transactions_created_by_idx on public.deposit_transactions (created_by);

create trigger deposit_transactions_audit after insert or update or delete on public.deposit_transactions
  for each row execute function app.audit_row_change('all');

-- Amount held for an agreement right now.
create function app.deposit_held(p_agreement_id uuid) returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when d.kind = 'RECEIVED' then d.amount_cents else -d.amount_cents end), 0)::bigint
  from public.deposit_transactions d
  where d.agreement_id = p_agreement_id;
$$;

-- Same customer as the agreement; the balance never goes below zero.
create function app.deposit_transaction_check() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.rental_agreements a where a.id = new.agreement_id and a.customer_id = new.customer_id
  ) then
    perform app.fail('RD400', 'A deposit belongs to the agreement''s customer');
  end if;
  if app.deposit_held(new.agreement_id) < 0 then
    perform app.fail('RD400', 'More would leave the deposit than it holds');
  end if;
  return null;
end;
$$;

create trigger deposit_transactions_check after insert on public.deposit_transactions
  for each row execute function app.deposit_transaction_check();

-- New tables get no automatic grants in this project: server code (service role)
-- reads them explicitly; writes go through the workflow functions.
revoke all on public.deposit_transactions from anon, authenticated, service_role;
grant select on public.deposit_transactions to authenticated;
grant select, insert on public.deposit_transactions to service_role;
-- The final invoice on return reads the terms in force (loadReturnContext).
grant select on public.agreement_terms_history to service_role;
alter table public.deposit_transactions enable row level security;

create policy deposit_transactions_select on public.deposit_transactions for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);

-- Deposit per agreement (security_invoker: RLS on deposit_transactions decides).
create view public.agreement_deposit_balances
with (security_invoker = true) as
select d.owner_id,
       d.customer_id,
       d.agreement_id,
       coalesce(sum(d.amount_cents) filter (where d.kind = 'RECEIVED'), 0)::bigint as received_cents,
       coalesce(sum(d.amount_cents) filter (where d.kind = 'DEDUCTED'), 0)::bigint as deducted_cents,
       coalesce(sum(d.amount_cents) filter (where d.kind = 'REFUNDED'), 0)::bigint as refunded_cents,
       coalesce(sum(d.amount_cents) filter (where d.kind = 'RETAINED'), 0)::bigint as retained_cents,
       sum(case when d.kind = 'RECEIVED' then d.amount_cents else -d.amount_cents end)::bigint as held_cents
from public.deposit_transactions d
group by d.owner_id, d.customer_id, d.agreement_id;

revoke all on public.agreement_deposit_balances from anon, authenticated;
grant select on public.agreement_deposit_balances to authenticated, service_role;

-- Money received at assignment (DEP-01, DEP-02). p_entries: [{type, amount_cents,
-- received_on, method, reference?, note?}], type SECURITY_DEPOSIT | ADVANCE_PAYMENT.
create function app.record_upfront_money(a public.rental_agreements, p_actor_id uuid, p_entries jsonb, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_amount bigint;
  v_on date;
  v_method public.payment_method;
  v_reference text;
  v_note text;
  v_deposit bigint := 0;
  v_advance bigint := 0;
begin
  if p_entries is null or jsonb_typeof(p_entries) = 'null' then
    return jsonb_build_object('deposit_cents', 0, 'advance_cents', 0);
  end if;
  if jsonb_typeof(p_entries) <> 'array' then
    perform app.fail('RD400', 'Money received upfront must be a list');
  end if;
  if jsonb_array_length(p_entries) > 10 then
    perform app.fail('RD400', 'At most 10 upfront payments per agreement');
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries) loop
    v_amount := app.json_count(v_entry, 'amount_cents', 'Amount received');
    if v_amount is null or v_amount = 0 then
      perform app.fail('RD400', 'Each amount received must be more than 0');
    end if;
    v_on := nullif(v_entry ->> 'received_on', '')::date;
    if v_on is null or v_on > p_today then
      perform app.fail('RD400', 'The date received is required and cannot be in the future');
    end if;
    if coalesce(v_entry ->> 'method', '') not in ('BANK_TRANSFER', 'DEPOSIT', 'CASH', 'CHEQUE', 'ONLINE', 'OTHER') then
      perform app.fail('RD400', 'Choose how the money was paid');
    end if;
    v_method := (v_entry ->> 'method')::public.payment_method;
    v_reference := nullif(btrim(v_entry ->> 'reference'), '');
    v_note := nullif(btrim(v_entry ->> 'note'), '');

    case v_entry ->> 'type'
      when 'SECURITY_DEPOSIT' then
        insert into public.deposit_transactions (owner_id, customer_id, agreement_id, kind, amount_cents, occurred_on,
                                                 method, reference, note, created_by)
        values (a.owner_id, a.customer_id, a.id, 'RECEIVED', v_amount, v_on, v_method, v_reference, v_note, p_actor_id);
        v_deposit := v_deposit + v_amount;
      when 'ADVANCE_PAYMENT' then
        insert into public.credits (owner_id, customer_id, agreement_id, kind, amount_cents, reason,
                                    received_on, method, reference, created_by)
        values (a.owner_id, a.customer_id, a.id, 'ADVANCE', v_amount, coalesce(v_note, 'Advance payment'),
                v_on, v_method, v_reference, p_actor_id);
        v_advance := v_advance + v_amount;
      else
        perform app.fail('RD400', 'Type must be SECURITY_DEPOSIT or ADVANCE_PAYMENT');
    end case;
  end loop;
  return jsonb_build_object('deposit_cents', v_deposit, 'advance_cents', v_advance);
end;
$$;

-- Invoices a deposit may pay: unpaid, issued, no slip waiting, not disputed.
create function app.deposit_deductible_invoices(p_agreement_id uuid) returns setof public.invoices
language sql
stable
security definer
set search_path = ''
as $$
  select i.*
  from public.invoices i
  where i.agreement_id = p_agreement_id
    and i.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE')
    and i.total_cents > i.amount_paid_cents
    and not exists (select 1 from public.payments p where p.invoice_id = i.id and p.status = 'SUBMITTED')
  order by i.due_date nulls last, i.invoice_seq nulls last, i.id;
$$;

-- Settles the deposit held for a (locked) agreement (DEP-03/04). p_settlement:
--   { deduct_cents, refund_cents, refunded_on, refund_method, refund_reference,
--     retain_cents, retain_reason }
-- deduct + refund + retain must equal the amount held. Deductions pay unpaid
-- invoices oldest due first, each as an accepted payment of method SECURITY_DEPOSIT.
create function app.apply_deposit_settlement(a public.rental_agreements, p_actor_id uuid, p_settlement jsonb, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_held bigint := app.deposit_held(a.id);
  v_deduct bigint := coalesce(app.json_count(p_settlement, 'deduct_cents', 'Amount deducted'), 0);
  v_refund bigint := coalesce(app.json_count(p_settlement, 'refund_cents', 'Amount refunded'), 0);
  v_retain bigint := coalesce(app.json_count(p_settlement, 'retain_cents', 'Amount kept'), 0);
  v_refunded_on date := nullif(p_settlement ->> 'refunded_on', '')::date;
  v_method text := nullif(p_settlement ->> 'refund_method', '');
  v_reference text := nullif(btrim(p_settlement ->> 'refund_reference'), '');
  v_reason text := nullif(btrim(p_settlement ->> 'retain_reason'), '');
  v_deductible bigint;
  inv public.invoices;
  t public.billing_cycle_tickets;
  v_rest bigint;
  v_amount bigint;
  v_paid bigint;
  v_full boolean;
  v_payment_id uuid;
  v_to public.ticket_status;
  v_allocations jsonb := '[]'::jsonb;
begin
  if v_held <= 0 then
    perform app.fail('RD409', 'No deposit is held for this agreement');
  end if;
  if v_deduct + v_refund + v_retain <> v_held then
    perform app.fail('RD400', format('Deduct + refund + keep must equal the deposit held (%s); now %s',
                                     app.format_rupees(v_held), app.format_rupees(v_deduct + v_refund + v_retain)));
  end if;
  if v_refund > 0 then
    if v_refunded_on is null or v_refunded_on > p_today then
      perform app.fail('RD400', 'A refund needs the date it was paid (today or earlier)');
    end if;
    if v_method is null or v_method not in ('BANK_TRANSFER', 'DEPOSIT', 'CASH', 'CHEQUE', 'ONLINE', 'OTHER') then
      perform app.fail('RD400', 'Choose how the refund was paid');
    end if;
  end if;
  if v_retain > 0 and v_reason is null then
    perform app.fail('RD400', 'Give a reason for keeping part of the deposit');
  end if;

  select coalesce(sum(i.total_cents - i.amount_paid_cents), 0) into v_deductible
  from app.deposit_deductible_invoices(a.id) i;
  if v_deduct > v_deductible then
    perform app.fail('RD400', format('At most %s can be deducted (unpaid invoices without a slip waiting or a dispute)',
                                     app.format_rupees(v_deductible)));
  end if;

  v_rest := v_deduct;
  for inv in
    select i.* from public.invoices i
    where i.id in (select d.id from app.deposit_deductible_invoices(a.id) d)
    order by i.due_date nulls last, i.invoice_seq nulls last, i.id
    for update
  loop
    exit when v_rest = 0;
    t := app.lock_ticket(inv.ticket_id);
    v_amount := least(v_rest, inv.total_cents - inv.amount_paid_cents);
    v_rest := v_rest - v_amount;
    v_paid := inv.amount_paid_cents + v_amount;
    v_full := v_paid >= inv.total_cents;

    insert into public.payments (owner_id, invoice_id, ticket_id, customer_id, source, method, amount_cents,
                                 accepted_amount_cents, paid_on, reference, note, status, submitted_by,
                                 verified_by, verified_at)
    values (inv.owner_id, inv.id, inv.ticket_id, inv.customer_id, 'OWNER_MANUAL', 'SECURITY_DEPOSIT', v_amount,
            v_amount, p_today, 'Security deposit', 'Deducted from the security deposit',
            (case when v_full then 'ACCEPTED' else 'PARTIAL' end)::public.payment_status, p_actor_id, p_actor_id, now())
    returning id into v_payment_id;

    update public.invoices
    set amount_paid_cents = v_paid,
        status = (case when v_full then 'PAID' else 'PARTIALLY_PAID' end)::public.invoice_status
    where id = inv.id;

    insert into public.deposit_transactions (owner_id, customer_id, agreement_id, kind, amount_cents, occurred_on,
                                             method, reference, invoice_id, payment_id, created_by)
    values (a.owner_id, a.customer_id, a.id, 'DEDUCTED', v_amount, p_today, 'SECURITY_DEPOSIT', inv.invoice_no,
            inv.id, v_payment_id, p_actor_id);

    if t.current_invoice_id = inv.id and t.status not in ('CLOSED', 'CANCELLED') then
      v_to := case when v_full then 'CLOSED' else 'PARTIALLY_PAID' end;
      perform app.insert_ticket_event(t, 'STATUS_CHANGE', v_to, p_actor_id, 'Paid from the security deposit',
        jsonb_build_object('payment_id', v_payment_id, 'amount_cents', v_amount, 'method', 'SECURITY_DEPOSIT',
                           'balance_cents', inv.total_cents - v_paid));
      perform app.enter_stage(t.id, v_to, case when v_full then null else t.stage_due_at end);
      if v_full then
        update public.billing_cycle_tickets set closed_at = now(), closed_by = p_actor_id where id = t.id;
      end if;
    end if;

    v_allocations := v_allocations || jsonb_build_object('invoice_id', inv.id, 'invoice_no', inv.invoice_no,
      'amount_cents', v_amount, 'payment_id', v_payment_id, 'paid_in_full', v_full);
  end loop;

  if v_refund > 0 then
    insert into public.deposit_transactions (owner_id, customer_id, agreement_id, kind, amount_cents, occurred_on,
                                             method, reference, created_by)
    values (a.owner_id, a.customer_id, a.id, 'REFUNDED', v_refund, v_refunded_on, v_method::public.payment_method,
            v_reference, p_actor_id);
  end if;
  if v_retain > 0 then
    insert into public.deposit_transactions (owner_id, customer_id, agreement_id, kind, amount_cents, occurred_on,
                                             note, created_by)
    values (a.owner_id, a.customer_id, a.id, 'RETAINED', v_retain, p_today, v_reason, p_actor_id);
  end if;

  -- Defensive: the ledger must be settled exactly.
  if app.deposit_held(a.id) <> 0 then
    perform app.fail('RD400', 'The deposit settlement does not balance');
  end if;

  perform app.write_audit(p_actor_id, 'DEPOSIT_SETTLED', 'rental_agreements', a.id, a.owner_id,
    jsonb_build_object('held_cents', v_held, 'deduct_cents', v_deduct, 'refund_cents', v_refund,
                       'refund_method', v_method, 'refund_reference', v_reference, 'refunded_on', v_refunded_on,
                       'retain_cents', v_retain, 'retain_reason', v_reason, 'allocations', v_allocations));

  perform app.enqueue_notifications(
    a.owner_id,
    jsonb_build_array(jsonb_build_object(
      'user_id', a.customer_id,
      'event', 'deposit.settled',
      'title', 'Your security deposit was settled',
      'body', format('Deposit %s: %s paid your bills, %s refunded, %s kept%s.',
                     app.format_rupees(v_held), app.format_rupees(v_deduct), app.format_rupees(v_refund),
                     app.format_rupees(v_retain), case when v_reason is not null then ' (' || v_reason || ')' else '' end),
      'link', '/customer/bills'
    )),
    'rental_agreements',
    a.id
  );

  return jsonb_build_object('held_cents', v_held, 'deduct_cents', v_deduct, 'refund_cents', v_refund,
                            'retain_cents', v_retain, 'allocations', v_allocations);
end;
$$;

-- Settle later (client decision 2): on a returned agreement whose deposit is still held.
create function app.settle_deposit(p_actor_id uuid, p_agreement_id uuid, p_settlement jsonb, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.rental_agreements;
begin
  if p_today is null then
    perform app.fail('RD400', 'Today is required');
  end if;
  select * into a from public.rental_agreements where id = p_agreement_id for update;
  if not found then
    perform app.fail('RD404', 'Agreement not found');
  end if;
  perform app.assert_actor(p_actor_id, a.owner_id, null, array['OWNER']::public.user_role[]);
  perform app.set_actor(p_actor_id);
  if a.status <> 'TERMINATED' then
    perform app.fail('RD409', 'Settle the deposit when the machine is returned');
  end if;
  return app.apply_deposit_settlement(a, p_actor_id, p_settlement, p_today);
end;
$$;

-- =============================================================================
-- Invoice verification (one billing engine: the database only re-checks it)
-- =============================================================================

-- Arithmetic: every line = quantity x rate; lines add up to subtotal, credit, total.
create function app.verify_invoice_lines(p_invoice jsonb) returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_line jsonb;
  v_amount bigint;
  v_subtotal bigint := 0;
  v_credit bigint := 0;
begin
  if jsonb_typeof(p_invoice -> 'lines') is distinct from 'array' or jsonb_array_length(p_invoice -> 'lines') = 0 then
    perform app.fail('RD400', 'Invoice lines are required');
  end if;
  for v_line in select * from jsonb_array_elements(p_invoice -> 'lines') loop
    v_amount := (v_line ->> 'amount_cents')::bigint;
    if v_amount is distinct from (v_line ->> 'quantity')::bigint * (v_line ->> 'rate_cents')::bigint then
      perform app.fail('RD400', 'Every invoice line must be quantity x rate');
    end if;
    if v_line ->> 'line_type' = 'LATE_FEE' then
      perform app.fail('RD400', 'A new invoice has no late fee');
    elsif v_line ->> 'line_type' = 'CREDIT' then
      if v_amount > 0 then
        perform app.fail('RD400', 'A credit line cannot add to the invoice');
      end if;
      v_credit := v_credit - v_amount;
    else
      if v_line ->> 'credit_id' is not null then
        perform app.fail('RD400', 'Only a CREDIT line can use a credit');
      end if;
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

-- Rule 13: the calculation used exactly the customer's available credits (minus
-- the excluded ones), and no credit line uses more than its credit has left.
-- Locks the customer's credits, so two drafts never reserve the same money.
-- p_exclude_invoice: the draft being recalculated (its own lines do not count).
create function app.verify_invoice_credits(p_owner_id uuid, p_customer_id uuid, p_invoice jsonb, p_exclude_invoice uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c jsonb := p_invoice -> 'calculation';
  v_excluded jsonb := coalesce(c -> 'credits_excluded', '[]'::jsonb);
  v_listed jsonb := coalesce(c -> 'credits', '[]'::jsonb);
  v_expected jsonb;
  v_line jsonb;
  v_used jsonb := '{}'::jsonb;
  v_key text;
  v_recorded jsonb;
begin
  perform 1 from public.credits where customer_id = p_customer_id and owner_id = p_owner_id for update;

  if jsonb_typeof(v_excluded) <> 'array' or jsonb_typeof(v_listed) <> 'array' then
    perform app.fail('RD400', 'The calculation must list the credits');
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_excluded) e(id)
    where not exists (select 1 from public.credits x where x.id::text = e.id and x.customer_id = p_customer_id)
  ) then
    perform app.fail('RD400', 'A removed credit is not this customer''s');
  end if;

  select coalesce(jsonb_agg(x order by ord), '[]'::jsonb) into v_expected
  from jsonb_array_elements(app.available_credits(p_customer_id, p_exclude_invoice)) with ordinality as t(x, ord)
  where not (v_excluded ? (x ->> 'id'));
  if v_expected is distinct from v_listed then
    perform app.fail('RD409', 'The customer''s credits have changed; recalculate the invoice');
  end if;

  for v_line in select * from jsonb_array_elements(p_invoice -> 'lines') loop
    v_key := v_line ->> 'credit_id';
    if v_key is not null then
      v_used := jsonb_set(v_used, array[v_key],
                          to_jsonb(coalesce((v_used ->> v_key)::bigint, 0) - (v_line ->> 'amount_cents')::bigint));
    end if;
  end loop;
  for v_key in select jsonb_object_keys(v_used) loop
    if not exists (
      select 1 from jsonb_array_elements(v_expected) x
      where x ->> 'id' = v_key and (x ->> 'available_cents')::bigint >= (v_used ->> v_key)::bigint
    ) then
      perform app.fail('RD400', 'A credit line uses more than the credit has left');
    end if;
  end loop;

  select coalesce(jsonb_object_agg(x ->> 'id', (x ->> 'amount_cents')::bigint), '{}'::jsonb) into v_recorded
  from jsonb_array_elements(coalesce(c -> 'credits_applied', '[]'::jsonb)) x;
  if v_recorded is distinct from v_used then
    perform app.fail('RD400', 'The credit lines do not match the calculation');
  end if;
end;
$$;

-- Meter invoices (replaces 0015's): readings, terms and cycles as before; the
-- arithmetic now also covers credit lines.
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
  if p_anomaly_flag is distinct from (c ->> 'anomaly') then
    perform app.fail('RD400', 'The anomaly flag does not match the calculation');
  end if;

  perform app.verify_invoice_lines(p_invoice);
end;
$$;

-- The facts of a final invoice on p_today (RET-01). Mirrors finalCycle in
-- src/lib/agreements/cycle-calendar.ts.
create function app.final_cycle(p_agreement_id uuid, p_today date) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.rental_agreements;
  v_k integer;
  v_last integer;
  v_start date;
  v_first_start date;
  v_days integer;
begin
  select * into a from public.rental_agreements where id = p_agreement_id;
  v_k := app.cycle_in_progress(a.first_billing_date, p_today);
  select coalesce(max(t.cycle_no), 0) into v_last
  from public.meter_submissions s
  join public.billing_cycle_tickets t on t.id = s.ticket_id
  where t.agreement_id = a.id and s.status = 'CONFIRMED';
  v_start := app.cycle_date(a.first_billing_date, v_k - 1);
  if v_k = 1 then
    v_start := greatest(v_start, a.start_date);
  end if;
  -- Start of the first cycle the invoice covers.
  v_first_start := app.cycle_date(a.first_billing_date, least(v_last + 1, v_k) - 1);
  if least(v_last + 1, v_k) = 1 then
    v_first_start := greatest(v_first_start, a.start_date);
  end if;
  v_days := p_today - v_start + 1;
  return jsonb_build_object(
    'cycle_no', v_k,
    'last_confirmed_cycle', v_last,
    'full_cycles', greatest(0, v_k - 1 - v_last),
    'period_start', v_start,
    'invoice_period_start', v_first_start,
    'days_used', greatest(0, v_days),
    'days_in_cycle', app.cycle_days(a.first_billing_date, v_k),
    'billable', v_days >= 1
  );
end;
$$;

-- The final invoice built by the engine matches the agreement's facts.
create function app.verify_final_invoice(
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
  if p_anomaly_flag is distinct from (c ->> 'anomaly') then
    perform app.fail('RD400', 'The anomaly flag does not match the calculation');
  end if;

  perform app.verify_invoice_lines(p_invoice);
end;
$$;

-- =============================================================================
-- submit_meter_reading (replaces 0015's): credits are checked and linked.
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
  v_existing public.meter_submissions;
  v_to constant public.ticket_status := 'PENDING_OWNER_REVIEW';
  v_submission_id uuid;
  v_invoice_id uuid;
  v_attempt smallint;
  v_reading jsonb;
  v_line jsonb;
  v_sort smallint := 0;
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

-- =============================================================================
-- Rule 13: the owner removes a credit from a draft (or adds it back) before
-- confirming. The server recalculates with the engine; this checks that only
-- the customer-credit lines changed, then swaps them. Audited.
-- =============================================================================
create function app.set_invoice_credit(
  p_actor_id uuid,
  p_invoice_id uuid,
  p_credit_id uuid,
  p_include boolean,
  p_note text,
  p_invoice jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  t public.billing_cycle_tickets;
  v_old_excluded jsonb;
  v_new_excluded jsonb;
  v_expected jsonb;
  v_old_lines jsonb;
  v_new_lines jsonb;
  v_line jsonb;
  v_sort smallint;
begin
  if p_include is null then
    perform app.fail('RD400', 'Choose to remove or add back the credit');
  end if;
  select * into inv from public.invoices where id = p_invoice_id;
  if not found then
    perform app.fail('RD404', 'Invoice not found');
  end if;
  t := app.lock_ticket(inv.ticket_id);
  select * into inv from public.invoices where id = p_invoice_id for update;
  perform app.assert_actor(p_actor_id, inv.owner_id, inv.customer_id, array['OWNER']::public.user_role[]);
  perform app.set_actor(p_actor_id);
  if inv.status <> 'DRAFT' or t.status <> 'PENDING_OWNER_REVIEW' or t.current_invoice_id is distinct from inv.id then
    perform app.fail('RD409', 'Credits can only be changed on a draft waiting for your review');
  end if;
  if not exists (select 1 from public.credits c where c.id = p_credit_id and c.customer_id = inv.customer_id) then
    perform app.fail('RD404', 'Credit not found');
  end if;

  v_old_excluded := coalesce(inv.calculation -> 'credits_excluded', '[]'::jsonb);
  if p_include and not (v_old_excluded ? p_credit_id::text) then
    perform app.fail('RD409', 'This credit is already on the invoice');
  end if;
  if not p_include and (v_old_excluded ? p_credit_id::text) then
    perform app.fail('RD409', 'This credit was already removed');
  end if;
  select coalesce(jsonb_agg(e order by e), '[]'::jsonb) into v_expected
  from (
    select e from jsonb_array_elements_text(v_old_excluded) e where e <> p_credit_id::text
    union all
    select p_credit_id::text where not p_include
  ) x(e);
  select coalesce(jsonb_agg(e order by e), '[]'::jsonb) into v_new_excluded
  from jsonb_array_elements_text(coalesce(p_invoice -> 'calculation' -> 'credits_excluded', '[]'::jsonb)) e;
  if v_new_excluded is distinct from v_expected then
    perform app.fail('RD400', 'The recalculated invoice does not reflect this change');
  end if;

  -- Everything but the customer credits is unchanged.
  if (inv.calculation - 'credits' - 'credits_excluded' - 'credits_applied')
     is distinct from ((p_invoice -> 'calculation') - 'credits' - 'credits_excluded' - 'credits_applied')
     or (p_invoice ->> 'subtotal_cents')::bigint is distinct from inv.subtotal_cents then
    perform app.fail('RD409', 'The invoice changed in other ways; reload it');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('line_type', l.line_type, 'description', l.description,
                                               'quantity', l.quantity, 'rate_cents', l.rate_cents,
                                               'amount_cents', l.amount_cents) order by l.sort_order), '[]'::jsonb)
  into v_old_lines
  from public.invoice_lines l where l.invoice_id = inv.id and l.credit_id is null;
  select coalesce(jsonb_agg(jsonb_build_object('line_type', x ->> 'line_type', 'description', x ->> 'description',
                                               'quantity', (x ->> 'quantity')::bigint, 'rate_cents', (x ->> 'rate_cents')::bigint,
                                               'amount_cents', (x ->> 'amount_cents')::bigint) order by ord), '[]'::jsonb)
  into v_new_lines
  from jsonb_array_elements(p_invoice -> 'lines') with ordinality as q(x, ord)
  where x ->> 'credit_id' is null;
  if v_old_lines is distinct from v_new_lines then
    perform app.fail('RD409', 'The invoice changed in other ways; reload it');
  end if;

  perform app.verify_invoice_lines(p_invoice);
  perform app.verify_invoice_credits(inv.owner_id, inv.customer_id, p_invoice, inv.id);

  delete from public.invoice_lines where invoice_id = inv.id and credit_id is not null;
  select coalesce(max(sort_order), -1) + 1 into v_sort from public.invoice_lines where invoice_id = inv.id;
  for v_line in select * from jsonb_array_elements(p_invoice -> 'lines') loop
    if v_line ->> 'credit_id' is not null then
      insert into public.invoice_lines (owner_id, invoice_id, line_type, description, quantity, rate_cents,
                                        amount_cents, sort_order, credit_id)
      values (inv.owner_id, inv.id, 'CREDIT', v_line ->> 'description', (v_line ->> 'quantity')::bigint,
              (v_line ->> 'rate_cents')::bigint, (v_line ->> 'amount_cents')::bigint, v_sort,
              (v_line ->> 'credit_id')::uuid);
      v_sort := v_sort + 1;
    end if;
  end loop;

  update public.invoices
  set credit_applied_cents = (p_invoice ->> 'credit_applied_cents')::bigint,
      total_cents = (p_invoice ->> 'total_cents')::bigint,
      calculation = p_invoice -> 'calculation'
  where id = inv.id;

  perform app.write_audit(p_actor_id,
    case when p_include then 'INVOICE_CREDIT_RESTORED' else 'INVOICE_CREDIT_REMOVED' end,
    'invoices', inv.id, inv.owner_id,
    jsonb_build_object('credit_id', p_credit_id, 'note', nullif(btrim(p_note), ''), 'ticket_id', t.id,
                       'total_before_cents', inv.total_cents, 'total_after_cents', (p_invoice ->> 'total_cents')::bigint));

  return jsonb_build_object('invoice_id', inv.id, 'total_cents', (p_invoice ->> 'total_cents')::bigint,
                            'credit_applied_cents', (p_invoice ->> 'credit_applied_cents')::bigint,
                            'credits_excluded', v_new_excluded);
end;
$$;

-- =============================================================================
-- Assign (replaces 0014's): monthly calendar, late fee, money received upfront.
--   p_terms keys: start_date, first_billing_date, due_days, end_date,
--   monthly_commitment_cents, bw_included, bw_rate_cents, colour_included,
--   colour_rate_cents, installation_location, initial_bw_reading,
--   initial_colour_reading, late_fee_mode, late_fee_cents, upfront[]
-- =============================================================================
create or replace function app.assign_machine(
  p_actor_id uuid,
  p_machine_id uuid,
  p_customer_id uuid,
  p_terms jsonb,
  p_today date
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.machines;
  a public.rental_agreements;
  v_customer_status public.account_status;
  v_start date := (p_terms ->> 'start_date')::date;
  v_first date := (p_terms ->> 'first_billing_date')::date;
  v_late record;
  v_upfront jsonb;
begin
  if p_today is null or v_start is null or v_first is null then
    perform app.fail('RD400', 'Start date, first billing date and today are required');
  end if;

  select * into m from public.machines where id = p_machine_id for update;
  if not found then
    perform app.fail('RD404', 'Machine not found');
  end if;
  perform app.assert_actor(p_actor_id, m.owner_id, null, array['OWNER']::public.user_role[]);
  perform app.set_actor(p_actor_id);

  -- Another owner's customer looks exactly like a missing one.
  select p.status into v_customer_status
  from public.customers c join public.profiles p on p.id = c.id
  where c.id = p_customer_id and c.owner_id = m.owner_id
  for update of p;
  if not found then
    perform app.fail('RD404', 'Customer not found');
  end if;
  if v_customer_status <> 'ACTIVE' then
    perform app.fail('RD409', 'The customer account is not active');
  end if;
  if m.status <> 'AVAILABLE' then
    perform app.fail('RD409', format('Only an available machine can be assigned (this one is %s)', m.status));
  end if;

  if v_first < p_today then
    perform app.fail('RD400', 'The first billing date cannot be in the past');
  end if;
  if v_first <= v_start then
    perform app.fail('RD400', 'The first billing date must be after the start date');
  end if;
  select * into v_late from app.json_late_fee(p_terms, 'OWNER_DEFAULT', null);

  insert into public.rental_agreements (
    owner_id, customer_id, machine_id, status, start_date, first_billing_date, end_date,
    due_days, monthly_commitment_cents, bw_included, bw_rate_cents, colour_included, colour_rate_cents,
    installation_location, initial_bw_reading, initial_colour_reading, late_fee_mode, late_fee_cents
  ) values (
    m.owner_id, p_customer_id, m.id, 'ACTIVE', v_start, v_first, (p_terms ->> 'end_date')::date,
    coalesce((p_terms ->> 'due_days')::integer, 7),
    app.json_count(p_terms, 'monthly_commitment_cents', 'Monthly commitment'),
    coalesce(app.json_count(p_terms, 'bw_included', 'Included B&W copies'), 0),
    app.json_count(p_terms, 'bw_rate_cents', 'B&W excess rate'),
    app.json_count(p_terms, 'colour_included', 'Included colour copies'),
    app.json_count(p_terms, 'colour_rate_cents', 'Colour excess rate'),
    nullif(btrim(p_terms ->> 'installation_location'), ''),
    coalesce(app.json_count(p_terms, 'initial_bw_reading', 'Initial B&W reading'), 0),
    app.json_count(p_terms, 'initial_colour_reading', 'Initial colour reading'),
    v_late.mode, v_late.cents
  )
  returning * into a;

  -- DEP-01 / DEP-02: deposits are held, advances become credits.
  v_upfront := app.record_upfront_money(a, p_actor_id, p_terms -> 'upfront', p_today);

  perform app.write_audit(p_actor_id, 'MACHINE_ASSIGNED', 'rental_agreements', a.id, m.owner_id,
    jsonb_build_object('machine_id', m.id, 'serial_no', m.serial_no, 'customer_id', p_customer_id,
                       'first_billing_date', v_first, 'late_fee_mode', v_late.mode, 'late_fee_cents', v_late.cents,
                       'deposit_cents', v_upfront -> 'deposit_cents', 'advance_cents', v_upfront -> 'advance_cents'));

  perform app.enqueue_notifications(
    m.owner_id,
    jsonb_build_array(jsonb_build_object(
      'user_id', p_customer_id,
      'event', 'machine.assigned',
      'title', format('%s %s is now on your account', m.brand, m.model),
      'body', format('First meter reading due on %s, then monthly.', to_char(v_first, 'DD Mon YYYY')),
      'link', '/customer/machines'
    )),
    'rental_agreements',
    a.id
  );

  return jsonb_build_object('agreement_id', a.id, 'machine_id', m.id, 'next_cycle_no', 1, 'next_cycle_date', v_first,
                            'deposit_cents', v_upfront -> 'deposit_cents', 'advance_cents', v_upfront -> 'advance_cents');
end;
$$;

-- =============================================================================
-- Edit terms (replaces 0014's): monthly calendar; the late fee setting is a
-- versioned term like the prices (from the next cycle).
-- =============================================================================
create or replace function app.update_agreement_terms(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_terms jsonb,
  p_note text,
  p_today date
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.rental_agreements;
  v_type public.machine_type;
  cur public.agreement_terms_history;
  nxt public.agreement_terms_history;
  v_late record;
  v_effective integer;
  v_pricing_changed boolean;
  v_other_changed boolean := false;
  v_location text;
  v_end date;
begin
  if p_today is null then
    perform app.fail('RD400', 'Today is required');
  end if;

  select * into a from public.rental_agreements where id = p_agreement_id for update;
  if not found then
    perform app.fail('RD404', 'Agreement not found');
  end if;
  perform app.assert_actor(p_actor_id, a.owner_id, null, array['OWNER']::public.user_role[]);
  perform app.set_actor(p_actor_id);
  if a.status = 'TERMINATED' then
    perform app.fail('RD409', 'This agreement has ended');
  end if;
  select m.type into v_type from public.machines m where m.id = a.machine_id;

  -- Latest version (including one still pending).
  select * into cur from public.agreement_terms_history h
  where h.agreement_id = a.id order by h.version desc limit 1;

  nxt := cur;
  if p_terms ? 'monthly_commitment_cents' then
    nxt.monthly_commitment_cents := app.json_count(p_terms, 'monthly_commitment_cents', 'Monthly commitment');
  end if;
  if p_terms ? 'bw_included' then
    nxt.bw_included := app.json_count(p_terms, 'bw_included', 'Included B&W copies');
  end if;
  if p_terms ? 'bw_rate_cents' then
    nxt.bw_rate_cents := app.json_count(p_terms, 'bw_rate_cents', 'B&W excess rate');
  end if;
  if p_terms ? 'colour_included' then
    nxt.colour_included := app.json_count(p_terms, 'colour_included', 'Included colour copies');
  end if;
  if p_terms ? 'colour_rate_cents' then
    nxt.colour_rate_cents := app.json_count(p_terms, 'colour_rate_cents', 'Colour excess rate');
  end if;
  if p_terms ? 'due_days' then
    nxt.due_days := (p_terms ->> 'due_days')::integer;
  end if;
  select * into v_late from app.json_late_fee(p_terms, cur.late_fee_mode, cur.late_fee_cents);
  nxt.late_fee_mode := v_late.mode;
  nxt.late_fee_cents := v_late.cents;

  if nxt.monthly_commitment_cents is null or nxt.bw_rate_cents is null or nxt.bw_included is null
     or nxt.due_days is null or nxt.due_days not between 0 and 120 then
    perform app.fail('RD400', 'Commitment, included B&W copies, B&W rate and due days (0 to 120) are required');
  end if;
  if v_type = 'COLOUR' and (nxt.colour_included is null or nxt.colour_rate_cents is null) then
    perform app.fail('RD400', 'Colour machines need colour included copies and a colour rate');
  end if;
  if v_type = 'MONO' and (nxt.colour_included is not null or nxt.colour_rate_cents is not null) then
    perform app.fail('RD400', 'Mono machines cannot have colour terms');
  end if;

  v_pricing_changed := (nxt.monthly_commitment_cents, nxt.bw_included, nxt.bw_rate_cents,
                        nxt.colour_included, nxt.colour_rate_cents, nxt.due_days, nxt.late_fee_mode, nxt.late_fee_cents)
    is distinct from (cur.monthly_commitment_cents, cur.bw_included, cur.bw_rate_cents,
                      cur.colour_included, cur.colour_rate_cents, cur.due_days, cur.late_fee_mode, cur.late_fee_cents);

  v_location := case when p_terms ? 'installation_location'
                     then nullif(btrim(p_terms ->> 'installation_location'), '') else a.installation_location end;
  v_end := case when p_terms ? 'end_date' then (p_terms ->> 'end_date')::date else a.end_date end;
  if v_end is not null and v_end < a.start_date then
    perform app.fail('RD400', 'The end date cannot be before the start date');
  end if;
  if v_location is distinct from a.installation_location or v_end is distinct from a.end_date then
    v_other_changed := true;
    update public.rental_agreements set installation_location = v_location, end_date = v_end where id = a.id;
  end if;

  if not v_pricing_changed and not v_other_changed then
    perform app.fail('RD400', 'Nothing changed');
  end if;

  if v_pricing_changed then
    v_effective := greatest(app.cycle_in_progress(a.first_billing_date, p_today) + 1, a.next_cycle_no);
    insert into public.agreement_terms_history (
      owner_id, agreement_id, version, effective_from_cycle_no, monthly_commitment_cents,
      bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days, late_fee_mode, late_fee_cents,
      note, changed_by
    ) values (
      a.owner_id, a.id, cur.version + 1, v_effective, nxt.monthly_commitment_cents,
      nxt.bw_included, nxt.bw_rate_cents, nxt.colour_included, nxt.colour_rate_cents, nxt.due_days,
      nxt.late_fee_mode, nxt.late_fee_cents, nullif(btrim(p_note), ''), p_actor_id
    );

    perform app.enqueue_notifications(
      a.owner_id,
      jsonb_build_array(jsonb_build_object(
        'user_id', a.customer_id,
        'event', 'agreement.terms_changed',
        'title', 'Your rental terms are changing',
        'body', format('New terms apply from the cycle due on %s.',
                       to_char(app.cycle_date(a.first_billing_date, v_effective), 'DD Mon YYYY')),
        'link', '/customer/machines'
      )),
      'rental_agreements',
      a.id
    );
  end if;

  return jsonb_build_object(
    'agreement_id', a.id,
    'pricing_changed', v_pricing_changed,
    'version', case when v_pricing_changed then cur.version + 1 else cur.version end,
    'effective_from_cycle_no', v_effective,
    'effective_from_date', case when v_pricing_changed then app.cycle_date(a.first_billing_date, v_effective) end
  );
end;
$$;

-- =============================================================================
-- open_billing_cycle (replaces 0014's): monthly calendar, real cycle length and
-- the late fee setting in the ticket snapshot.
-- =============================================================================
create or replace function app.open_billing_cycle(
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
  h public.agreement_terms_history;
  v_ticket_id uuid;
  v_machine_type public.machine_type;
  v_cycle_date date;
  v_period_start date;
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

  v_cycle_date := app.cycle_date(a.first_billing_date, p_cycle_no);
  v_period_start := app.cycle_date(a.first_billing_date, p_cycle_no - 1);
  if p_cycle_no = 1 then
    v_period_start := greatest(v_period_start, a.start_date);
  end if;
  select m.type into v_machine_type from public.machines m where m.id = a.machine_id;

  -- Terms in force for this cycle (AGR-02): latest version effective by now.
  select * into h from public.agreement_terms_history t
  where t.agreement_id = a.id and t.effective_from_cycle_no <= p_cycle_no
  order by t.effective_from_cycle_no desc, t.version desc
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
    status, stage_due_at, machine_type, cycle_length_days, commitment_cents,
    bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days, late_fee_mode, late_fee_cents
  ) values (
    a.owner_id, a.customer_id, a.id, a.machine_id, p_cycle_no, v_cycle_date, v_period_start, v_cycle_date - 1,
    'METER_REQUESTED', p_stage_due_at, v_machine_type, app.cycle_days(a.first_billing_date, p_cycle_no),
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

  return jsonb_build_object('ticket_id', v_ticket_id, 'cycle_no', p_cycle_no, 'cycle_date', v_cycle_date, 'replayed', false);
end;
$$;

-- =============================================================================
-- B. Return (RET-01; replaces 0014's) and reassign
-- =============================================================================
alter table public.rental_agreements
  add column return_idempotency_key uuid,
  add constraint rental_agreements_return_idempotency_key unique (return_idempotency_key);

-- Only a meter reading waiting for the owner's review blocks a return: the final
-- bill must start from confirmed numbers. Unpaid invoices no longer block.
create or replace function app.agreement_return_blockers(p_agreement_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', 'ticket', 'id', t.id, 'cycle_no', t.cycle_no, 'status', t.status)
                            order by t.cycle_no), '[]'::jsonb)
  from public.billing_cycle_tickets t
  where t.agreement_id = p_agreement_id
    and (t.status = 'PENDING_OWNER_REVIEW' or (t.status = 'OVERDUE' and t.status_before_overdue = 'PENDING_OWNER_REVIEW'));
$$;

drop function public.rpc_reassign_machine(uuid, uuid, jsonb, text, uuid, jsonb, date);
drop function public.rpc_return_machine(uuid, uuid, jsonb, text, date);
drop function app.reassign_machine(uuid, uuid, jsonb, text, uuid, jsonb, date);
drop function app.return_machine(uuid, uuid, jsonb, text, date);

-- p_return:
--   { idempotency_key, reason, closing: {bw, colour?},
--     final: null | { rule: PRORATED|FULL, readings: [...], invoice: {...}, anomaly_flag,
--                     due_date, stage_due_at, branding_snapshot },
--     deposit: null (keep holding) | { deduct_cents, refund_cents, refunded_on, refund_method,
--                                      refund_reference, retain_cents, retain_reason } }
create function app.return_machine(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_return jsonb,
  p_today date
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.rental_agreements;
  m public.machines;
  h public.agreement_terms_history;
  t public.billing_cycle_tickets;
  v_key uuid := nullif(p_return ->> 'idempotency_key', '')::uuid;
  v_reason text := nullif(btrim(p_return ->> 'reason'), '');
  v_bw bigint := app.json_count(p_return -> 'closing', 'bw', 'Closing B&W reading');
  v_colour bigint := app.json_count(p_return -> 'closing', 'colour', 'Closing colour reading');
  v_final jsonb := p_return -> 'final';
  v_invoice jsonb;
  v_rule text;
  v_due date;
  v_facts jsonb;
  v_last bigint;
  v_blockers jsonb;
  v_reading jsonb;
  v_line jsonb;
  v_sort smallint := 0;
  v_ticket_id uuid;
  v_submission_id uuid;
  v_invoice_id uuid;
  v_invoice_no text;
  v_total bigint;
  v_cancelled jsonb := '[]'::jsonb;
  v_deposit jsonb;
  v_notifications jsonb;
begin
  if v_key is null then
    perform app.fail('RD400', 'An idempotency key is required');
  end if;
  if v_reason is null then
    perform app.fail('RD400', 'A reason is required');
  end if;
  if p_today is null then
    perform app.fail('RD400', 'Today is required');
  end if;

  select * into a from public.rental_agreements where id = p_agreement_id for update;
  if not found then
    perform app.fail('RD404', 'Agreement not found');
  end if;
  perform app.assert_actor(p_actor_id, a.owner_id, null, array['OWNER']::public.user_role[]);
  perform app.set_actor(p_actor_id);
  if a.status = 'TERMINATED' then
    -- A retried request (double tap, lost connection) returns the first result.
    if a.return_idempotency_key = v_key then
      return jsonb_build_object('agreement_id', a.id, 'machine_id', a.machine_id, 'replayed', true);
    end if;
    perform app.fail('RD409', 'This agreement has already ended');
  end if;
  select * into m from public.machines where id = a.machine_id for update;

  v_blockers := app.agreement_return_blockers(a.id);
  if jsonb_array_length(v_blockers) > 0 then
    perform app.fail('RD409', 'RETURN_BLOCKED:' || v_blockers::text);
  end if;

  if v_bw is null then
    perform app.fail('RD400', 'Closing B&W reading is required');
  end if;
  if m.type = 'COLOUR' and v_colour is null then
    perform app.fail('RD400', 'Closing colour reading is required');
  end if;
  if m.type = 'MONO' then
    v_colour := null;
  end if;
  -- Lower than the last reading is accepted only as a rollover on a counter with a maximum.
  v_last := app.last_known_reading(a.id, 'BW');
  if v_bw < v_last and m.bw_counter_max is null then
    perform app.fail('RD400', format('Closing B&W reading %s is lower than the last reading %s', v_bw, v_last));
  end if;
  if v_colour is not null then
    v_last := app.last_known_reading(a.id, 'COLOUR');
    if v_colour < v_last and m.colour_counter_max is null then
      perform app.fail('RD400', format('Closing colour reading %s is lower than the last reading %s', v_colour, v_last));
    end if;
  end if;

  v_facts := app.final_cycle(a.id, p_today);
  if (v_facts ->> 'billable')::boolean then
    if jsonb_typeof(v_final) is distinct from 'object' then
      perform app.fail('RD400', 'The final invoice is required');
    end if;
    v_rule := v_final ->> 'rule';
    if v_rule is null or v_rule not in ('PRORATED', 'FULL') then
      perform app.fail('RD400', 'Choose prorated or full for the final cycle');
    end if;
    v_invoice := v_final -> 'invoice';
    v_due := nullif(v_final ->> 'due_date', '')::date;
    if v_due is null or v_due < p_today then
      perform app.fail('RD400', 'The final invoice needs a due date (today or later)');
    end if;
    if jsonb_typeof(v_final -> 'readings') is distinct from 'array'
       or jsonb_array_length(v_final -> 'readings') <> (case m.type when 'COLOUR' then 2 else 1 end) then
      perform app.fail('RD400', 'The final invoice needs every closing reading');
    end if;
    for v_reading in select * from jsonb_array_elements(v_final -> 'readings') loop
      if (v_reading ->> 'current_value')::bigint is distinct from
         (case v_reading ->> 'counter_type' when 'BW' then v_bw when 'COLOUR' then v_colour end) then
        perform app.fail('RD400', 'The final invoice must use the closing readings');
      end if;
    end loop;

    -- Terms in force for the final cycle.
    select * into h from public.agreement_terms_history th
    where th.agreement_id = a.id and th.effective_from_cycle_no <= (v_facts ->> 'cycle_no')::integer
    order by th.effective_from_cycle_no desc, th.version desc
    limit 1;

    perform app.verify_final_invoice(a, v_facts, h, v_final -> 'readings', v_invoice,
                                     nullif(v_final ->> 'anomaly_flag', ''), v_rule);
    perform app.verify_invoice_credits(a.owner_id, a.customer_id, v_invoice, null);

    -- Tickets still waiting for a meter reading: their cycles are in the final invoice.
    for t in
      select * from public.billing_cycle_tickets bt
      where bt.agreement_id = a.id
        and (bt.status = 'METER_REQUESTED' or (bt.status = 'OVERDUE' and bt.status_before_overdue = 'METER_REQUESTED'))
      order by bt.cycle_no
      for update
    loop
      if not exists (select 1 from public.invoices i where i.ticket_id = t.id and i.status not in ('REJECTED', 'CANCELLED')) then
        perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'CANCELLED', p_actor_id,
          'Billed in the final invoice when the machine was returned', jsonb_build_object('machine_returned', true));
        perform app.enter_stage(t.id, 'CANCELLED', null);
        v_cancelled := v_cancelled || to_jsonb(t.cycle_no);
      end if;
    end loop;

    -- The final cycle's ticket goes straight to Awaiting payment: the owner typed the readings.
    insert into public.billing_cycle_tickets (
      owner_id, customer_id, agreement_id, machine_id, cycle_no, cycle_date, period_start, period_end,
      status, stage_due_at, machine_type, cycle_length_days, commitment_cents, bw_included, bw_rate_cents,
      colour_included, colour_rate_cents, due_days, late_fee_mode, late_fee_cents
    ) values (
      a.owner_id, a.customer_id, a.id, a.machine_id, (v_facts ->> 'cycle_no')::integer, p_today,
      (v_facts ->> 'period_start')::date, p_today, 'AWAITING_PAYMENT',
      nullif(v_final ->> 'stage_due_at', '')::timestamptz, m.type, (v_facts ->> 'days_in_cycle')::integer,
      h.monthly_commitment_cents, h.bw_included, h.bw_rate_cents, h.colour_included, h.colour_rate_cents,
      h.due_days, h.late_fee_mode, h.late_fee_cents
    )
    returning id into v_ticket_id;
    insert into public.ticket_events (owner_id, ticket_id, event_type, to_status, actor_id, reason, metadata)
    values (a.owner_id, v_ticket_id, 'CREATED', 'AWAITING_PAYMENT', p_actor_id, 'Final invoice: machine returned',
            jsonb_build_object('cycle_no', v_facts -> 'cycle_no', 'final', true, 'rule', v_rule,
                               'days_used', v_facts -> 'days_used', 'days_in_cycle', v_facts -> 'days_in_cycle'));

    -- The closing readings are a confirmed reading (INV-10: kept permanently).
    insert into public.meter_submissions (owner_id, ticket_id, customer_id, attempt_no, source, status, idempotency_key,
                                          submitted_by, note, anomaly_flag, reviewed_by, reviewed_at)
    values (a.owner_id, v_ticket_id, a.customer_id, 1, 'OWNER_MANUAL', 'CONFIRMED', v_key, p_actor_id,
            'Closing reading on return: ' || v_reason, nullif(v_final ->> 'anomaly_flag', ''), p_actor_id, now())
    returning id into v_submission_id;
    for v_reading in select * from jsonb_array_elements(v_final -> 'readings') loop
      insert into public.meter_readings (owner_id, submission_id, counter_type, previous_value, current_value, rolled_over,
                                         rollover_confirmed_by, rollover_confirmed_at)
      values (
        a.owner_id, v_submission_id,
        (v_reading ->> 'counter_type')::public.counter_type,
        (v_reading ->> 'previous_value')::bigint,
        (v_reading ->> 'current_value')::bigint,
        coalesce((v_reading ->> 'rolled_over')::boolean, false),
        case when coalesce((v_reading ->> 'rolled_over')::boolean, false) then p_actor_id end,
        case when coalesce((v_reading ->> 'rolled_over')::boolean, false) then now() end
      );
    end loop;

    insert into public.invoices (
      owner_id, customer_id, agreement_id, machine_id, ticket_id, type, status,
      period_start, period_end, cycles_covered, subtotal_cents, credit_applied_cents, total_cents, calculation
    ) values (
      a.owner_id, a.customer_id, a.id, a.machine_id, v_ticket_id, 'NORMAL', 'DRAFT',
      (v_facts ->> 'invoice_period_start')::date, p_today,
      (v_invoice ->> 'cycles_covered')::smallint,
      (v_invoice ->> 'subtotal_cents')::bigint,
      coalesce((v_invoice ->> 'credit_applied_cents')::bigint, 0),
      (v_invoice ->> 'total_cents')::bigint,
      v_invoice -> 'calculation'
    )
    returning id, total_cents into v_invoice_id, v_total;
    for v_line in select * from jsonb_array_elements(v_invoice -> 'lines') loop
      insert into public.invoice_lines (owner_id, invoice_id, line_type, description, quantity, rate_cents,
                                        amount_cents, sort_order, credit_id)
      values (
        a.owner_id, v_invoice_id,
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

    -- Issue at once (INV-11 number, gap-free). Fully covered by credits: nothing to pay.
    v_invoice_no := app.assign_invoice_number(v_invoice_id);
    update public.invoices
    set status = (case when v_total = 0 then 'PAID' else 'AWAITING_PAYMENT' end)::public.invoice_status,
        due_date = v_due, confirmed_by = p_actor_id, confirmed_at = now(),
        issued_at = now(), branding_snapshot = v_final -> 'branding_snapshot'
    where id = v_invoice_id;
    update public.meter_submissions set invoice_id = v_invoice_id where id = v_submission_id;
    update public.billing_cycle_tickets set current_invoice_id = v_invoice_id where id = v_ticket_id;
    if v_total = 0 then
      select * into t from public.billing_cycle_tickets where id = v_ticket_id;
      perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'CLOSED', p_actor_id, 'Final invoice fully covered by credits', '{}'::jsonb);
      perform app.enter_stage(v_ticket_id, 'CLOSED', null);
      update public.billing_cycle_tickets set closed_at = now(), closed_by = p_actor_id where id = v_ticket_id;
    end if;
  elsif jsonb_typeof(v_final) = 'object' then
    perform app.fail('RD400', 'Nothing can be billed: the machine is returned before its first billing period');
  end if;

  perform set_config('app.audit_reason', v_reason, true);
  update public.rental_agreements
  set status = 'TERMINATED',
      closing_bw_reading = v_bw,
      closing_colour_reading = v_colour,
      termination_reason = v_reason,
      end_date = greatest(p_today, start_date),
      terminated_at = now(),
      return_idempotency_key = v_key
  where id = a.id
  returning * into a;
  perform set_config('app.audit_reason', '', true);

  -- DEP-03: settle the deposit now, or keep holding it (settle later).
  if jsonb_typeof(p_return -> 'deposit') = 'object' then
    v_deposit := app.apply_deposit_settlement(a, p_actor_id, p_return -> 'deposit', p_today);
  end if;

  perform app.write_audit(p_actor_id, 'MACHINE_RETURNED', 'rental_agreements', a.id, a.owner_id,
    jsonb_build_object('machine_id', m.id, 'serial_no', m.serial_no, 'customer_id', a.customer_id,
                       'closing_bw_reading', v_bw, 'closing_colour_reading', v_colour, 'reason', v_reason,
                       'final_invoice_id', v_invoice_id, 'final_invoice_no', v_invoice_no, 'final_total_cents', v_total,
                       'final_rule', v_rule, 'cancelled_cycles', v_cancelled,
                       'deposit_settled', v_deposit is not null, 'deposit_held_cents', app.deposit_held(a.id)));

  v_notifications := jsonb_build_array(jsonb_build_object(
    'user_id', a.customer_id,
    'event', 'machine.returned',
    'title', format('%s %s was returned', m.brand, m.model),
    'body', v_reason,
    'link', '/customer/machines'
  ));
  if v_invoice_id is not null then
    v_notifications := v_notifications || jsonb_build_object(
      'user_id', a.customer_id,
      'event', 'invoice.issued',
      'title', format('Final invoice %s: %s', v_invoice_no, app.format_rupees(v_total)),
      'body', format('For %s %s up to %s. Due %s.', m.brand, m.model, to_char(p_today, 'DD Mon YYYY'), to_char(v_due, 'DD Mon YYYY')),
      'link', '/customer/bills'
    );
  end if;
  perform app.enqueue_notifications(a.owner_id, v_notifications, 'rental_agreements', a.id);

  return jsonb_build_object('agreement_id', a.id, 'machine_id', m.id, 'replayed', false,
                            'final_invoice_id', v_invoice_id, 'final_invoice_no', v_invoice_no,
                            'final_total_cents', v_total, 'cancelled_cycles', v_cancelled,
                            'deposit', v_deposit, 'deposit_held_cents', app.deposit_held(a.id));
end;
$$;

-- Reassign (MAC-04): the same return + a new assignment, in one transaction.
create function app.reassign_machine(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_return jsonb,
  p_customer_id uuid,
  p_terms jsonb,
  p_today date
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_returned jsonb;
  v_assigned jsonb;
  v_live uuid;
begin
  v_returned := app.return_machine(p_actor_id, p_agreement_id, p_return, p_today);
  if (v_returned ->> 'replayed')::boolean then
    select id into v_live from public.rental_agreements
    where machine_id = (v_returned ->> 'machine_id')::uuid and status <> 'TERMINATED';
    return jsonb_build_object('agreement_id', v_live, 'previous_agreement_id', p_agreement_id, 'replayed', true);
  end if;
  v_assigned := app.assign_machine(p_actor_id, (v_returned ->> 'machine_id')::uuid, p_customer_id, p_terms, p_today);
  return v_assigned || jsonb_build_object('previous_agreement_id', p_agreement_id, 'returned', v_returned);
end;
$$;

-- =============================================================================
-- Old calendar signatures (every caller is replaced above)
-- =============================================================================
drop function app.cycle_date(date, integer, integer);
drop function app.cycle_in_progress(date, integer, date);

-- =============================================================================
-- Grants: app.* service_role only; public.rpc_* wrappers service_role only.
-- =============================================================================
revoke execute on function
  app.format_rupees(bigint),
  app.cycle_date(date, integer),
  app.cycle_days(date, integer),
  app.cycle_in_progress(date, date),
  app.json_late_fee(jsonb, public.late_fee_mode, bigint),
  app.credit_used(uuid, uuid),
  app.available_credits(uuid, uuid),
  app.refresh_credit_status(uuid[]),
  app.invoice_credit_status(),
  app.deposit_held(uuid),
  app.deposit_transaction_check(),
  app.record_upfront_money(public.rental_agreements, uuid, jsonb, date),
  app.deposit_deductible_invoices(uuid),
  app.apply_deposit_settlement(public.rental_agreements, uuid, jsonb, date),
  app.settle_deposit(uuid, uuid, jsonb, date),
  app.verify_invoice_lines(jsonb),
  app.verify_invoice_credits(uuid, uuid, jsonb, uuid),
  app.final_cycle(uuid, date),
  app.verify_final_invoice(public.rental_agreements, jsonb, public.agreement_terms_history, jsonb, jsonb, text, text),
  app.set_invoice_credit(uuid, uuid, uuid, boolean, text, jsonb),
  app.return_machine(uuid, uuid, jsonb, date),
  app.reassign_machine(uuid, uuid, jsonb, uuid, jsonb, date)
from public, anon, authenticated;

grant execute on function
  app.format_rupees(bigint),
  app.cycle_date(date, integer),
  app.cycle_days(date, integer),
  app.cycle_in_progress(date, date),
  app.json_late_fee(jsonb, public.late_fee_mode, bigint),
  app.credit_used(uuid, uuid),
  app.available_credits(uuid, uuid),
  app.refresh_credit_status(uuid[]),
  app.deposit_held(uuid),
  app.record_upfront_money(public.rental_agreements, uuid, jsonb, date),
  app.deposit_deductible_invoices(uuid),
  app.apply_deposit_settlement(public.rental_agreements, uuid, jsonb, date),
  app.settle_deposit(uuid, uuid, jsonb, date),
  app.verify_invoice_lines(jsonb),
  app.verify_invoice_credits(uuid, uuid, jsonb, uuid),
  app.final_cycle(uuid, date),
  app.verify_final_invoice(public.rental_agreements, jsonb, public.agreement_terms_history, jsonb, jsonb, text, text),
  app.set_invoice_credit(uuid, uuid, uuid, boolean, text, jsonb),
  app.return_machine(uuid, uuid, jsonb, date),
  app.reassign_machine(uuid, uuid, jsonb, uuid, jsonb, date)
to service_role;

create function public.rpc_return_machine(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_return jsonb,
  p_today date
) returns jsonb
language sql
set search_path = ''
as $$
  select app.return_machine(p_actor_id, p_agreement_id, p_return, p_today);
$$;

create function public.rpc_reassign_machine(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_return jsonb,
  p_customer_id uuid,
  p_terms jsonb,
  p_today date
) returns jsonb
language sql
set search_path = ''
as $$
  select app.reassign_machine(p_actor_id, p_agreement_id, p_return, p_customer_id, p_terms, p_today);
$$;

create function public.rpc_settle_deposit(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_settlement jsonb,
  p_today date
) returns jsonb
language sql
set search_path = ''
as $$
  select app.settle_deposit(p_actor_id, p_agreement_id, p_settlement, p_today);
$$;

create function public.rpc_set_invoice_credit(
  p_actor_id uuid,
  p_invoice_id uuid,
  p_credit_id uuid,
  p_include boolean,
  p_note text,
  p_invoice jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.set_invoice_credit(p_actor_id, p_invoice_id, p_credit_id, p_include, p_note, p_invoice);
$$;

revoke execute on function
  public.rpc_return_machine(uuid, uuid, jsonb, date),
  public.rpc_reassign_machine(uuid, uuid, jsonb, uuid, jsonb, date),
  public.rpc_settle_deposit(uuid, uuid, jsonb, date),
  public.rpc_set_invoice_credit(uuid, uuid, uuid, boolean, text, jsonb)
from public, anon, authenticated;

grant execute on function
  public.rpc_return_machine(uuid, uuid, jsonb, date),
  public.rpc_reassign_machine(uuid, uuid, jsonb, uuid, jsonb, date),
  public.rpc_settle_deposit(uuid, uuid, jsonb, date),
  public.rpc_set_invoice_credit(uuid, uuid, uuid, boolean, text, jsonb)
to service_role;
