-- =============================================================================
-- 0014 Machines and agreements workflow (MAC-01..05, AGR-01..03).
--
--   * Agreements are written only through atomic functions (assign, return,
--     reassign, edit terms). Owners keep direct, RLS-checked writes to machine
--     details, but never to machine status or agreements.
--   * RENTED is set only by an agreement (trigger guard).
--   * first_billing_date: the first cycle date. A start date in the past is allowed
--     (existing rentals being migrated); no ticket is ever opened before
--     first_billing_date. Cycle n is due on first_billing_date + (n - 1) * cycle length.
--   * billing_day is not used (the spec bills every N days). The column stays.
--   * agreement_terms_history: every version of the pricing terms with the cycle it
--     applies from. A change applies from the cycle after the period in progress
--     (AGR-02, spec 11.3). open_billing_cycle snapshots the version in force.
--   * customer_balances: outstanding amount per customer (CUS-04/05).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Agreement columns
-- -----------------------------------------------------------------------------
alter table public.rental_agreements add column first_billing_date date;
update public.rental_agreements set first_billing_date = start_date + cycle_length_days where first_billing_date is null;
alter table public.rental_agreements
  alter column first_billing_date set not null,
  add constraint rental_agreements_first_billing_after_start check (first_billing_date > start_date);

comment on column public.rental_agreements.billing_day is
  'Unused. Cycles run every cycle_length_days from first_billing_date (spec 5.5).';
comment on column public.rental_agreements.first_billing_date is
  'Cycle 1 date. Cycle n is due on first_billing_date + (n - 1) * cycle_length_days.';

-- Tickets also snapshot the payment terms (due days) of the version in force.
alter table public.billing_cycle_tickets add column due_days integer check (due_days between 0 and 120);
update public.billing_cycle_tickets t set due_days = a.due_days
from public.rental_agreements a where a.id = t.agreement_id and t.due_days is null;

-- -----------------------------------------------------------------------------
-- Cycle calendar helpers (mirrored by src/lib/agreements/cycle-calendar.ts)
-- -----------------------------------------------------------------------------
create function app.cycle_date(p_first_billing_date date, p_cycle_length integer, p_cycle_no integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_first_billing_date + (p_cycle_no - 1) * p_cycle_length;
$$;

-- The cycle whose usage period contains p_today: the first cycle whose date is
-- after p_today (cycle n covers the cycle_length days before its date).
create function app.cycle_in_progress(p_first_billing_date date, p_cycle_length integer, p_today date)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_today < p_first_billing_date then 1
    else (p_today - p_first_billing_date) / p_cycle_length + 2
  end;
$$;

-- -----------------------------------------------------------------------------
-- agreement_terms_history (AGR-02)
-- -----------------------------------------------------------------------------
create table public.agreement_terms_history (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  agreement_id uuid not null,
  version integer not null check (version >= 1),
  effective_from_cycle_no integer not null check (effective_from_cycle_no >= 1),
  monthly_commitment_cents bigint not null check (monthly_commitment_cents >= 0),
  bw_included bigint not null check (bw_included >= 0),
  bw_rate_cents bigint not null check (bw_rate_cents >= 0),
  colour_included bigint check (colour_included >= 0),
  colour_rate_cents bigint check (colour_rate_cents >= 0),
  due_days integer not null check (due_days between 0 and 120),
  note text,
  changed_by uuid references public.profiles (id),
  changed_at timestamptz not null default now(),
  constraint agreement_terms_history_version_key unique (agreement_id, version),
  constraint agreement_terms_history_colour_terms check ((colour_included is null) = (colour_rate_cents is null)),
  constraint agreement_terms_history_agreement_fkey foreign key (agreement_id, owner_id)
    references public.rental_agreements (id, owner_id)
);
comment on table public.agreement_terms_history is
  'Every version of an agreement''s pricing terms and the cycle it applies from. SERVER-WRITE-ONLY, append-only.';
create index agreement_terms_history_owner_id_idx on public.agreement_terms_history (owner_id);
create index agreement_terms_history_lookup_idx
  on public.agreement_terms_history (agreement_id, effective_from_cycle_no desc, version desc);
create index agreement_terms_history_changed_by_idx on public.agreement_terms_history (changed_by);

create trigger agreement_terms_history_audit after insert or update or delete on public.agreement_terms_history
  for each row execute function app.audit_row_change('all');

-- Supabase grants new tables to anon/authenticated by default: start from nothing.
revoke all on public.agreement_terms_history from anon, authenticated;
grant select on public.agreement_terms_history to authenticated;
revoke update, delete, truncate on public.agreement_terms_history from service_role;
alter table public.agreement_terms_history enable row level security;

create policy agreement_terms_history_select on public.agreement_terms_history for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);

