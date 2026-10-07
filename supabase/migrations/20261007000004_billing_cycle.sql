-- =============================================================================
-- 0004 Billing cycle: tickets, ticket events/comments, meter submissions,
-- readings, photos, invoices, invoice lines, per-owner invoice counters.
--
-- ALL TABLES HERE ARE SERVER-WRITE-ONLY. Every change goes through the atomic
-- workflow functions in 0008 (called by src/lib/tickets with the service role).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- billing_cycle_tickets (spec 5, TKT-01..13)
-- -----------------------------------------------------------------------------
create table public.billing_cycle_tickets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  customer_id uuid not null,
  agreement_id uuid not null,
  machine_id uuid not null,
  cycle_no integer not null check (cycle_no >= 1),
  cycle_date date not null,
  period_start date not null,
  period_end date not null,
  status public.ticket_status not null default 'METER_REQUESTED',
  -- Where an OVERDUE ticket returns to (spec 5.3 "returns to the normal flow").
  status_before_overdue public.ticket_status,
  stage_due_at timestamptz,
  escalation_level smallint not null default 0 check (escalation_level >= 0),
  reminder_count smallint not null default 0 check (reminder_count >= 0),
  last_reminder_at timestamptz,
  rejection_count smallint not null default 0 check (rejection_count >= 0),
  is_late boolean not null default false,
  paused_at timestamptz,
  -- Terms snapshot taken when the ticket is created (AGR-02, spec 11.3).
  machine_type public.machine_type not null,
  cycle_length_days integer not null,
  commitment_cents bigint not null check (commitment_cents >= 0),
  bw_included bigint not null check (bw_included >= 0),
  bw_rate_cents bigint not null check (bw_rate_cents >= 0),
  colour_included bigint check (colour_included >= 0),
  colour_rate_cents bigint check (colour_rate_cents >= 0),
  current_invoice_id uuid,
  closed_at timestamptz,
  closed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- TKT-08: one ticket per agreement per cycle.
  constraint billing_cycle_tickets_agreement_cycle_key unique (agreement_id, cycle_no),
  constraint billing_cycle_tickets_id_owner_key unique (id, owner_id),
  constraint billing_cycle_tickets_period check (period_end >= period_start),
  constraint billing_cycle_tickets_overdue_origin check ((status = 'OVERDUE') = (status_before_overdue is not null)),
  constraint billing_cycle_tickets_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id),
  constraint billing_cycle_tickets_agreement_fkey foreign key (agreement_id, owner_id)
    references public.rental_agreements (id, owner_id),
  constraint billing_cycle_tickets_machine_fkey foreign key (machine_id, owner_id)
    references public.machines (id, owner_id)
);
comment on table public.billing_cycle_tickets is
  'One ticket per agreement per cycle. SERVER-WRITE-ONLY (app.* workflow functions).';
create index billing_cycle_tickets_owner_id_idx on public.billing_cycle_tickets (owner_id, status);
create index billing_cycle_tickets_customer_idx on public.billing_cycle_tickets (customer_id, owner_id);
create index billing_cycle_tickets_agreement_idx on public.billing_cycle_tickets (agreement_id, owner_id);
create index billing_cycle_tickets_machine_idx on public.billing_cycle_tickets (machine_id, owner_id);
create index billing_cycle_tickets_closed_by_idx on public.billing_cycle_tickets (closed_by);
-- Reminder / escalation sweep.
create index billing_cycle_tickets_stage_due_idx on public.billing_cycle_tickets (stage_due_at)
  where status not in ('CLOSED', 'CANCELLED');

create trigger billing_cycle_tickets_set_updated_at before update on public.billing_cycle_tickets
  for each row execute function app.set_updated_at();
create trigger billing_cycle_tickets_audit after insert or update or delete on public.billing_cycle_tickets
  for each row execute function app.audit_row_change('status');

