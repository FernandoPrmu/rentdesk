-- =============================================================================
-- 0005 Payments, payment slips, disputes, credits.  ALL SERVER-WRITE-ONLY.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- payments (spec 8, PAY-02..12). Customer slips and owner-recorded cash/cheque.
-- -----------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  invoice_id uuid not null,
  ticket_id uuid not null,
  customer_id uuid not null,
  source public.payment_source not null,
  method public.payment_method not null,
  amount_cents bigint not null check (amount_cents > 0),
  accepted_amount_cents bigint check (accepted_amount_cents >= 0),
  paid_on date not null,
  reference text,
  note text,
  status public.payment_status not null default 'SUBMITTED',
  idempotency_key uuid,
  submitted_by uuid not null references public.profiles (id),
  submitted_at timestamptz not null default now(),
  verified_by uuid references public.profiles (id),
  verified_at timestamptz,
  reject_reason text,
  -- PAY-11: earlier payment with the same bank reference or slip fingerprint.
  duplicate_of_payment_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_idempotency_key unique (idempotency_key),
  constraint payments_id_owner_key unique (id, owner_id),
  constraint payments_reject_reason check (status <> 'REJECTED' or coalesce(length(btrim(reject_reason)), 0) > 0),
  constraint payments_accepted_amount check (status not in ('ACCEPTED', 'PARTIAL') or accepted_amount_cents is not null),
  constraint payments_invoice_fkey foreign key (invoice_id, owner_id)
    references public.invoices (id, owner_id),
  constraint payments_ticket_fkey foreign key (ticket_id, owner_id)
    references public.billing_cycle_tickets (id, owner_id),
  constraint payments_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id),
  constraint payments_duplicate_of_fkey foreign key (duplicate_of_payment_id, owner_id)
    references public.payments (id, owner_id)
);
create index payments_owner_id_idx on public.payments (owner_id, status);
create index payments_invoice_idx on public.payments (invoice_id, owner_id);
create index payments_ticket_idx on public.payments (ticket_id, owner_id);
create index payments_customer_idx on public.payments (customer_id, owner_id);
create index payments_duplicate_of_idx on public.payments (duplicate_of_payment_id, owner_id);
create index payments_submitted_by_idx on public.payments (submitted_by);
create index payments_verified_by_idx on public.payments (verified_by);
create index payments_reference_idx on public.payments (owner_id, lower(reference)) where reference is not null;
-- One slip waiting for verification per ticket at a time.
create unique index payments_one_pending_per_ticket on public.payments (ticket_id) where status = 'SUBMITTED';

create trigger payments_set_updated_at before update on public.payments
  for each row execute function app.set_updated_at();
create trigger payments_audit after insert or update or delete on public.payments
  for each row execute function app.audit_row_change('status');

-- -----------------------------------------------------------------------------
-- payment_slips: kept as proof (unlike meter photos). Type and size are checked
-- by magic bytes in server code and again by the bucket config.
-- -----------------------------------------------------------------------------
create table public.payment_slips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  payment_id uuid not null,
  storage_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  uploaded_by uuid not null references public.profiles (id),
  uploaded_at timestamptz not null default now(),
  retention_until date,
  created_at timestamptz not null default now(),
  constraint payment_slips_storage_path_key unique (storage_path),
  constraint payment_slips_path_in_tenant check (storage_path like owner_id::text || '/%'),
  constraint payment_slips_payment_fkey foreign key (payment_id, owner_id)
    references public.payments (id, owner_id)
);
create index payment_slips_owner_id_idx on public.payment_slips (owner_id);
create index payment_slips_payment_idx on public.payment_slips (payment_id, owner_id);
create index payment_slips_uploaded_by_idx on public.payment_slips (uploaded_by);
create index payment_slips_sha256_idx on public.payment_slips (owner_id, sha256);

-- -----------------------------------------------------------------------------
-- disputes (spec 11.4, CP-06)
-- -----------------------------------------------------------------------------
create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  invoice_id uuid not null,
  ticket_id uuid not null,
  customer_id uuid not null,
  raised_by uuid not null references public.profiles (id),
  reason text not null check (length(btrim(reason)) > 0),
  status public.dispute_status not null default 'OPEN',
  resolution text,
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint disputes_resolution check (status = 'OPEN' or coalesce(length(btrim(resolution)), 0) > 0),
  constraint disputes_invoice_fkey foreign key (invoice_id, owner_id)
    references public.invoices (id, owner_id),
  constraint disputes_ticket_fkey foreign key (ticket_id, owner_id)
    references public.billing_cycle_tickets (id, owner_id),
  constraint disputes_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id)
);
create index disputes_owner_id_idx on public.disputes (owner_id, status);
create index disputes_invoice_idx on public.disputes (invoice_id, owner_id);
create index disputes_ticket_idx on public.disputes (ticket_id, owner_id);
create index disputes_customer_idx on public.disputes (customer_id, owner_id);
create index disputes_raised_by_idx on public.disputes (raised_by);
create index disputes_resolved_by_idx on public.disputes (resolved_by);
create unique index disputes_one_open_per_invoice on public.disputes (invoice_id) where status = 'OPEN';

create trigger disputes_set_updated_at before update on public.disputes
  for each row execute function app.set_updated_at();
create trigger disputes_audit after insert or update or delete on public.disputes
  for each row execute function app.audit_row_change('status');

-- -----------------------------------------------------------------------------
-- credits (PAY-12, spec 11.4-11.6): overpayments, estimate reconciliation,
-- payments kept after a cancelled invoice, advances.
-- -----------------------------------------------------------------------------
create table public.credits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  customer_id uuid not null,
  source_invoice_id uuid,
  source_payment_id uuid,
  kind public.credit_kind not null,
  status public.credit_status not null default 'AVAILABLE',
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null check (length(btrim(reason)) > 0),
  applied_to_invoice_id uuid,
  applied_at timestamptz,
  refunded_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credits_applied check (status <> 'APPLIED' or applied_to_invoice_id is not null),
  constraint credits_customer_fkey foreign key (customer_id, owner_id)
    references public.customers (id, owner_id),
  constraint credits_source_invoice_fkey foreign key (source_invoice_id, owner_id)
    references public.invoices (id, owner_id),
  constraint credits_source_payment_fkey foreign key (source_payment_id, owner_id)
    references public.payments (id, owner_id),
  constraint credits_applied_to_fkey foreign key (applied_to_invoice_id, owner_id)
    references public.invoices (id, owner_id)
);
create index credits_owner_id_idx on public.credits (owner_id, status);
create index credits_customer_idx on public.credits (customer_id, owner_id);
create index credits_source_invoice_idx on public.credits (source_invoice_id, owner_id);
create index credits_source_payment_idx on public.credits (source_payment_id, owner_id);
create index credits_applied_to_idx on public.credits (applied_to_invoice_id, owner_id);
create index credits_created_by_idx on public.credits (created_by);

create trigger credits_set_updated_at before update on public.credits
  for each row execute function app.set_updated_at();
create trigger credits_audit after insert or update or delete on public.credits
  for each row execute function app.audit_row_change('status');