-- Existing agreements: version 1 from their current terms.
insert into public.agreement_terms_history (
  owner_id, agreement_id, version, effective_from_cycle_no, monthly_commitment_cents,
  bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days, changed_at
)
select owner_id, id, 1, 1, monthly_commitment_cents, bw_included, bw_rate_cents,
       colour_included, colour_rate_cents, due_days, created_at
from public.rental_agreements a
where not exists (select 1 from public.agreement_terms_history h where h.agreement_id = a.id);

-- Version 1 is written with every new agreement, whatever the insert path.
create function app.rental_agreement_initial_terms() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.agreement_terms_history (
    owner_id, agreement_id, version, effective_from_cycle_no, monthly_commitment_cents,
    bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days, note, changed_by
  ) values (
    new.owner_id, new.id, 1, 1, new.monthly_commitment_cents, new.bw_included, new.bw_rate_cents,
    new.colour_included, new.colour_rate_cents, new.due_days, 'Initial terms', app.resolve_actor()
  );
  return null;
end;
$$;

create trigger rental_agreements_initial_terms after insert on public.rental_agreements
  for each row execute function app.rental_agreement_initial_terms();

-- -----------------------------------------------------------------------------
-- Agreement write rules (replaces 0003's version)
-- -----------------------------------------------------------------------------
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
    -- First ticket on first_billing_date (default: one cycle after the start, spec 5.5).
    new.first_billing_date := coalesce(new.first_billing_date, new.start_date + new.cycle_length_days);
    new.next_cycle_no := 1;
    new.next_cycle_date := new.first_billing_date;
  else
    if new.owner_id <> old.owner_id or new.customer_id <> old.customer_id or new.machine_id <> old.machine_id
       or new.start_date <> old.start_date or new.first_billing_date <> old.first_billing_date
       or new.cycle_length_days <> old.cycle_length_days
       or new.initial_bw_reading <> old.initial_bw_reading
       or new.initial_colour_reading is distinct from old.initial_colour_reading then
      raise exception using errcode = 'RD400',
        message = 'Customer, machine, start date, first billing date, cycle length and initial readings cannot be changed';
    end if;
    if old.status = 'TERMINATED' and new.status <> 'TERMINATED' then
      raise exception using errcode = 'RD409', message = 'A terminated agreement cannot be reactivated';
    end if;
  end if;

  if new.status = 'TERMINATED' and new.terminated_at is null then
    new.terminated_at := now();
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Machine write rules: RENTED only through an agreement (MAC-03); type and
-- tenant fixed once rented.
-- -----------------------------------------------------------------------------
create function app.machine_before_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_live boolean;
begin
  if tg_op = 'INSERT' then
    if new.status = 'RENTED' then
      raise exception using errcode = 'RD400', message = 'A machine becomes RENTED only by assigning it to a customer';
    end if;
    return new;
  end if;

  if new.owner_id <> old.owner_id then
    raise exception using errcode = 'RD400', message = 'A machine cannot move to another owner';
  end if;
  if new.type <> old.type and exists (select 1 from public.rental_agreements a where a.machine_id = old.id) then
    raise exception using errcode = 'RD400', message = 'The type of a machine that has been rented cannot change';
  end if;

  if new.status is distinct from old.status then
    v_live := exists (
      select 1 from public.rental_agreements a where a.machine_id = new.id and a.status <> 'TERMINATED'
    );
    if new.status = 'RENTED' and not v_live then
      raise exception using errcode = 'RD400', message = 'A machine becomes RENTED only by assigning it to a customer';
    end if;
    if old.status = 'RENTED' and v_live then
      raise exception using errcode = 'RD409', message = 'Return the machine before changing its status';
    end if;
  end if;
  return new;
end;
$$;

create trigger machines_before_write before insert or update on public.machines
  for each row execute function app.machine_before_write();

-- -----------------------------------------------------------------------------
-- Client privileges: agreements and machine status are server-only now.
-- -----------------------------------------------------------------------------
revoke insert, update on public.rental_agreements from authenticated;
revoke insert (status), update (status) on public.machines from authenticated;
drop policy rental_agreements_insert on public.rental_agreements;
drop policy rental_agreements_update on public.rental_agreements;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Latest known counter value: the initial reading, a confirmed reading or a new
-- baseline, whichever is most recent.
create function app.last_known_reading(p_agreement_id uuid, p_counter public.counter_type) returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select value from (
    select case p_counter when 'BW' then a.initial_bw_reading else a.initial_colour_reading end as value,
           a.created_at as at
    from public.rental_agreements a where a.id = p_agreement_id
    union all
    select r.current_value, coalesce(s.reviewed_at, s.submitted_at)
    from public.meter_readings r
    join public.meter_submissions s on s.id = r.submission_id
    join public.billing_cycle_tickets t on t.id = s.ticket_id
    where t.agreement_id = p_agreement_id and s.status = 'CONFIRMED' and r.counter_type = p_counter
    union all
    select b.value, b.recorded_at
    from public.meter_baselines b
    where b.agreement_id = p_agreement_id and b.counter_type = p_counter
  ) known
  where value is not null
  order by at desc
  limit 1;
$$;

-- What stops a return: open tickets and unpaid invoices. Empty array = nothing.
create function app.agreement_return_blockers(p_agreement_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(b order by b ->> 'kind', b ->> 'cycle_no'), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'ticket', 'id', t.id, 'cycle_no', t.cycle_no, 'status', t.status) as b
    from public.billing_cycle_tickets t
    where t.agreement_id = p_agreement_id and t.status not in ('CLOSED', 'CANCELLED')
    union all
    select jsonb_build_object('kind', 'invoice', 'id', i.id, 'invoice_no', i.invoice_no, 'status', i.status,
                              'balance_cents', i.total_cents - i.amount_paid_cents)
    from public.invoices i
    where i.agreement_id = p_agreement_id
      and i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
  ) q;