-- -----------------------------------------------------------------------------
-- ticket_events (TKT-09): actor, from, to, reason. SERVER-WRITE-ONLY.
-- -----------------------------------------------------------------------------
create table public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  ticket_id uuid not null,
  event_type public.ticket_event_type not null,
  from_status public.ticket_status,
  to_status public.ticket_status,
  actor_id uuid references public.profiles (id),
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  -- clock_timestamp(): events written in one transaction stay in order.
  created_at timestamptz not null default clock_timestamp(),
  constraint ticket_events_ticket_fkey foreign key (ticket_id, owner_id)
    references public.billing_cycle_tickets (id, owner_id)
);
create index ticket_events_owner_id_idx on public.ticket_events (owner_id);
create index ticket_events_ticket_idx on public.ticket_events (ticket_id, owner_id, created_at);
create index ticket_events_actor_id_idx on public.ticket_events (actor_id);

-- -----------------------------------------------------------------------------
-- ticket_comments (TKT-11). SERVER-WRITE-ONLY (customers and owners comment via server actions).
-- -----------------------------------------------------------------------------
create table public.ticket_comments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  ticket_id uuid not null,
  author_id uuid not null references public.profiles (id),
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint ticket_comments_ticket_fkey foreign key (ticket_id, owner_id)
    references public.billing_cycle_tickets (id, owner_id)
);
create index ticket_comments_owner_id_idx on public.ticket_comments (owner_id);
create index ticket_comments_ticket_idx on public.ticket_comments (ticket_id, owner_id, created_at);
create index ticket_comments_author_id_idx on public.ticket_comments (author_id);

-- -----------------------------------------------------------------------------
-- meter_submissions: one attempt to submit readings for a ticket (customer or
-- owner manual entry). SERVER-WRITE-ONLY.
-- -----------------------------------------------------------------------------
create table public.meter_submissions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  ticket_id uuid not null,
  customer_id uuid not null,
  attempt_no smallint not null check (attempt_no >= 1),
  source public.reading_source not null,
  status public.meter_submission_status not null default 'PENDING_REVIEW',
  -- INV-13: client-generated key; retries return the original result.
  idempotency_key uuid not null,
  submitted_by uuid not null references public.profiles (id),
  submitted_at timestamptz not null default now(), -- server timestamp (INV-14)
  note text,
  anomaly_flag text check (anomaly_flag in ('HIGH', 'LOW', 'ZERO')),
  invoice_id uuid,
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  reject_reason text,
  created_at timestamptz not null default now(),
  constraint meter_submissions_idempotency_key unique (idempotency_key),
  constraint meter_submissions_attempt_key unique (ticket_id, attempt_no),
  constraint meter_submissions_id_owner_key unique (id, owner_id),
  constraint meter_submissions_reject_reason check (status <> 'REJECTED' or coalesce(length(btrim(reject_reason)), 0) > 0),
  constraint meter_submissions_manual_note check (source <> 'OWNER_MANUAL' or coalesce(length(btrim(note)), 0) > 0),
  constraint meter_submissions_ticket_fkey foreign key (ticket_id, owner_id)
    references public.billing_cycle_tickets (id, owner_id),
  constraint meter_submissions_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id)
);
create index meter_submissions_owner_id_idx on public.meter_submissions (owner_id);
create index meter_submissions_customer_idx on public.meter_submissions (customer_id, owner_id);
create index meter_submissions_invoice_idx on public.meter_submissions (invoice_id, owner_id);
create index meter_submissions_submitted_by_idx on public.meter_submissions (submitted_by);
create index meter_submissions_reviewed_by_idx on public.meter_submissions (reviewed_by);
-- INV-04: only one active submission per ticket.
create unique index meter_submissions_one_pending_per_ticket
  on public.meter_submissions (ticket_id) where status = 'PENDING_REVIEW';

create trigger meter_submissions_audit after insert or update or delete on public.meter_submissions
  for each row execute function app.audit_row_change('status');

