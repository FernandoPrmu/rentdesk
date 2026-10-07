-- =============================================================================
-- 0006 Service requests (spec 7, SRV-01..09).  SERVER-WRITE-ONLY.
-- Customers raise requests and owners progress them through server actions.
-- =============================================================================

create table public.service_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  customer_id uuid not null,
  machine_id uuid not null,
  agreement_id uuid,
  type public.service_request_type not null,
  description text not null check (length(btrim(description)) between 1 and 2000),
  urgency public.urgency not null default 'NORMAL',
  status public.service_request_status not null default 'NEW',
  toner_colours public.toner_colour[] not null default '{}',
  part_name text,
  preferred_date date,
  assigned_to_name text,
  planned_date date,
  work_done text,
  parts_used text,
  cost_cents bigint check (cost_cents >= 0),
  rating smallint check (rating between 1 and 5),
  rating_comment text,
  escalation_level smallint not null default 0 check (escalation_level >= 0),
  idempotency_key uuid,
  created_by uuid not null references public.profiles (id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_requests_idempotency_key unique (idempotency_key),
  constraint service_requests_id_owner_key unique (id, owner_id),
  constraint service_requests_toner_only check (type = 'TONER' or cardinality(toner_colours) = 0),
  constraint service_requests_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id),
  constraint service_requests_machine_fkey foreign key (machine_id, owner_id)
    references public.machines (id, owner_id),
  constraint service_requests_agreement_fkey foreign key (agreement_id, owner_id)
    references public.rental_agreements (id, owner_id)
);
create index service_requests_owner_id_idx on public.service_requests (owner_id, status);
create index service_requests_customer_idx on public.service_requests (customer_id, owner_id);
create index service_requests_machine_idx on public.service_requests (machine_id, owner_id);
create index service_requests_agreement_idx on public.service_requests (agreement_id, owner_id);
create index service_requests_created_by_idx on public.service_requests (created_by);
-- Acknowledgement escalation sweep (SRV-08).
create index service_requests_unacknowledged_idx on public.service_requests (created_at) where status = 'NEW';

create table public.service_request_history (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  request_id uuid not null,
  from_status public.service_request_status,
  to_status public.service_request_status not null,
  note text,
  changed_by uuid references public.profiles (id),
  changed_at timestamptz not null default clock_timestamp(),
  constraint service_request_history_request_fkey foreign key (request_id, owner_id)
    references public.service_requests (id, owner_id)
);
create index service_request_history_owner_id_idx on public.service_request_history (owner_id);
create index service_request_history_request_idx on public.service_request_history (request_id, owner_id, changed_at);
create index service_request_history_changed_by_idx on public.service_request_history (changed_by);

-- History row for every status change, in the same transaction. Server code may
-- set `app.status_note` (transaction-local) to attach a note.
create function app.record_service_request_status() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.service_request_history (owner_id, request_id, from_status, to_status, note, changed_by)
    values (
      new.owner_id,
      new.id,
      case when tg_op = 'UPDATE' then old.status end,
      new.status,
      nullif(current_setting('app.status_note', true), ''),
      app.resolve_actor()
    );
  end if;
  return null;
end;
$$;

create trigger service_requests_history after insert or update of status on public.service_requests
  for each row execute function app.record_service_request_status();
create trigger service_requests_set_updated_at before update on public.service_requests
  for each row execute function app.set_updated_at();
create trigger service_requests_audit after insert or update or delete on public.service_requests
  for each row execute function app.audit_row_change('status');