$$;

-- Reads an optional non-negative whole number from JSON (RD400 otherwise).
create function app.json_count(p_value jsonb, p_key text, p_label text) returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := p_value ->> p_key;
begin
  if v_text is null then
    return null;
  end if;
  if v_text !~ '^[0-9]{1,15}$' then
    perform app.fail('RD400', format('%s must be a whole number of 0 or more', p_label));
  end if;
  return v_text::bigint;
end;
$$;

-- -----------------------------------------------------------------------------
-- Assign a machine (MAC-02, AGR-01). p_terms keys:
--   start_date, first_billing_date, cycle_length_days, due_days, end_date,
--   monthly_commitment_cents, bw_included, bw_rate_cents, colour_included,
--   colour_rate_cents, installation_location, initial_bw_reading, initial_colour_reading
-- p_today is today in Asia/Colombo (computed by server code).
-- -----------------------------------------------------------------------------
create function app.assign_machine(
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
  v_customer_status public.account_status;
  v_customer_name text;
  v_start date := (p_terms ->> 'start_date')::date;
  v_first date := (p_terms ->> 'first_billing_date')::date;
  v_length integer := coalesce((p_terms ->> 'cycle_length_days')::integer, 30);
  v_agreement_id uuid;
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
  select p.status, c.name into v_customer_status, v_customer_name
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

  insert into public.rental_agreements (
    owner_id, customer_id, machine_id, status, start_date, first_billing_date, end_date, cycle_length_days,
    due_days, monthly_commitment_cents, bw_included, bw_rate_cents, colour_included, colour_rate_cents,
    installation_location, initial_bw_reading, initial_colour_reading
  ) values (
    m.owner_id, p_customer_id, m.id, 'ACTIVE', v_start, v_first, (p_terms ->> 'end_date')::date, v_length,
    coalesce((p_terms ->> 'due_days')::integer, 7),
    app.json_count(p_terms, 'monthly_commitment_cents', 'Monthly commitment'),
    coalesce(app.json_count(p_terms, 'bw_included', 'Included B&W copies'), 0),
    app.json_count(p_terms, 'bw_rate_cents', 'B&W excess rate'),
    app.json_count(p_terms, 'colour_included', 'Included colour copies'),
    app.json_count(p_terms, 'colour_rate_cents', 'Colour excess rate'),
    nullif(btrim(p_terms ->> 'installation_location'), ''),
    coalesce(app.json_count(p_terms, 'initial_bw_reading', 'Initial B&W reading'), 0),
    app.json_count(p_terms, 'initial_colour_reading', 'Initial colour reading')
  )
  returning id into v_agreement_id;

  perform app.write_audit(p_actor_id, 'MACHINE_ASSIGNED', 'rental_agreements', v_agreement_id, m.owner_id,
    jsonb_build_object('machine_id', m.id, 'serial_no', m.serial_no, 'customer_id', p_customer_id,
                       'first_billing_date', v_first));

  perform app.enqueue_notifications(
    m.owner_id,
    jsonb_build_array(jsonb_build_object(
      'user_id', p_customer_id,
      'event', 'machine.assigned',
      'title', format('%s %s is now on your account', m.brand, m.model),
      'body', format('First meter reading due on %s.', to_char(v_first, 'DD Mon YYYY')),
      'link', '/customer/machines'
    )),
    'rental_agreements',
    v_agreement_id
  );

  return jsonb_build_object('agreement_id', v_agreement_id, 'machine_id', m.id,
                            'next_cycle_no', 1, 'next_cycle_date', v_first);
end;
$$;

-- -----------------------------------------------------------------------------
-- Return a machine (MAC-04): closing readings + reason, agreement TERMINATED,
-- machine AVAILABLE. Blocked while a ticket is open or an invoice is unpaid.
-- p_closing: { bw, colour? }
-- -----------------------------------------------------------------------------
create function app.return_machine(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_closing jsonb,
  p_reason text,
  p_today date
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.rental_agreements;
  m public.machines;
  v_reason text := nullif(btrim(p_reason), '');
  v_bw bigint := app.json_count(p_closing, 'bw', 'Closing B&W reading');
  v_colour bigint := app.json_count(p_closing, 'colour', 'Closing colour reading');
  v_last bigint;
  v_blockers jsonb;
begin
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

  perform set_config('app.audit_reason', v_reason, true);
  update public.rental_agreements
  set status = 'TERMINATED',
      closing_bw_reading = v_bw,
      closing_colour_reading = v_colour,
      termination_reason = v_reason,
      end_date = greatest(p_today, start_date),
      terminated_at = now()
  where id = a.id;
  perform set_config('app.audit_reason', '', true);

  perform app.write_audit(p_actor_id, 'MACHINE_RETURNED', 'rental_agreements', a.id, a.owner_id,
    jsonb_build_object('machine_id', m.id, 'serial_no', m.serial_no, 'customer_id', a.customer_id,
                       'closing_bw_reading', v_bw, 'closing_colour_reading', v_colour, 'reason', v_reason));

  perform app.enqueue_notifications(
    a.owner_id,
    jsonb_build_array(jsonb_build_object(
      'user_id', a.customer_id,
      'event', 'machine.returned',
      'title', format('%s %s was returned', m.brand, m.model),
      'body', v_reason,
      'link', '/customer/machines'
    )),
    'rental_agreements',
    a.id
  );

  return jsonb_build_object('agreement_id', a.id, 'machine_id', m.id);
end;
$$;

-- Reassign (MAC-04): return + new assignment in one transaction.
create function app.reassign_machine(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_closing jsonb,
  p_reason text,
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
begin
  v_returned := app.return_machine(p_actor_id, p_agreement_id, p_closing, p_reason, p_today);
  v_assigned := app.assign_machine(p_actor_id, (v_returned ->> 'machine_id')::uuid, p_customer_id, p_terms, p_today);
  return v_assigned || jsonb_build_object('previous_agreement_id', p_agreement_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Edit terms (AGR-02). Pricing and due days get a new version that applies from
-- the cycle after the one in progress; open and earlier tickets keep their
-- snapshot. Installation location and end date change at once.
-- p_terms keys (absent = unchanged): monthly_commitment_cents, bw_included,
--   bw_rate_cents, colour_included, colour_rate_cents, due_days,
--   installation_location, end_date
-- -----------------------------------------------------------------------------
create function app.update_agreement_terms(
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
                        nxt.colour_included, nxt.colour_rate_cents, nxt.due_days)
    is distinct from (cur.monthly_commitment_cents, cur.bw_included, cur.bw_rate_cents,
                      cur.colour_included, cur.colour_rate_cents, cur.due_days);

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
    v_effective := greatest(
      app.cycle_in_progress(a.first_billing_date, a.cycle_length_days, p_today) + 1,
      a.next_cycle_no
    );
    insert into public.agreement_terms_history (
      owner_id, agreement_id, version, effective_from_cycle_no, monthly_commitment_cents,
      bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days, note, changed_by
    ) values (
      a.owner_id, a.id, cur.version + 1, v_effective, nxt.monthly_commitment_cents,
      nxt.bw_included, nxt.bw_rate_cents, nxt.colour_included, nxt.colour_rate_cents, nxt.due_days,
      nullif(btrim(p_note), ''), p_actor_id
    );

    perform app.enqueue_notifications(
      a.owner_id,
      jsonb_build_array(jsonb_build_object(
        'user_id', a.customer_id,
        'event', 'agreement.terms_changed',
        'title', 'Your rental terms are changing',
        'body', format('New terms apply from the cycle due on %s.',
                       to_char(app.cycle_date(a.first_billing_date, a.cycle_length_days, v_effective), 'DD Mon YYYY')),
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
    'effective_from_date', case when v_pricing_changed
      then app.cycle_date(a.first_billing_date, a.cycle_length_days, v_effective) end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Machine status (MAC-03): AVAILABLE, UNDER_REPAIR, RETIRED with a reason.
-- -----------------------------------------------------------------------------
create function app.set_machine_status(
  p_actor_id uuid,
  p_machine_id uuid,
  p_status public.machine_status,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.machines;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_status is null or p_status = 'RENTED' then
    perform app.fail('RD400', 'A machine becomes RENTED only by assigning it to a customer');
  end if;
  if v_reason is null then
    perform app.fail('RD400', 'A reason is required');
  end if;

  select * into m from public.machines where id = p_machine_id for update;
  if not found then
    perform app.fail('RD404', 'Machine not found');
  end if;
  perform app.assert_actor(p_actor_id, m.owner_id, null, array['OWNER']::public.user_role[]);
  perform app.set_actor(p_actor_id);
  if m.status = 'RENTED' then
    perform app.fail('RD409', 'Return the machine before changing its status');
  end if;
  if m.status = p_status then
    perform app.fail('RD409', 'The machine already has this status');
  end if;

  perform set_config('app.audit_reason', v_reason, true);
  update public.machines set status = p_status where id = m.id;
  perform set_config('app.audit_reason', '', true);

  return jsonb_build_object('machine_id', m.id, 'from', m.status, 'to', p_status);
end;
$$;

-- -----------------------------------------------------------------------------
-- open_billing_cycle (replaces 0008's version): snapshots the terms version in
-- force for the cycle, keeps the agreement's current terms in step, and never
-- opens a cycle before first_billing_date.
-- -----------------------------------------------------------------------------
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

  v_cycle_date := a.next_cycle_date;
  if v_cycle_date < a.first_billing_date then
    perform app.fail('RD409', 'No cycle is due before the first billing date');
  end if;
  v_period_start := v_cycle_date - a.cycle_length_days;
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
                h.colour_rate_cents, h.due_days)
     is distinct from (a.monthly_commitment_cents, a.bw_included, a.bw_rate_cents, a.colour_included,
                       a.colour_rate_cents, a.due_days) then
    update public.rental_agreements
    set monthly_commitment_cents = h.monthly_commitment_cents, bw_included = h.bw_included,
        bw_rate_cents = h.bw_rate_cents, colour_included = h.colour_included,
        colour_rate_cents = h.colour_rate_cents, due_days = h.due_days
    where id = a.id
    returning * into a;
  end if;

  insert into public.billing_cycle_tickets (
    owner_id, customer_id, agreement_id, machine_id, cycle_no, cycle_date, period_start, period_end,
    status, stage_due_at, machine_type, cycle_length_days, commitment_cents,
    bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days
  ) values (
    a.owner_id, a.customer_id, a.id, a.machine_id, p_cycle_no, v_cycle_date, v_period_start, v_cycle_date - 1,
    'METER_REQUESTED', p_stage_due_at, v_machine_type, a.cycle_length_days, a.monthly_commitment_cents,
    a.bw_included, a.bw_rate_cents, a.colour_included, a.colour_rate_cents, a.due_days
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
-- customer_balances (CUS-04/05): issued, unpaid invoices minus what was paid.
-- security_invoker: RLS on invoices decides what each caller sees.
-- Credits are not netted yet (PAY-12).
-- -----------------------------------------------------------------------------
create view public.customer_balances
with (security_invoker = true) as
select i.owner_id,
       i.customer_id,
       sum(i.total_cents - i.amount_paid_cents)::bigint as outstanding_cents,
       count(*)::integer as unpaid_invoices
from public.invoices i
where i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
group by i.owner_id, i.customer_id;

revoke all on public.customer_balances from anon, authenticated;
grant select on public.customer_balances to authenticated;

-- -----------------------------------------------------------------------------
-- Grants: app.* service_role only; public.rpc_* wrappers service_role only.
-- -----------------------------------------------------------------------------
revoke execute on function
  app.cycle_date(date, integer, integer),
  app.cycle_in_progress(date, integer, date),
  app.rental_agreement_initial_terms(),
  app.machine_before_write(),
  app.last_known_reading(uuid, public.counter_type),
  app.agreement_return_blockers(uuid),
  app.json_count(jsonb, text, text),
  app.assign_machine(uuid, uuid, uuid, jsonb, date),
  app.return_machine(uuid, uuid, jsonb, text, date),
  app.reassign_machine(uuid, uuid, jsonb, text, uuid, jsonb, date),
  app.update_agreement_terms(uuid, uuid, jsonb, text, date),
  app.set_machine_status(uuid, uuid, public.machine_status, text)
from public, anon, authenticated;

grant execute on function
  app.cycle_date(date, integer, integer),
  app.cycle_in_progress(date, integer, date),
  app.last_known_reading(uuid, public.counter_type),
  app.agreement_return_blockers(uuid),
  app.json_count(jsonb, text, text),
  app.assign_machine(uuid, uuid, uuid, jsonb, date),
  app.return_machine(uuid, uuid, jsonb, text, date),
  app.reassign_machine(uuid, uuid, jsonb, text, uuid, jsonb, date),
  app.update_agreement_terms(uuid, uuid, jsonb, text, date),
  app.set_machine_status(uuid, uuid, public.machine_status, text)
to service_role;

create function public.rpc_assign_machine(
  p_actor_id uuid,
  p_machine_id uuid,
  p_customer_id uuid,
  p_terms jsonb,
  p_today date
) returns jsonb
language sql
set search_path = ''
as $$
  select app.assign_machine(p_actor_id, p_machine_id, p_customer_id, p_terms, p_today);
$$;

create function public.rpc_return_machine(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_closing jsonb,
  p_reason text,
  p_today date
) returns jsonb
language sql
set search_path = ''
as $$
  select app.return_machine(p_actor_id, p_agreement_id, p_closing, p_reason, p_today);
$$;

create function public.rpc_reassign_machine(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_closing jsonb,
  p_reason text,
  p_customer_id uuid,
  p_terms jsonb,
  p_today date
) returns jsonb
language sql
set search_path = ''
as $$
  select app.reassign_machine(p_actor_id, p_agreement_id, p_closing, p_reason, p_customer_id, p_terms, p_today);
$$;

create function public.rpc_update_agreement_terms(
  p_actor_id uuid,
  p_agreement_id uuid,
  p_terms jsonb,
  p_note text,
  p_today date
) returns jsonb
language sql
set search_path = ''
as $$
  select app.update_agreement_terms(p_actor_id, p_agreement_id, p_terms, p_note, p_today);
$$;

create function public.rpc_set_machine_status(
  p_actor_id uuid,
  p_machine_id uuid,
  p_status public.machine_status,
  p_reason text
) returns jsonb
language sql
set search_path = ''
as $$
  select app.set_machine_status(p_actor_id, p_machine_id, p_status, p_reason);
$$;

revoke execute on function
  public.rpc_assign_machine(uuid, uuid, uuid, jsonb, date),
  public.rpc_return_machine(uuid, uuid, jsonb, text, date),
  public.rpc_reassign_machine(uuid, uuid, jsonb, text, uuid, jsonb, date),
  public.rpc_update_agreement_terms(uuid, uuid, jsonb, text, date),
  public.rpc_set_machine_status(uuid, uuid, public.machine_status, text)
from public, anon, authenticated;

grant execute on function
  public.rpc_assign_machine(uuid, uuid, uuid, jsonb, date),
  public.rpc_return_machine(uuid, uuid, jsonb, text, date),
  public.rpc_reassign_machine(uuid, uuid, jsonb, text, uuid, jsonb, date),
  public.rpc_update_agreement_terms(uuid, uuid, jsonb, text, date),
  public.rpc_set_machine_status(uuid, uuid, public.machine_status, text)
to service_role;