-- -----------------------------------------------------------------------------
-- meter_readings: kept permanently as the audit record (INV-10). SERVER-WRITE-ONLY.
-- -----------------------------------------------------------------------------
create table public.meter_readings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  submission_id uuid not null,
  counter_type public.counter_type not null,
  previous_value bigint not null check (previous_value >= 0),
  current_value bigint not null check (current_value >= 0),
  rolled_over boolean not null default false,
  corrected_from_value bigint,
  correction_note text,
  corrected_by uuid references public.profiles (id),
  corrected_at timestamptz,
  created_at timestamptz not null default now(),
  constraint meter_readings_counter_key unique (submission_id, counter_type),
  constraint meter_readings_not_lower check (rolled_over or current_value >= previous_value),
  constraint meter_readings_correction_note check (corrected_from_value is null or coalesce(length(btrim(correction_note)), 0) > 0),
  constraint meter_readings_submission_fkey foreign key (submission_id, owner_id)
    references public.meter_submissions (id, owner_id)
);
create index meter_readings_owner_id_idx on public.meter_readings (owner_id);
create index meter_readings_corrected_by_idx on public.meter_readings (corrected_by);
create trigger meter_readings_audit after update or delete on public.meter_readings
  for each row execute function app.audit_row_change('all');

-- -----------------------------------------------------------------------------
-- meter_photos: temporary. The storage object is removed by server code after the
-- owner confirms (delete_requested_at set atomically by the confirm function,
-- deleted_at set once the object is gone). The row stays as the audit record.
-- SERVER-WRITE-ONLY.
-- -----------------------------------------------------------------------------
create table public.meter_photos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  submission_id uuid not null,
  storage_path text not null,
  captured_at timestamptz,                         -- reported by the device
  uploaded_at timestamptz not null default now(),  -- server timestamp (INV-14)
  expires_at timestamptz,
  delete_requested_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint meter_photos_submission_key unique (submission_id),
  constraint meter_photos_storage_path_key unique (storage_path),
  constraint meter_photos_path_in_tenant check (storage_path like owner_id::text || '/%'),
  constraint meter_photos_submission_fkey foreign key (submission_id, owner_id)
    references public.meter_submissions (id, owner_id)
);
create index meter_photos_owner_id_idx on public.meter_photos (owner_id);
-- Purge sweep: photos waiting for deletion or past retention.
create index meter_photos_purge_idx on public.meter_photos (coalesce(delete_requested_at, expires_at))
  where deleted_at is null;

