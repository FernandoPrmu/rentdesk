-- =============================================================================
-- 0003 Machines, rental agreements, meter baselines.
-- Owners write these directly (RLS-checked, column-limited grants in 0009).
-- =============================================================================

create table public.machines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  brand text not null check (length(btrim(brand)) > 0),
  model text not null check (length(btrim(model)) > 0),
  serial_no text not null check (length(btrim(serial_no)) > 0),
  type public.machine_type not null,
  status public.machine_status not null default 'AVAILABLE',
  purchase_date date,
  -- Highest value the counter shows before rolling over to 0 (spec 11.2).
  bw_counter_max bigint check (bw_counter_max > 0),
  colour_counter_max bigint check (colour_counter_max > 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint machines_serial_per_owner_key unique (owner_id, serial_no),
  constraint machines_id_owner_key unique (id, owner_id),
  constraint machines_colour_counter_only_colour check (type = 'COLOUR' or colour_counter_max is null)
);
create index machines_owner_id_idx on public.machines (owner_id, status);

create trigger machines_set_updated_at before update on public.machines
  for each row execute function app.set_updated_at();
create trigger machines_audit after insert or update or delete on public.machines
  for each row execute function app.audit_row_change('status');

-- -----------------------------------------------------------------------------
-- rental_agreements. The agreement is also the machine assignment (MAC-02/04):
-- installation location, initial and closing readings live here.
-- Terms edited mid-cycle do not affect an open ticket: each ticket snapshots the
-- terms when it is created (AGR-02, spec 11.3). Edits are kept in audit_logs.
-- -----------------------------------------------------------------------------
create table public.rental_agreements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  customer_id uuid not null,
  machine_id uuid not null,
  status public.agreement_status not null default 'ACTIVE',
  start_date date not null,
  end_date date,
  cycle_length_days integer not null default 30 check (cycle_length_days between 1 and 366),
  billing_day smallint check (billing_day between 1 and 31),
  due_days integer not null default 7 check (due_days between 0 and 120),
  monthly_commitment_cents bigint not null check (monthly_commitment_cents >= 0),
  bw_included bigint not null default 0 check (bw_included >= 0),
  bw_rate_cents bigint not null check (bw_rate_cents >= 0),
  colour_included bigint check (colour_included >= 0),
  colour_rate_cents bigint check (colour_rate_cents >= 0),
  installation_location text,
  initial_bw_reading bigint not null default 0 check (initial_bw_reading >= 0),
  initial_colour_reading bigint check (initial_colour_reading >= 0),
  closing_bw_reading bigint check (closing_bw_reading >= 0),
  closing_colour_reading bigint check (closing_colour_reading >= 0),
  -- Cycle calendar (TKT-07): maintained by app.open_billing_cycle, never by clients.
  next_cycle_no integer not null default 1 check (next_cycle_no >= 1),
  next_cycle_date date not null,
  terminated_at timestamptz,
  termination_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rental_agreements_dates check (end_date is null or end_date >= start_date),
  constraint rental_agreements_colour_terms check ((colour_included is null) = (colour_rate_cents is null)),
  constraint rental_agreements_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id),
  constraint rental_agreements_machine_fkey foreign key (machine_id, owner_id)
    references public.machines (id, owner_id),
  constraint rental_agreements_id_owner_key unique (id, owner_id)
);
create index rental_agreements_owner_id_idx on public.rental_agreements (owner_id);
create index rental_agreements_customer_idx on public.rental_agreements (customer_id, owner_id);
create index rental_agreements_machine_idx on public.rental_agreements (machine_id, owner_id);
-- The daily cron looks for active agreements whose next cycle is due.
create index rental_agreements_due_idx on public.rental_agreements (next_cycle_date) where status = 'ACTIVE';
-- A machine can be on only one live (active or suspended) agreement at a time.
create unique index rental_agreements_one_live_per_machine
  on public.rental_agreements (machine_id) where status <> 'TERMINATED';

-- Validate terms against the machine and initialise the cycle calendar.
create function app.rental_agreement_before_write() returns trigger
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
                                  or new.initial_colour_reading is not null) then
    raise exception using errcode = 'RD400', message = 'Mono machines cannot have colour terms or readings';
  end if;
  if v_machine.type = 'COLOUR' and new.initial_colour_reading is null then
    new.initial_colour_reading := 0;
  end if;

  if tg_op = 'INSERT' then
    if v_machine.status = 'RETIRED' then
      raise exception using errcode = 'RD400', message = 'A retired machine cannot be rented';
    end if;
    -- First ticket is due one cycle after the start date (spec 5.5).
    new.next_cycle_no := 1;
    new.next_cycle_date := new.start_date + new.cycle_length_days;
  end if;

  if new.status = 'TERMINATED' and new.terminated_at is null then
    new.terminated_at := now();
  end if;
  return new;
end;
$$;

-- Keep machine status in step with its agreement (same transaction).
create function app.rental_agreement_sync_machine() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('ACTIVE', 'SUSPENDED') then
    update public.machines set status = 'RENTED'
    where id = new.machine_id and status <> 'RENTED';
  elsif new.status = 'TERMINATED' and (tg_op = 'INSERT' or old.status <> 'TERMINATED') then
    update public.machines set status = 'AVAILABLE'
    where id = new.machine_id and status = 'RENTED';
  end if;
  return null;
end;
$$;

create trigger rental_agreements_before_write before insert or update on public.rental_agreements
  for each row execute function app.rental_agreement_before_write();
create trigger rental_agreements_sync_machine after insert or update of status on public.rental_agreements
  for each row execute function app.rental_agreement_sync_machine();
create trigger rental_agreements_set_updated_at before update on public.rental_agreements
  for each row execute function app.set_updated_at();
create trigger rental_agreements_audit after insert or update or delete on public.rental_agreements
  for each row execute function app.audit_row_change('all');

-- -----------------------------------------------------------------------------
-- meter_baselines: owner records a new baseline after a meter replacement or reset
-- (spec 6.4, 11.8). Billing uses the latest baseline after the last verified reading.
-- -----------------------------------------------------------------------------
create table public.meter_baselines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  agreement_id uuid not null,
  counter_type public.counter_type not null,
  value bigint not null check (value >= 0),
  reason text not null check (length(btrim(reason)) > 0),
  recorded_by uuid not null default auth.uid() references public.profiles (id),
  recorded_at timestamptz not null default now(),
  constraint meter_baselines_agreement_fkey foreign key (agreement_id, owner_id)
    references public.rental_agreements (id, owner_id)
);
create index meter_baselines_owner_id_idx on public.meter_baselines (owner_id);
create index meter_baselines_agreement_idx on public.meter_baselines (agreement_id, owner_id, recorded_at desc);
create index meter_baselines_recorded_by_idx on public.meter_baselines (recorded_by);

create trigger meter_baselines_audit after insert or update or delete on public.meter_baselines
  for each row execute function app.audit_row_change('all');