-- -----------------------------------------------------------------------------
-- invoices (spec 6.6, PAY-01). Money is never silently edited: invoices are
-- cancelled and reissued (replaces_invoice_id). SERVER-WRITE-ONLY.
-- invoice_no is assigned only when the invoice is issued (gap-free, INV-11).
-- -----------------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  customer_id uuid not null,
  agreement_id uuid not null,
  machine_id uuid not null,
  ticket_id uuid not null,
  invoice_seq bigint,
  invoice_no text,
  type public.invoice_type not null default 'NORMAL',
  status public.invoice_status not null default 'DRAFT',
  period_start date not null,
  period_end date not null,
  cycles_covered smallint not null default 1 check (cycles_covered >= 1),
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  late_fee_cents bigint not null default 0 check (late_fee_cents >= 0),
  credit_applied_cents bigint not null default 0 check (credit_applied_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  due_date date,
  confirmed_by uuid references public.profiles (id),
  confirmed_at timestamptz,
  issued_at timestamptz,
  cancelled_by uuid references public.profiles (id),
  cancelled_at timestamptz,
  cancel_reason text,
  replaces_invoice_id uuid,
  -- Owner branding at issue time, so later edits never change an issued invoice (BRD-03).
  branding_snapshot jsonb,
  pdf_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_owner_invoice_no_key unique (owner_id, invoice_no),
  constraint invoices_owner_invoice_seq_key unique (owner_id, invoice_seq),
  constraint invoices_id_owner_key unique (id, owner_id),
  constraint invoices_period check (period_end >= period_start),
  constraint invoices_total check (total_cents = subtotal_cents + late_fee_cents - credit_applied_cents),
  constraint invoices_paid_le_total check (amount_paid_cents <= total_cents),
  constraint invoices_number_when_issued check (invoice_no is not null or status in ('DRAFT', 'REJECTED', 'CANCELLED')),
  constraint invoices_cancel_reason check (status <> 'CANCELLED' or coalesce(length(btrim(cancel_reason)), 0) > 0),
  constraint invoices_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id),
  constraint invoices_agreement_fkey foreign key (agreement_id, owner_id)
    references public.rental_agreements (id, owner_id),
  constraint invoices_machine_fkey foreign key (machine_id, owner_id)
    references public.machines (id, owner_id),
  constraint invoices_ticket_fkey foreign key (ticket_id, owner_id)
    references public.billing_cycle_tickets (id, owner_id),
  constraint invoices_replaces_fkey foreign key (replaces_invoice_id, owner_id)
    references public.invoices (id, owner_id)
);
comment on table public.invoices is 'SERVER-WRITE-ONLY. Customers never see DRAFT or REJECTED invoices.';
create index invoices_owner_id_idx on public.invoices (owner_id, status);
create index invoices_customer_idx on public.invoices (customer_id, owner_id);
create index invoices_agreement_idx on public.invoices (agreement_id, owner_id);
create index invoices_machine_idx on public.invoices (machine_id, owner_id);
create index invoices_ticket_idx on public.invoices (ticket_id, owner_id);
create index invoices_replaces_idx on public.invoices (replaces_invoice_id, owner_id);
create index invoices_confirmed_by_idx on public.invoices (confirmed_by);
create index invoices_cancelled_by_idx on public.invoices (cancelled_by);
create index invoices_due_date_idx on public.invoices (due_date)
  where status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE');
-- One live invoice per ticket; rejected drafts and cancelled invoices are history.
create unique index invoices_one_live_per_ticket
  on public.invoices (ticket_id) where status not in ('REJECTED', 'CANCELLED');

create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function app.set_updated_at();
create trigger invoices_audit after insert or update or delete on public.invoices
  for each row execute function app.audit_row_change('status');

alter table public.billing_cycle_tickets
  add constraint billing_cycle_tickets_current_invoice_fkey foreign key (current_invoice_id, owner_id)
  references public.invoices (id, owner_id);
create index billing_cycle_tickets_current_invoice_idx
  on public.billing_cycle_tickets (current_invoice_id, owner_id);

alter table public.meter_submissions
  add constraint meter_submissions_invoice_fkey foreign key (invoice_id, owner_id)
  references public.invoices (id, owner_id);

-- -----------------------------------------------------------------------------
-- invoice_lines. SERVER-WRITE-ONLY.
-- -----------------------------------------------------------------------------
create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  invoice_id uuid not null,
  line_type public.invoice_line_type not null,
  description text not null,
  quantity bigint not null default 1,
  rate_cents bigint not null,
  amount_cents bigint not null,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint invoice_lines_sign check (line_type in ('CREDIT', 'ADJUSTMENT') or amount_cents >= 0),
  constraint invoice_lines_invoice_fkey foreign key (invoice_id, owner_id)
    references public.invoices (id, owner_id)
);
create index invoice_lines_owner_id_idx on public.invoice_lines (owner_id);
create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id, owner_id, sort_order);

-- -----------------------------------------------------------------------------
-- invoice_counters: one row per owner. Numbers are taken by
-- app.assign_invoice_number() inside the issuing transaction: the UPDATE row lock
-- serialises concurrent issuers, and a rollback also rolls back the increment,
-- so numbers are unique, ordered and gap-free. SERVER-WRITE-ONLY.
-- -----------------------------------------------------------------------------
create table public.invoice_counters (
  owner_id uuid primary key references public.owners (id),
  prefix text not null default 'INV-' check (prefix ~ '^[A-Za-z0-9/_-]{0,12}$'),
  last_value bigint not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now()
);
