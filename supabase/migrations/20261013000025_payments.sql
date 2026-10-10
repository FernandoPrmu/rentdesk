-- =============================================================================
-- 0025 Payments (task 7; PAY-01..13, TKT-10, CP-04, CP-05; decisions 39-46).
--
-- * payment_allocations: a payment is an amount of money received; its
--   allocations split it over one or more invoices (one bank transfer for
--   several bills). Oldest due first within the chosen invoices; what is left
--   becomes a customer credit (decision 39). payments.invoice_id / ticket_id are
--   gone (backfilled into allocations).
-- * Customer slips: several invoices, duplicate flags (same file, or same bank
--   reference and amount), stored at {owner}/{customer}/{slip id}.{ext}.
-- * Owner: verify (accept / accept another amount / reject), record a payment
--   without a slip (or an advance with no invoice), reverse an accepted payment
--   (TKT-10, 11.5), reallocate it to other invoices (11.5), refund a credit
--   (PAY-12).
-- * Every ticket change a payment causes goes through app.settle_invoice_payment,
--   which walks the allowed transitions (spec 5.3) and writes each event.
-- * receipts: one per accepted payment, numbered per owner without gaps
--   (receipt_counters, like invoice numbers), with a content snapshot and PDF
--   versions (v1 issued, then REVERSED / REALLOCATED); private bucket `receipts`.
-- * credits: refunds (credit_refunds, refunded_cents), VOID when the payment
--   that made them is reversed.
-- =============================================================================

-- =============================================================================
-- A. Helpers
-- =============================================================================

-- Payment stage deadline: 00:00 Colombo the day after the due date (paymentDeadline).
create function app.payment_stage_due(p_due_date date) returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case when p_due_date is null then null else ((p_due_date + 1)::timestamp at time zone 'Asia/Colombo') end;
$$;

-- Spec 5.3 plus one edge (decision 42): a partly paid ticket whose only payment is
-- reversed goes back to Awaiting payment.
create or replace function app.ticket_transition_allowed(p_from public.ticket_status, p_to public.ticket_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'METER_REQUESTED'      then p_to in ('PENDING_OWNER_REVIEW', 'OVERDUE', 'CANCELLED')
    when 'PENDING_OWNER_REVIEW' then p_to in ('AWAITING_PAYMENT', 'METER_REQUESTED', 'CANCELLED')
    when 'AWAITING_PAYMENT'     then p_to in ('PAYMENT_SUBMITTED', 'OVERDUE', 'DISPUTED', 'CANCELLED')
    when 'PAYMENT_SUBMITTED'    then p_to in ('CLOSED', 'AWAITING_PAYMENT', 'PARTIALLY_PAID')
    when 'PARTIALLY_PAID'       then p_to in ('PAYMENT_SUBMITTED', 'OVERDUE', 'DISPUTED', 'CANCELLED', 'AWAITING_PAYMENT')
    when 'OVERDUE'              then p_to in ('PENDING_OWNER_REVIEW', 'AWAITING_PAYMENT', 'PARTIALLY_PAID',
                                              'PAYMENT_SUBMITTED', 'DISPUTED', 'CANCELLED')
    when 'DISPUTED'             then p_to in ('AWAITING_PAYMENT', 'CANCELLED')
    when 'CLOSED'               then p_to = 'REOPENED'
    when 'REOPENED'             then p_to in ('AWAITING_PAYMENT', 'OVERDUE')
    else false
  end;
$$;

-- The owner's company profile as an issued document keeps it (BRD-03; same keys as
-- src/lib/invoices/branding-snapshot.ts).
create function app.branding_snapshot(p_owner_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'company_name', p.company_name, 'address', p.address, 'phone', p.phone, 'email', p.email,
    'logo_path', p.logo_path, 'bank_name', p.bank_name, 'bank_branch', p.bank_branch,
    'bank_account_name', p.bank_account_name, 'bank_account_no', p.bank_account_no,
    'letterhead_path', p.letterhead_path, 'letterhead_layout', p.letterhead_layout,
    'payment_instructions', p.payment_instructions, 'snapshot_at', now())
  from public.owner_company_profiles p
  where p.owner_id = p_owner_id;
$$;

-- =============================================================================
-- B. Payments, allocations, slips
-- =============================================================================
alter table public.payments
  add column credit_cents bigint not null default 0 check (credit_cents >= 0),
  add column duplicate_reasons text[] not null default '{}'
    check (duplicate_reasons <@ array['FILE', 'REFERENCE']::text[]),
  add column reversed_by uuid references public.profiles (id),
  add column reversed_at timestamptz,
  add column reverse_reason text,
  add constraint payments_reverse_reason check (status <> 'REVERSED' or coalesce(length(btrim(reverse_reason)), 0) > 0),
  add constraint payments_reference_length check (reference is null or length(reference) <= 100);
comment on column public.payments.credit_cents is 'Part of the accepted amount kept as a customer credit (overpayment or advance).';
create index payments_reversed_by_idx on public.payments (reversed_by);
create index payments_customer_status_idx on public.payments (customer_id, owner_id, submitted_at desc);

alter table public.payment_slips
  add column original_sha256 text check (original_sha256 ~ '^[0-9a-f]{64}$');
comment on column public.payment_slips.original_sha256 is
  'SHA-256 of the file as the customer chose it, before the phone made it smaller (duplicate check only).';
create index payment_slips_original_sha256_idx on public.payment_slips (owner_id, original_sha256)
  where original_sha256 is not null;

-- -----------------------------------------------------------------------------
-- payment_allocations. SERVER-WRITE-ONLY.
-- planned_cents: the split when the slip was sent; applied_cents: what the owner
-- accepted for the invoice; balance_after_cents: what was left to pay right after
-- (printed on the receipt). A reallocation releases the rows and adds new ones.
-- -----------------------------------------------------------------------------
create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  payment_id uuid not null,
  invoice_id uuid not null,
  ticket_id uuid not null,
  customer_id uuid not null,
  planned_cents bigint not null check (planned_cents >= 0),
  applied_cents bigint not null default 0 check (applied_cents >= 0),
  balance_after_cents bigint check (balance_after_cents >= 0),
  -- The slip waits for the owner's check (one at a time per ticket).
  waiting boolean not null default false,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_allocations_id_owner_key unique (id, owner_id),
  constraint payment_allocations_released check (released_at is null or not waiting),
  constraint payment_allocations_payment_fkey foreign key (payment_id, owner_id) references public.payments (id, owner_id),
  constraint payment_allocations_invoice_fkey foreign key (invoice_id, owner_id) references public.invoices (id, owner_id),
  constraint payment_allocations_ticket_fkey foreign key (ticket_id, owner_id) references public.billing_cycle_tickets (id, owner_id),
  constraint payment_allocations_customer_fkey foreign key (customer_id, owner_id) references public.customers (id, owner_id)
);
comment on table public.payment_allocations is 'SERVER-WRITE-ONLY. How each payment is split over invoices (decision 39).';
create unique index payment_allocations_active_key on public.payment_allocations (payment_id, invoice_id) where released_at is null;
create unique index payment_allocations_one_waiting_per_ticket on public.payment_allocations (ticket_id) where waiting;
create index payment_allocations_owner_idx on public.payment_allocations (owner_id);
create index payment_allocations_invoice_idx on public.payment_allocations (invoice_id, owner_id);
create index payment_allocations_ticket_idx on public.payment_allocations (ticket_id, owner_id);
create index payment_allocations_customer_idx on public.payment_allocations (customer_id, owner_id);

create trigger payment_allocations_set_updated_at before update on public.payment_allocations
  for each row execute function app.set_updated_at();
create trigger payment_allocations_audit after insert or update or delete on public.payment_allocations
  for each row execute function app.audit_row_change('all');

-- Backfill: every existing payment becomes one allocation of its invoice.
insert into public.payment_allocations (owner_id, payment_id, invoice_id, ticket_id, customer_id, planned_cents,
                                        applied_cents, balance_after_cents, waiting, created_at)
select p.owner_id, p.id, p.invoice_id, p.ticket_id, p.customer_id, p.amount_cents,
       case when p.status in ('ACCEPTED', 'PARTIAL')
            then greatest(coalesce(p.accepted_amount_cents, 0)
                          - coalesce((select sum(c.amount_cents) from public.credits c
                                      where c.source_payment_id = p.id and c.kind = 'OVERPAYMENT'), 0), 0)
            else 0 end,
       case when p.status in ('ACCEPTED', 'PARTIAL') then i.total_cents - i.amount_paid_cents end,
       p.status = 'SUBMITTED',
       p.submitted_at
from public.payments p
join public.invoices i on i.id = p.invoice_id;

update public.payments p
set credit_cents = coalesce((select sum(c.amount_cents) from public.credits c
                             where c.source_payment_id = p.id and c.kind = 'OVERPAYMENT'), 0)
where p.status in ('ACCEPTED', 'PARTIAL');

drop index public.payments_one_pending_per_ticket;
drop index public.payments_invoice_idx;
drop index public.payments_ticket_idx;
alter table public.payments
  drop constraint payments_invoice_fkey,
  drop constraint payments_ticket_fkey,
  drop column invoice_id,
  drop column ticket_id;

-- =============================================================================
-- C. Credits: refunds and VOID
-- =============================================================================
alter table public.credits
  add column refunded_cents bigint not null default 0,
  add constraint credits_refunded check (refunded_cents >= 0 and refunded_cents <= amount_cents);
update public.credits set refunded_cents = amount_cents where status = 'REFUNDED';

-- -----------------------------------------------------------------------------
-- credit_refunds (PAY-12). SERVER-WRITE-ONLY, append-only.
-- -----------------------------------------------------------------------------
create table public.credit_refunds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  customer_id uuid not null,
  credit_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  refunded_on date not null,
  method public.payment_method not null check (method not in ('SECURITY_DEPOSIT', 'ONLINE')),
  reference text check (length(reference) <= 100),
  note text check (length(note) <= 1000),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint credit_refunds_credit_fkey foreign key (credit_id, owner_id) references public.credits (id, owner_id),
  constraint credit_refunds_customer_fkey foreign key (customer_id, owner_id) references public.customers (id, owner_id)
);
comment on table public.credit_refunds is 'SERVER-WRITE-ONLY, append-only. Credits paid back to the customer (PAY-12).';
create index credit_refunds_owner_idx on public.credit_refunds (owner_id);
create index credit_refunds_credit_idx on public.credit_refunds (credit_id, owner_id);
create index credit_refunds_customer_idx on public.credit_refunds (customer_id, owner_id);
create index credit_refunds_created_by_idx on public.credit_refunds (created_by);
create trigger credit_refunds_audit after insert or update or delete on public.credit_refunds
  for each row execute function app.audit_row_change('all');

-- Available = amount - refunded - used by live invoices (drafts reserve). Same as
-- loadAvailableCredits (src/lib/billing/context.ts).
create or replace function app.available_credits(p_customer_id uuid, p_exclude_invoice uuid default null) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'available_cents', x.available) order by x.created_at, x.id), '[]'::jsonb)
  from (
    select c.id, c.created_at, c.amount_cents - c.refunded_cents - app.credit_used(c.id, p_exclude_invoice) as available
    from public.credits c
    where c.customer_id = p_customer_id and c.status = 'AVAILABLE'
  ) x
  where x.available > 0;
$$;

-- APPLIED once issued invoices and refunds use all of it, REFUNDED when all of it
-- was paid back, AVAILABLE otherwise. VOID stays VOID.
create or replace function app.refresh_credit_status(p_credit_ids uuid[]) returns void
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
  for c in select * from public.credits where id = any (p_credit_ids) and status <> 'VOID' order by id for update loop
    select coalesce(sum(-l.amount_cents), 0) into v_used
    from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
    where l.credit_id = c.id and i.status not in ('DRAFT', 'REJECTED', 'CANCELLED');
    v_status := case
      when c.refunded_cents >= c.amount_cents then 'REFUNDED'
      when v_used + c.refunded_cents >= c.amount_cents then 'APPLIED'
      else 'AVAILABLE'
    end;
    if v_status = 'APPLIED' then
      select l.invoice_id into v_last
      from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
      where l.credit_id = c.id and i.status not in ('DRAFT', 'REJECTED', 'CANCELLED')
      order by i.issued_at desc nulls last, i.created_at desc
      limit 1;
    else
      v_last := null;
    end if;
    if v_status = 'APPLIED' and v_last is null then
      v_status := 'REFUNDED';
    end if;
    if v_status <> c.status or v_last is distinct from c.applied_to_invoice_id
       or (v_status = 'REFUNDED' and c.refunded_at is null) then
      update public.credits
      set status = v_status,
          applied_to_invoice_id = v_last,
          applied_at = case when v_status = 'APPLIED' then coalesce(applied_at, now()) end,
          refunded_at = case when v_status = 'REFUNDED' then coalesce(refunded_at, now()) else refunded_at end
      where id = c.id;
    end if;
  end loop;
end;
$$;

-- =============================================================================
-- D. Receipts
-- =============================================================================

-- receipt_counters: one row per owner; numbers taken inside the accepting
-- transaction (row lock, rolled back with it), so they are unique and gap-free.
create table public.receipt_counters (
  owner_id uuid primary key references public.owners (id),
  prefix text not null default 'RCT-' check (prefix ~ '^[A-Za-z0-9/_-]{0,12}$'),
  last_value bigint not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now()
);
comment on table public.receipt_counters is 'SERVER-WRITE-ONLY. Per-owner, gap-free receipt numbers (decision 44).';

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  customer_id uuid not null,
  payment_id uuid not null,
  receipt_seq bigint not null check (receipt_seq > 0),
  receipt_no text not null,
  status text not null default 'ISSUED' check (status in ('ISSUED', 'REVERSED')),
  issued_at timestamptz not null default now(),
  reversed_at timestamptz,
  reverse_reason text,
  -- What the receipt prints (app.receipt_content), fixed when issued; replaced on reallocation.
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  branding_snapshot jsonb,
  pdf_status text not null default 'PENDING' check (pdf_status in ('PENDING', 'READY')),
  pdf_revision integer not null default 1 check (pdf_revision >= 1),
  pdf_pending_reason text check (pdf_pending_reason in ('ISSUED', 'REVERSED', 'REALLOCATED')),
  pdf_requested_at timestamptz,
  pdf_claimed_at timestamptz,
  pdf_attempts integer not null default 0 check (pdf_attempts >= 0),
  pdf_last_error text,
  pdf_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint receipts_payment_key unique (payment_id),
  constraint receipts_owner_no_key unique (owner_id, receipt_no),
  constraint receipts_owner_seq_key unique (owner_id, receipt_seq),
  constraint receipts_id_owner_key unique (id, owner_id),
  constraint receipts_reversed check (status <> 'REVERSED' or (reversed_at is not null and coalesce(length(btrim(reverse_reason)), 0) > 0)),
  constraint receipts_payment_fkey foreign key (payment_id, owner_id) references public.payments (id, owner_id),
  constraint receipts_customer_fkey foreign key (customer_id, owner_id) references public.customers (id, owner_id)
);
comment on table public.receipts is 'SERVER-WRITE-ONLY. One receipt per accepted payment (decision 44).';
create index receipts_customer_idx on public.receipts (customer_id, owner_id);
create index receipts_pdf_pending_idx on public.receipts (pdf_attempts, pdf_requested_at) where pdf_status = 'PENDING';

create trigger receipts_set_updated_at before update on public.receipts
  for each row execute function app.set_updated_at();
create trigger receipts_audit after insert or update or delete on public.receipts
  for each row execute function app.audit_row_change('status');

-- The PDF is made again when the receipt is reversed or its invoices change.
create function app.receipt_pdf_flag() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reason text;
begin
  if tg_op = 'INSERT' then
    new.pdf_status := 'PENDING';
    new.pdf_revision := 1;
    new.pdf_pending_reason := 'ISSUED';
    new.pdf_requested_at := now();
    return new;
  end if;
  if new.status = 'REVERSED' and old.status <> 'REVERSED' then
    v_reason := 'REVERSED';
  elsif new.content is distinct from old.content then
    v_reason := 'REALLOCATED';
  else
    return new;
  end if;
  new.pdf_status := 'PENDING';
  new.pdf_revision := old.pdf_revision + 1;
  new.pdf_pending_reason := v_reason;
  new.pdf_requested_at := now();
  new.pdf_last_error := null;
  return new;
end;
$$;
create trigger receipts_pdf_flag before insert or update on public.receipts
  for each row execute function app.receipt_pdf_flag();

create table public.receipt_pdf_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  receipt_id uuid not null,
  customer_id uuid not null,
  version integer not null check (version >= 1),
  storage_path text not null,
  reason text not null check (reason in ('ISSUED', 'REVERSED', 'REALLOCATED')),
  template text not null check (template in ('BUILT_IN', 'LETTERHEAD')),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check (byte_size > 0),
  created_at timestamptz not null default now(),
  constraint receipt_pdf_versions_version_key unique (receipt_id, version),
  constraint receipt_pdf_versions_path check (storage_path = owner_id::text || '/' || receipt_id::text || '/v' || version::text || '.pdf'),
  constraint receipt_pdf_versions_receipt_fkey foreign key (receipt_id, owner_id) references public.receipts (id, owner_id),
  constraint receipt_pdf_versions_customer_fkey foreign key (customer_id, owner_id) references public.customers (id, owner_id)
);
comment on table public.receipt_pdf_versions is 'SERVER-WRITE-ONLY, append-only. Every PDF made for a receipt.';
create index receipt_pdf_versions_owner_idx on public.receipt_pdf_versions (owner_id);
create index receipt_pdf_versions_customer_idx on public.receipt_pdf_versions (customer_id, owner_id);

-- What a receipt prints: the payment, the invoices it paid with the balance right
-- after, the credit kept, the customer's outstanding total and details.
create function app.receipt_content(p_payment_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'payment', jsonb_build_object(
      'amount_cents', p.amount_cents, 'accepted_cents', p.accepted_amount_cents, 'method', p.method,
      'paid_on', p.paid_on, 'reference', p.reference, 'source', p.source, 'verified_at', p.verified_at),
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'invoice_id', a.invoice_id, 'invoice_no', i.invoice_no, 'invoice_total_cents', i.total_cents,
        'applied_cents', a.applied_cents, 'balance_after_cents', a.balance_after_cents,
        'machine', m.brand || ' ' || m.model, 'period_start', i.period_start, 'period_end', i.period_end)
        order by i.due_date nulls last, i.invoice_seq nulls last, i.id)
      from public.payment_allocations a
      join public.invoices i on i.id = a.invoice_id
      join public.machines m on m.id = i.machine_id
      where a.payment_id = p.id and a.released_at is null and a.applied_cents > 0), '[]'::jsonb),
    'credit_cents', p.credit_cents,
    'outstanding_after_cents', (
      select coalesce(sum(i.total_cents - i.amount_paid_cents), 0)
      from public.invoices i
      where i.customer_id = p.customer_id
        and i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')),
    'customer', (
      select jsonb_build_object('name', c.name, 'business_name', c.business_name, 'address', c.address)
      from public.customers c where c.id = p.customer_id))
  from public.payments p
  where p.id = p_payment_id;
$$;

-- Issues the receipt of an accepted payment (once; the number comes from the
-- owner's counter inside the caller's transaction).
create function app.issue_receipt(p_payment_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  v_id uuid;
  v_seq bigint;
  v_prefix text;
begin
  select * into pay from public.payments where id = p_payment_id;
  if not found or pay.status not in ('ACCEPTED', 'PARTIAL') then
    perform app.fail('RD409', 'Only an accepted payment gets a receipt');
  end if;
  select r.id into v_id from public.receipts r where r.payment_id = pay.id;
  if found then
    return v_id;
  end if;
  insert into public.receipt_counters (owner_id) values (pay.owner_id) on conflict (owner_id) do nothing;
  update public.receipt_counters
  set last_value = last_value + 1, updated_at = now()
  where owner_id = pay.owner_id
  returning last_value, prefix into v_seq, v_prefix;

  insert into public.receipts (owner_id, customer_id, payment_id, receipt_seq, receipt_no, content, branding_snapshot)
  values (pay.owner_id, pay.customer_id, pay.id, v_seq, v_prefix || lpad(v_seq::text, 6, '0'),
          app.receipt_content(pay.id), app.branding_snapshot(pay.owner_id))
  returning id into v_id;
  return v_id;
end;
$$;

-- Rendering: claim → (render, upload) → record, or → failed (as invoices, 0022).
create function app.claim_receipt_pdf(p_receipt_id uuid, p_now timestamptz) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.receipts;
  v_latest public.receipt_pdf_versions;
begin
  select * into r from public.receipts where id = p_receipt_id for update;
  if not found or r.pdf_status <> 'PENDING' then
    return null;
  end if;
  if r.pdf_claimed_at is not null and r.pdf_claimed_at > p_now - interval '5 minutes' then
    return null;
  end if;
  update public.receipts set pdf_claimed_at = p_now where id = r.id;
  select * into v_latest from public.receipt_pdf_versions where receipt_id = r.id order by version desc limit 1;
  return jsonb_build_object(
    'receipt', jsonb_build_object(
      'id', r.id, 'owner_id', r.owner_id, 'customer_id', r.customer_id, 'receipt_no', r.receipt_no,
      'status', r.status, 'issued_at', r.issued_at, 'reversed_at', r.reversed_at, 'reverse_reason', r.reverse_reason,
      'content', r.content, 'branding_snapshot', r.branding_snapshot, 'pdf_revision', r.pdf_revision),
    'latest', case when v_latest.id is null then null
                   else jsonb_build_object('version', v_latest.version, 'content_hash', v_latest.content_hash) end
  );
end;
$$;

create function app.record_receipt_pdf(
  p_receipt_id uuid,
  p_revision integer,
  p_version integer,
  p_path text,
  p_hash text,
  p_size integer,
  p_template text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.receipts;
  v_max integer;
  v_reason text;
  v_ready boolean;
begin
  select * into r from public.receipts where id = p_receipt_id for update;
  if not found then
    perform app.fail('RD404', 'Receipt not found');
  end if;
  select max(version) into v_max from public.receipt_pdf_versions where receipt_id = r.id;
  if p_version is not null then
    if p_version <> coalesce(v_max, 0) + 1 then
      perform app.fail('RD409', 'PDF_VERSION_CONFLICT');
    end if;
    v_reason := case when v_max is null then 'ISSUED' else coalesce(r.pdf_pending_reason, 'REALLOCATED') end;
    insert into public.receipt_pdf_versions (owner_id, receipt_id, customer_id, version, storage_path, reason, template,
                                             content_hash, byte_size)
    values (r.owner_id, r.id, r.customer_id, p_version, p_path, v_reason, p_template, p_hash, p_size);
    perform app.write_audit(null, 'RECEIPT_PDF_CREATED', 'receipts', r.id, r.owner_id,
      jsonb_build_object('receipt_no', r.receipt_no, 'version', p_version, 'reason', v_reason, 'template', p_template));
  elsif v_max is null then
    perform app.fail('RD400', 'There is no earlier PDF to keep');
  end if;
  v_ready := r.pdf_revision = p_revision;
  update public.receipts
  set pdf_path = case when p_version is not null then p_path else pdf_path end,
      pdf_claimed_at = null,
      pdf_status = case when v_ready then 'READY' else pdf_status end,
      pdf_pending_reason = case when v_ready then null else pdf_pending_reason end,
      pdf_attempts = case when v_ready then 0 else pdf_attempts end,
      pdf_last_error = case when v_ready then null else pdf_last_error end
  where id = r.id;
  return jsonb_build_object('version', coalesce(p_version, v_max), 'ready', v_ready);
end;
$$;

create function app.mark_receipt_pdf_failed(p_receipt_id uuid, p_error text) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  update public.receipts
  set pdf_attempts = pdf_attempts + 1, pdf_last_error = left(coalesce(p_error, 'Unknown error'), 500), pdf_claimed_at = null
  where id = p_receipt_id and pdf_status = 'PENDING'
  returning pdf_attempts into v_attempts;
  return coalesce(v_attempts, 0);
end;
$$;

create function app.cron_pending_receipt_pdfs(p_now timestamptz, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(q.id), '[]'::jsonb)
  from (
    select r.id from public.receipts r
    where r.pdf_status = 'PENDING'
      and (r.pdf_claimed_at is null or r.pdf_claimed_at <= p_now - interval '5 minutes')
    order by r.pdf_attempts, r.pdf_requested_at nulls first, r.id
    limit greatest(p_limit, 0)
  ) q;
$$;

-- =============================================================================
-- E. Ticket and invoice follow the money
-- =============================================================================

-- One allowed status change of a (locked) ticket, with its event.
create function app.ticket_hop(
  p_ticket_id uuid,
  p_to public.ticket_status,
  p_actor_id uuid,
  p_reason text,
  p_metadata jsonb,
  p_stage_due_at timestamptz
) returns public.billing_cycle_tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.billing_cycle_tickets;
begin
  select * into t from public.billing_cycle_tickets where id = p_ticket_id;
  if not app.ticket_transition_allowed(t.status, p_to) then
    perform app.fail('RD409', format('The ticket is %s and cannot move to %s', t.status, p_to));
  end if;
  perform app.insert_ticket_event(t, 'STATUS_CHANGE', p_to, p_actor_id, p_reason, p_metadata);
  perform app.enter_stage(t.id, p_to, p_stage_due_at);
  if p_to = 'CLOSED' then
    update public.billing_cycle_tickets set closed_at = now(), closed_by = p_actor_id where id = t.id;
  elsif p_to = 'REOPENED' then
    update public.billing_cycle_tickets set closed_at = null, closed_by = null where id = t.id;
  end if;
  select * into t from public.billing_cycle_tickets where id = p_ticket_id;
  return t;
end;
$$;

-- Locks the tickets, then the invoices, of a set of invoices, each in id order
-- (the daily job locks a ticket before its invoice too), so payments never deadlock.
create function app.lock_invoices_and_tickets(p_invoice_ids uuid[]) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.billing_cycle_tickets t
  where t.id in (select i.ticket_id from public.invoices i where i.id = any (p_invoice_ids))
  order by t.id
  for update;
  perform 1 from public.invoices i where i.id = any (p_invoice_ids) order by i.id for update;
end;
$$;

-- Sets what has been paid on an invoice and moves its ticket through the allowed
-- transitions (spec 5.3; decision 42):
--   more paid:  (Reopened ->) (Awaiting ->) Payment submitted -> Closed / Partially paid
--   less paid:  Closed -> Reopened -> Awaiting payment; Partially paid -> Awaiting
--               payment when nothing is left paid; otherwise the status stays (event)
--   unchanged:  Payment submitted -> Awaiting payment / Partially paid (slip rejected)
-- The invoice status follows: Paid, Overdue (while the ticket is), Partially paid or
-- Awaiting payment. Caller locks with app.lock_invoices_and_tickets first.
create function app.settle_invoice_payment(
  p_invoice_id uuid,
  p_new_paid bigint,
  p_actor_id uuid,
  p_reason text,
  p_metadata jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  t public.billing_cycle_tickets;
  v_old bigint;
  v_full boolean;
  v_due timestamptz;
  v_meta jsonb;
  v_status public.invoice_status;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if not found then
    perform app.fail('RD404', 'Invoice not found');
  end if;
  select * into t from public.billing_cycle_tickets where id = inv.ticket_id for update;
  if t.current_invoice_id is distinct from inv.id then
    perform app.fail('RD409', format('Invoice %s was replaced by a newer invoice', coalesce(inv.invoice_no, '')));
  end if;
  if p_new_paid < 0 or p_new_paid > inv.total_cents then
    perform app.fail('RD400', format('Invoice %s cannot have %s paid', inv.invoice_no, app.format_rupees(p_new_paid)));
  end if;

  v_old := inv.amount_paid_cents;
  v_full := p_new_paid >= inv.total_cents;
  v_due := app.payment_stage_due(inv.due_date);
  v_meta := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
    'invoice_id', inv.id, 'invoice_no', inv.invoice_no, 'paid_before_cents', v_old, 'paid_cents', p_new_paid,
    'balance_cents', inv.total_cents - p_new_paid);

  if p_new_paid > v_old then
    if t.status in ('CLOSED', 'CANCELLED', 'DISPUTED') then
      perform app.fail('RD409', format('Invoice %s cannot take a payment now (the ticket is %s)', inv.invoice_no, t.status));
    end if;
    if t.status = 'REOPENED' then
      t := app.ticket_hop(t.id, 'AWAITING_PAYMENT', p_actor_id, p_reason, v_meta, v_due);
    end if;
    if t.status <> 'PAYMENT_SUBMITTED' then
      t := app.ticket_hop(t.id, 'PAYMENT_SUBMITTED', p_actor_id, p_reason, v_meta, null);
    end if;
    t := app.ticket_hop(t.id, (case when v_full then 'CLOSED' else 'PARTIALLY_PAID' end)::public.ticket_status,
                        p_actor_id, p_reason, v_meta, case when v_full then null else v_due end);
  elsif p_new_paid < v_old then
    if t.status = 'CLOSED' then
      t := app.ticket_hop(t.id, 'REOPENED', p_actor_id, p_reason, v_meta, null);
      t := app.ticket_hop(t.id, 'AWAITING_PAYMENT', p_actor_id, p_reason, v_meta, v_due);
    elsif t.status = 'PARTIALLY_PAID' and p_new_paid = 0 then
      t := app.ticket_hop(t.id, 'AWAITING_PAYMENT', p_actor_id, p_reason, v_meta, v_due);
    elsif t.status in ('PARTIALLY_PAID', 'AWAITING_PAYMENT', 'REOPENED', 'OVERDUE') then
      if t.status = 'OVERDUE' and p_new_paid = 0 and t.status_before_overdue = 'PARTIALLY_PAID' then
        update public.billing_cycle_tickets set status_before_overdue = 'AWAITING_PAYMENT' where id = t.id;
      end if;
      perform app.insert_ticket_event(t, 'PAYMENT', t.status, p_actor_id, p_reason, v_meta);
    else
      perform app.fail('RD409', format('Invoice %s: the ticket is %s; deal with that first', inv.invoice_no, t.status));
    end if;
  elsif t.status = 'PAYMENT_SUBMITTED' then
    t := app.ticket_hop(t.id, (case when v_old > 0 then 'PARTIALLY_PAID' else 'AWAITING_PAYMENT' end)::public.ticket_status,
                        p_actor_id, p_reason, v_meta, v_due);
  end if;

  v_status := case
    when v_full then 'PAID'
    when t.status = 'OVERDUE' then 'OVERDUE'
    when p_new_paid > 0 then 'PARTIALLY_PAID'
    else 'AWAITING_PAYMENT'
  end;
  update public.invoices set amount_paid_cents = p_new_paid, status = v_status where id = inv.id;
  return jsonb_build_object('invoice_id', inv.id, 'invoice_no', inv.invoice_no, 'ticket_id', t.id,
                            'ticket_status', t.status, 'invoice_status', v_status,
                            'balance_cents', inv.total_cents - p_new_paid);
end;
$$;

-- Invoices a customer can pay now (also what an owner may record a payment for):
-- issued, something left, the ticket's current invoice, in a payment stage, no
-- slip waiting, not disputed. Fails with the first problem in plain words.
create function app.assert_payable(p_invoice_ids uuid[], p_customer_id uuid) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  inv public.invoices;
  t public.billing_cycle_tickets;
begin
  if p_invoice_ids is null or cardinality(p_invoice_ids) = 0 then
    perform app.fail('RD400', 'Choose at least one bill');
  end if;
  if cardinality(p_invoice_ids) <> (select count(distinct x) from unnest(p_invoice_ids) x) then
    perform app.fail('RD400', 'A bill is listed twice');
  end if;
  foreach v_id in array p_invoice_ids loop
    select * into inv from public.invoices where id = v_id;
    if not found or inv.customer_id is distinct from p_customer_id or inv.invoice_no is null then
      perform app.fail('RD404', 'Bill not found');
    end if;
    if inv.status = 'PAYMENT_SUBMITTED' then
      perform app.fail('RD409', format('A payment slip for %s is already waiting for a check', inv.invoice_no));
    end if;
    if inv.status = 'DISPUTED' then
      perform app.fail('RD409', format('%s is disputed; it can be paid once the dispute is answered', inv.invoice_no));
    end if;
    if inv.status not in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'OVERDUE') or inv.amount_paid_cents >= inv.total_cents then
      perform app.fail('RD409', format('%s has nothing left to pay', inv.invoice_no));
    end if;
    select * into t from public.billing_cycle_tickets where id = inv.ticket_id;
    if t.current_invoice_id is distinct from inv.id
       or not (t.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID')
               or (t.status = 'OVERDUE' and t.status_before_overdue in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED'))) then
      perform app.fail('RD409', format('%s cannot be paid right now', inv.invoice_no));
    end if;
  end loop;
end;
$$;

-- Decision 39: oldest due date first (then invoice number), each up to what is left
-- to pay; the rest is credit. p_exclude_payment: balances as if that payment's own
-- allocations were not there (reallocation). Mirrors planAllocation
-- (src/lib/payments/allocation.ts). Returns {allocations: [{invoice_id, cents,
-- balance_cents}], credit_cents}.
create function app.plan_allocation(p_amount_cents bigint, p_invoice_ids uuid[], p_exclude_payment uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  v_rest bigint := p_amount_cents;
  v_take bigint;
  v_out jsonb := '[]'::jsonb;
begin
  for r in
    select i.id,
           i.total_cents - i.amount_paid_cents + coalesce((
             select sum(a.applied_cents) from public.payment_allocations a
             where a.payment_id = p_exclude_payment and a.invoice_id = i.id and a.released_at is null), 0) as balance
    from public.invoices i
    where i.id = any (coalesce(p_invoice_ids, '{}'))
    order by i.due_date nulls last, i.invoice_seq nulls last, i.id
  loop
    v_take := least(v_rest, greatest(r.balance, 0));
    v_out := v_out || jsonb_build_object('invoice_id', r.id, 'cents', v_take, 'balance_cents', r.balance);
    v_rest := v_rest - v_take;
  end loop;
  return jsonb_build_object('allocations', v_out, 'credit_cents', v_rest);
end;
$$;

-- PAY-11 (decision 40): the newest earlier payment of the owner with the same slip
-- file (stored or original fingerprint) or the same bank reference and amount.
-- Null when none. A flag for the owner, never a block.
create function app.payment_duplicates(
  p_owner_id uuid,
  p_sha256 text,
  p_original_sha256 text,
  p_reference text,
  p_amount_cents bigint,
  p_exclude_payment uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hashes text[] := array_remove(array[p_sha256, p_original_sha256], null);
  v_reference text := nullif(btrim(p_reference), '');
  v_result jsonb;
begin
  select jsonb_build_object(
           'payment_id', x.id, 'customer_id', x.customer_id, 'submitted_at', x.submitted_at, 'paid_on', x.paid_on,
           'status', x.status,
           'reasons', array_remove(array[case when x.file_match then 'FILE' end, case when x.ref_match then 'REFERENCE' end], null))
  into v_result
  from (
    select p.id, p.customer_id, p.submitted_at, p.paid_on, p.status,
           exists (select 1 from public.payment_slips s
                   where s.payment_id = p.id and (s.sha256 = any (v_hashes) or s.original_sha256 = any (v_hashes))) as file_match,
           (v_reference is not null and lower(p.reference) = lower(v_reference) and p.amount_cents = p_amount_cents) as ref_match
    from public.payments p
    where p.owner_id = p_owner_id
      and p.id is distinct from p_exclude_payment
      and (p.id in (select s.payment_id from public.payment_slips s
                    where s.owner_id = p_owner_id and (s.sha256 = any (v_hashes) or s.original_sha256 = any (v_hashes)))
           or (v_reference is not null and lower(p.reference) = lower(v_reference) and p.amount_cents = p_amount_cents))
  ) x
  order by x.submitted_at desc, x.id
  limit 1;
  return v_result;
end;
$$;

-- Credits a payment created must be unused (and not refunded) before the payment
-- is reversed or moved; the message names where it went.
create function app.assert_payment_credits_unused(p_payment_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.credits;
  v_invoice public.invoices;
begin
  for c in select * from public.credits where source_payment_id = p_payment_id and status <> 'VOID' order by id for update loop
    if app.credit_used(c.id) > 0 then
      select i.* into v_invoice
      from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
      where l.credit_id = c.id and i.status not in ('REJECTED', 'CANCELLED')
      order by i.created_at
      limit 1;
      if v_invoice.invoice_no is null then
        perform app.fail('RD409', format(
          'CREDIT_USED: The %s credit from this payment is on a draft invoice waiting for your review. Remove it from that draft first.',
          app.format_rupees(c.amount_cents)));
      end if;
      perform app.fail('RD409', format(
        'CREDIT_USED: The %s credit from this payment was already used on invoice %s, so the payment cannot be changed.',
        app.format_rupees(c.amount_cents), v_invoice.invoice_no));
    end if;
    if c.refunded_cents > 0 then
      perform app.fail('RD409', format(
        'CREDIT_REFUNDED: %s of the credit from this payment was refunded, so the payment cannot be changed.',
        app.format_rupees(c.refunded_cents)));
    end if;
  end loop;
end;
$$;

-- An accepted amount goes onto its (locked) invoices: allocation rows, invoice and
-- ticket statuses, the credit for what is left, the payment's status, the receipt.
create function app.apply_payment(
  p_payment_id uuid,
  p_accepted_cents bigint,
  p_actor_id uuid,
  p_reason text,
  p_credit_kind public.credit_kind
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  v_ids uuid[];
  v_plan jsonb;
  v_item jsonb;
  inv public.invoices;
  v_cents bigint;
  v_settled jsonb;
  v_credit bigint;
  v_open boolean := false;
  v_results jsonb := '[]'::jsonb;
  v_receipt uuid;
begin
  select * into pay from public.payments where id = p_payment_id;
  v_ids := array(select a.invoice_id from public.payment_allocations a where a.payment_id = pay.id and a.released_at is null);
  v_plan := app.plan_allocation(p_accepted_cents, v_ids, null);

  for v_item in select * from jsonb_array_elements(v_plan -> 'allocations') loop
    select * into inv from public.invoices where id = (v_item ->> 'invoice_id')::uuid;
    v_cents := (v_item ->> 'cents')::bigint;
    v_settled := app.settle_invoice_payment(inv.id, inv.amount_paid_cents + v_cents, p_actor_id, p_reason,
      jsonb_build_object('payment_id', pay.id, 'applied_cents', v_cents, 'method', pay.method, 'source', pay.source));
    update public.payment_allocations
    set applied_cents = v_cents,
        balance_after_cents = (v_settled ->> 'balance_cents')::bigint,
        waiting = false
    where payment_id = pay.id and invoice_id = inv.id and released_at is null;
    v_open := v_open or (v_settled ->> 'balance_cents')::bigint > 0;
    v_results := v_results || (v_settled || jsonb_build_object('applied_cents', v_cents));
  end loop;

  v_credit := (v_plan ->> 'credit_cents')::bigint;
  if v_credit > 0 then
    insert into public.credits (owner_id, customer_id, source_payment_id, kind, amount_cents, reason, created_by,
                                received_on, method, reference)
    values (pay.owner_id, pay.customer_id, pay.id, p_credit_kind, v_credit,
            case p_credit_kind
              when 'ADVANCE' then format('Advance payment of %s on %s', app.format_rupees(v_credit), to_char(pay.paid_on, 'DD Mon YYYY'))
              else format('Overpayment: %s more than the bills on the payment of %s', app.format_rupees(v_credit),
                          to_char(pay.paid_on, 'DD Mon YYYY'))
            end,
            p_actor_id, pay.paid_on, case when pay.method = 'SECURITY_DEPOSIT' then null else pay.method end,
            pay.reference);
  end if;

  update public.payments
  set status = (case when v_open then 'PARTIAL' else 'ACCEPTED' end)::public.payment_status,
      accepted_amount_cents = p_accepted_cents,
      credit_cents = v_credit,
      reject_reason = null,
      verified_by = p_actor_id,
      verified_at = now()
  where id = pay.id;

  v_receipt := app.issue_receipt(pay.id);
  return jsonb_build_object('payment_id', pay.id, 'status', case when v_open then 'PARTIAL' else 'ACCEPTED' end,
                            'accepted_cents', p_accepted_cents, 'credit_cents', v_credit, 'invoices', v_results,
                            'receipt_id', v_receipt,
                            'receipt_no', (select r.receipt_no from public.receipts r where r.id = v_receipt));
end;
$$;

-- =============================================================================
-- F. Payment workflow (called through public.rpc_*)
-- =============================================================================

drop function public.rpc_submit_payment(uuid, uuid, uuid, public.payment_source, jsonb, jsonb, timestamptz, jsonb);
drop function public.rpc_verify_payment(uuid, uuid, uuid, boolean, bigint, text, timestamptz, jsonb);
drop function app.submit_payment(uuid, uuid, uuid, public.payment_source, jsonb, jsonb, timestamptz, jsonb);
drop function app.verify_payment(uuid, uuid, uuid, boolean, bigint, text, timestamptz, jsonb);

-- Reads and checks the payment details of a form: {amount_cents, paid_on, method,
-- reference, note}. Returns the cleaned values.
create function app.payment_details(p_payment jsonb, p_allowed public.payment_method[]) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_amount bigint := app.json_count(p_payment, 'amount_cents', 'The amount');
  v_paid_on date := nullif(p_payment ->> 'paid_on', '')::date;
  v_method text := nullif(p_payment ->> 'method', '');
begin
  if v_amount is null or v_amount <= 0 then
    perform app.fail('RD400', 'The amount must be more than 0');
  end if;
  if v_paid_on is null or v_paid_on > app.colombo_date(now()) then
    perform app.fail('RD400', 'The date paid must be today or earlier');
  end if;
  if v_paid_on < app.colombo_date(now()) - 3650 then
    perform app.fail('RD400', 'The date paid is too long ago');
  end if;
  if v_method is null or not (v_method = any (p_allowed::text[])) then
    perform app.fail('RD400', 'Choose how it was paid');
  end if;
  if length(coalesce(p_payment ->> 'reference', '')) > 100 or length(coalesce(p_payment ->> 'note', '')) > 1000 then
    perform app.fail('RD400', 'The reference or note is too long');
  end if;
  return jsonb_build_object('amount_cents', v_amount, 'paid_on', v_paid_on, 'method', v_method,
                            'reference', nullif(btrim(p_payment ->> 'reference'), ''),
                            'note', nullif(btrim(p_payment ->> 'note'), ''));
end;
$$;

-- Steps 6-7 (PAY-02..04, PAY-11, CP-04): the customer's slip for one or more of
-- their bills. Each ticket -> PAYMENT_SUBMITTED, each invoice PAYMENT_SUBMITTED.
-- p_slip: {storage_path, sha256, original_sha256?, mime_type, size_bytes}.
-- Idempotent: the same key returns the first payment.
create function app.submit_payment(
  p_actor_id uuid,
  p_customer_id uuid,
  p_idempotency_key uuid,
  p_invoice_ids uuid[],
  p_payment jsonb,
  p_slip jsonb,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cu public.customers;
  v_existing public.payments;
  v_details jsonb;
  v_plan jsonb;
  v_item jsonb;
  v_dup jsonb;
  v_payment_id uuid;
  v_retention integer;
  inv public.invoices;
  t public.billing_cycle_tickets;
  v_count integer := 0;
begin
  perform app.set_actor(p_actor_id);
  if p_idempotency_key is null then
    perform app.fail('RD400', 'An idempotency key is required');
  end if;
  select * into v_existing from public.payments where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.customer_id is distinct from p_customer_id then
      perform app.fail('RD409', 'Idempotency key already used');
    end if;
    return jsonb_build_object('payment_id', v_existing.id, 'duplicate_of_payment_id', v_existing.duplicate_of_payment_id,
                              'duplicate_reasons', to_jsonb(v_existing.duplicate_reasons), 'replayed', true);
  end if;

  select * into cu from public.customers where id = p_customer_id;
  if not found then
    perform app.fail('RD404', 'Customer not found');
  end if;
  perform app.assert_actor(p_actor_id, cu.owner_id, cu.id, array['CUSTOMER']::public.user_role[]);
  v_details := app.payment_details(p_payment, array['BANK_TRANSFER', 'DEPOSIT', 'CHEQUE', 'OTHER']::public.payment_method[]);

  if p_slip is null or jsonb_typeof(p_slip) <> 'object' then
    perform app.fail('RD400', 'A payment slip is required');
  end if;
  if coalesce(p_slip ->> 'storage_path', '') !~ ('^' || cu.owner_id::text || '/' || cu.id::text || '/[0-9a-f-]{36}\.(jpg|png|pdf)$') then
    perform app.fail('RD400', 'The slip must be in the customer''s folder: {owner_id}/{customer_id}/{id}.{jpg|png|pdf}');
  end if;

  perform app.lock_invoices_and_tickets(p_invoice_ids);
  perform app.assert_payable(p_invoice_ids, cu.id);
  v_plan := app.plan_allocation((v_details ->> 'amount_cents')::bigint, p_invoice_ids, null);

  v_dup := app.payment_duplicates(cu.owner_id, p_slip ->> 'sha256', nullif(p_slip ->> 'original_sha256', ''),
                                  v_details ->> 'reference', (v_details ->> 'amount_cents')::bigint);

  insert into public.payments (owner_id, customer_id, source, method, amount_cents, paid_on, reference, note,
                               idempotency_key, submitted_by, duplicate_of_payment_id, duplicate_reasons)
  values (cu.owner_id, cu.id, 'CUSTOMER_SLIP', (v_details ->> 'method')::public.payment_method,
          (v_details ->> 'amount_cents')::bigint, (v_details ->> 'paid_on')::date, v_details ->> 'reference',
          v_details ->> 'note', p_idempotency_key, p_actor_id, (v_dup ->> 'payment_id')::uuid,
          coalesce(array(select jsonb_array_elements_text(v_dup -> 'reasons')), '{}'))
  returning id into v_payment_id;

  select payment_slip_retention_days into v_retention from public.owner_settings_effective where owner_id = cu.owner_id;
  insert into public.payment_slips (owner_id, payment_id, storage_path, sha256, original_sha256, mime_type, size_bytes,
                                    uploaded_by, retention_until)
  values (cu.owner_id, v_payment_id, p_slip ->> 'storage_path', p_slip ->> 'sha256', nullif(p_slip ->> 'original_sha256', ''),
          p_slip ->> 'mime_type', (p_slip ->> 'size_bytes')::integer, p_actor_id,
          app.colombo_date(now()) + coalesce(v_retention, 2555));

  for v_item in select * from jsonb_array_elements(v_plan -> 'allocations') loop
    -- Bills the amount does not reach are left out of this slip.
    continue when (v_item ->> 'cents')::bigint = 0;
    select * into inv from public.invoices where id = (v_item ->> 'invoice_id')::uuid;
    select * into t from public.billing_cycle_tickets where id = inv.ticket_id;
    insert into public.payment_allocations (owner_id, payment_id, invoice_id, ticket_id, customer_id, planned_cents, waiting)
    values (cu.owner_id, v_payment_id, inv.id, t.id, cu.id, (v_item ->> 'cents')::bigint, true);
    -- Spec 8.2: while a slip waits for verification the invoice is not overdue.
    update public.invoices set status = 'PAYMENT_SUBMITTED' where id = inv.id;
    perform app.insert_ticket_event(t, 'STATUS_CHANGE', 'PAYMENT_SUBMITTED', p_actor_id, null,
      jsonb_build_object('payment_id', v_payment_id, 'invoice_id', inv.id, 'invoice_no', inv.invoice_no,
                         'amount_cents', (v_details ->> 'amount_cents')::bigint, 'planned_cents', (v_item ->> 'cents')::bigint,
                         'duplicate_of_payment_id', v_dup ->> 'payment_id'));
    perform app.enter_stage(t.id, 'PAYMENT_SUBMITTED', p_stage_due_at);
    v_count := v_count + 1;
  end loop;

  perform app.write_audit(p_actor_id, 'PAYMENT_SUBMITTED', 'payments', v_payment_id, cu.owner_id,
    jsonb_build_object('amount_cents', (v_details ->> 'amount_cents')::bigint, 'method', v_details ->> 'method',
                       'reference', v_details ->> 'reference', 'allocations', v_plan -> 'allocations',
                       'duplicate_of_payment_id', v_dup ->> 'payment_id', 'duplicate_reasons', v_dup -> 'reasons'));
  perform app.enqueue_notifications(cu.owner_id, p_notifications, 'payment', v_payment_id);
  return jsonb_build_object('payment_id', v_payment_id, 'duplicate_of_payment_id', v_dup ->> 'payment_id',
                            'duplicate_reasons', coalesce(v_dup -> 'reasons', '[]'::jsonb), 'invoices', v_count,
                            'credit_cents', (v_plan ->> 'credit_cents')::bigint, 'replayed', false);
end;
$$;

-- Steps 8-9 (PAY-05, PAY-06, PAY-12): the owner checks a slip.
--   accept (full or another amount): split oldest due first over the slip's bills;
--     paid bills close their tickets, the rest stay partly paid; any excess becomes
--     an OVERPAYMENT credit; the receipt is issued.
--   reject (reason): every bill goes back to Awaiting payment / Partially paid.
create function app.verify_payment(
  p_payment_id uuid,
  p_actor_id uuid,
  p_accept boolean,
  p_accepted_amount_cents bigint default null,
  p_reason text default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  v_ids uuid[];
  v_accepted bigint;
  v_result jsonb;
  v_id uuid;
  inv public.invoices;
begin
  perform app.set_actor(p_actor_id);
  select * into pay from public.payments where id = p_payment_id for update;
  if not found then
    perform app.fail('RD404', 'Payment not found');
  end if;
  perform app.assert_actor(p_actor_id, pay.owner_id, pay.customer_id, array['OWNER']::public.user_role[]);
  if pay.status <> 'SUBMITTED' then
    perform app.fail('RD409', 'This payment has already been checked');
  end if;
  if p_accept is null then
    perform app.fail('RD400', 'Accept or reject must be chosen');
  end if;
  v_ids := array(select a.invoice_id from public.payment_allocations a where a.payment_id = pay.id and a.released_at is null);
  perform app.lock_invoices_and_tickets(v_ids);

  if not p_accept then
    if coalesce(btrim(p_reason), '') = '' then
      perform app.fail('RD400', 'A reason is required to reject a payment');
    end if;
    foreach v_id in array v_ids loop
      select * into inv from public.invoices where id = v_id;
      perform app.settle_invoice_payment(inv.id, inv.amount_paid_cents, p_actor_id, btrim(p_reason),
        jsonb_build_object('payment_id', pay.id, 'rejected', true));
    end loop;
    update public.payment_allocations set waiting = false, applied_cents = 0 where payment_id = pay.id and released_at is null;
    update public.payments
    set status = 'REJECTED', reject_reason = btrim(p_reason), verified_by = p_actor_id, verified_at = now()
    where id = pay.id;
    v_result := jsonb_build_object('payment_id', pay.id, 'status', 'REJECTED');
  else
    v_accepted := coalesce(p_accepted_amount_cents, pay.amount_cents);
    if v_accepted <= 0 or v_accepted > pay.amount_cents then
      perform app.fail('RD400', 'The amount received must be more than 0 and not more than the slip amount');
    end if;
    v_result := app.apply_payment(pay.id, v_accepted, p_actor_id,
      case when v_accepted < pay.amount_cents then format('Accepted %s of the %s slip', app.format_rupees(v_accepted),
                                                           app.format_rupees(pay.amount_cents)) end,
      'OVERPAYMENT');
  end if;

  perform app.write_audit(p_actor_id, case when p_accept then 'PAYMENT_ACCEPTED' else 'PAYMENT_REJECTED' end, 'payments',
    pay.id, pay.owner_id, v_result || jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
  perform app.enqueue_notifications(pay.owner_id, p_notifications, 'payment', pay.id);
  return v_result;
end;
$$;

-- PAY-07 / 11.5: the owner records money received without a slip (cash, cheque,
-- a transfer seen in the bank). Same split; accepted at once (two events per
-- ticket: Payment submitted, then Closed / Partially paid). No bills = an advance,
-- kept as an ADVANCE credit (11.5 "pay before the invoice").
create function app.record_manual_payment(
  p_actor_id uuid,
  p_customer_id uuid,
  p_idempotency_key uuid,
  p_invoice_ids uuid[],
  p_payment jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cu public.customers;
  v_existing public.payments;
  v_details jsonb;
  v_plan jsonb;
  v_item jsonb;
  v_payment_id uuid;
  inv public.invoices;
  v_result jsonb;
begin
  perform app.set_actor(p_actor_id);
  if p_idempotency_key is null then
    perform app.fail('RD400', 'An idempotency key is required');
  end if;
  select * into v_existing from public.payments where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.customer_id is distinct from p_customer_id then
      perform app.fail('RD409', 'Idempotency key already used');
    end if;
    return jsonb_build_object('payment_id', v_existing.id, 'status', v_existing.status, 'replayed', true,
                              'receipt_no', (select r.receipt_no from public.receipts r where r.payment_id = v_existing.id));
  end if;

  select * into cu from public.customers where id = p_customer_id;
  if not found then
    perform app.fail('RD404', 'Customer not found');
  end if;
  perform app.assert_actor(p_actor_id, cu.owner_id, cu.id, array['OWNER']::public.user_role[]);
  v_details := app.payment_details(p_payment, array['CASH', 'CHEQUE', 'BANK_TRANSFER', 'DEPOSIT', 'OTHER']::public.payment_method[]);

  if coalesce(cardinality(p_invoice_ids), 0) > 0 then
    perform app.lock_invoices_and_tickets(p_invoice_ids);
    perform app.assert_payable(p_invoice_ids, cu.id);
  end if;
  v_plan := app.plan_allocation((v_details ->> 'amount_cents')::bigint, p_invoice_ids, null);

  insert into public.payments (owner_id, customer_id, source, method, amount_cents, paid_on, reference, note,
                               idempotency_key, submitted_by)
  values (cu.owner_id, cu.id, 'OWNER_MANUAL', (v_details ->> 'method')::public.payment_method,
          (v_details ->> 'amount_cents')::bigint, (v_details ->> 'paid_on')::date, v_details ->> 'reference',
          v_details ->> 'note', p_idempotency_key, p_actor_id)
  returning id into v_payment_id;

  for v_item in select * from jsonb_array_elements(v_plan -> 'allocations') loop
    continue when (v_item ->> 'cents')::bigint = 0;
    select * into inv from public.invoices where id = (v_item ->> 'invoice_id')::uuid;
    insert into public.payment_allocations (owner_id, payment_id, invoice_id, ticket_id, customer_id, planned_cents)
    values (cu.owner_id, v_payment_id, inv.id, inv.ticket_id, cu.id, (v_item ->> 'cents')::bigint);
  end loop;

  v_result := app.apply_payment(v_payment_id, (v_details ->> 'amount_cents')::bigint, p_actor_id,
    format('Payment recorded by the owner (%s)', lower(replace(v_details ->> 'method', '_', ' '))),
    (case when coalesce(cardinality(p_invoice_ids), 0) = 0 then 'ADVANCE' else 'OVERPAYMENT' end)::public.credit_kind);
  perform app.write_audit(p_actor_id, 'PAYMENT_RECORDED', 'payments', v_payment_id, cu.owner_id,
    v_result || jsonb_build_object('method', v_details ->> 'method', 'reference', v_details ->> 'reference',
                                   'paid_on', v_details ->> 'paid_on', 'note', v_details ->> 'note'));
  perform app.enqueue_notifications(cu.owner_id, p_notifications, 'payment', v_payment_id);
  return v_result || jsonb_build_object('replayed', false);
end;
$$;

-- TKT-10 / 11.5: an accepted payment is taken back (a returned cheque, a transfer
-- that never arrived). Reason required. Its bills owe the money again (a closed
-- ticket is reopened and asks for payment), its unused credit is voided, the
-- receipt is marked REVERSED (new PDF). Blocked while its credit is used or
-- refunded, a bill has a slip waiting, is disputed or was cancelled.
create function app.reverse_payment(
  p_payment_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  a public.payment_allocations;
  inv public.invoices;
  v_ids uuid[];
  v_reason text := btrim(coalesce(p_reason, ''));
  v_results jsonb := '[]'::jsonb;
begin
  perform app.set_actor(p_actor_id);
  select * into pay from public.payments where id = p_payment_id for update;
  if not found then
    perform app.fail('RD404', 'Payment not found');
  end if;
  perform app.assert_actor(p_actor_id, pay.owner_id, pay.customer_id, array['OWNER']::public.user_role[]);
  if v_reason = '' then
    perform app.fail('RD400', 'A reason is required to reverse a payment');
  end if;
  if pay.status not in ('ACCEPTED', 'PARTIAL') then
    perform app.fail('RD409', 'Only an accepted payment can be reversed');
  end if;
  if pay.method = 'SECURITY_DEPOSIT' then
    perform app.fail('RD409', 'A payment from the security deposit cannot be reversed');
  end if;
  perform app.assert_payment_credits_unused(pay.id);

  v_ids := array(select x.invoice_id from public.payment_allocations x
                 where x.payment_id = pay.id and x.released_at is null and x.applied_cents > 0);
  perform app.lock_invoices_and_tickets(v_ids);
  for a in
    select x.* from public.payment_allocations x join public.invoices i on i.id = x.invoice_id
    where x.payment_id = pay.id and x.released_at is null and x.applied_cents > 0
    order by i.due_date nulls last, i.invoice_seq nulls last, i.id
  loop
    select * into inv from public.invoices where id = a.invoice_id;
    if inv.status = 'CANCELLED' then
      perform app.fail('RD409', format('Invoice %s was cancelled and its payment became a credit; the payment cannot be reversed', inv.invoice_no));
    end if;
    if inv.status = 'DISPUTED' then
      perform app.fail('RD409', format('Invoice %s is disputed; answer the dispute first', inv.invoice_no));
    end if;
    if inv.status = 'PAYMENT_SUBMITTED' then
      perform app.fail('RD409', format('A payment slip for %s is waiting; accept or reject it first', inv.invoice_no));
    end if;
    v_results := v_results || app.settle_invoice_payment(inv.id, inv.amount_paid_cents - a.applied_cents, p_actor_id,
      'Payment reversed: ' || v_reason, jsonb_build_object('payment_id', pay.id, 'reversed_cents', a.applied_cents));
  end loop;

  update public.credits set status = 'VOID' where source_payment_id = pay.id and status <> 'VOID';
  update public.payments
  set status = 'REVERSED', reversed_by = p_actor_id, reversed_at = now(), reverse_reason = v_reason
  where id = pay.id;
  update public.receipts set status = 'REVERSED', reversed_at = now(), reverse_reason = v_reason where payment_id = pay.id;
  perform app.write_audit(p_actor_id, 'PAYMENT_REVERSED', 'payments', pay.id, pay.owner_id,
    jsonb_build_object('reason', v_reason, 'accepted_cents', pay.accepted_amount_cents, 'credit_cents', pay.credit_cents,
                       'invoices', v_results));
  perform app.enqueue_notifications(pay.owner_id, p_notifications, 'payment', pay.id);
  return jsonb_build_object('payment_id', pay.id, 'status', 'REVERSED', 'invoices', v_results);
end;
$$;

-- Spec 11.5 "payment applied to the wrong invoice": the owner moves an accepted
-- payment to other bills of the same customer (reason required). Same payment,
-- same receipt number; the split is made again (oldest due first), the credit
-- recalculated, the receipt gets a new PDF version.
create function app.reallocate_payment(
  p_payment_id uuid,
  p_actor_id uuid,
  p_invoice_ids uuid[],
  p_reason text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  inv public.invoices;
  t public.billing_cycle_tickets;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_new uuid[] := coalesce(p_invoice_ids, '{}');
  v_old uuid[];
  v_all uuid[];
  v_plan jsonb;
  v_new_cents bigint;
  v_old_cents bigint;
  v_settled jsonb;
  v_open boolean := false;
  v_credit bigint;
  v_kind public.credit_kind;
  v_before jsonb;
  v_after jsonb := '[]'::jsonb;
begin
  perform app.set_actor(p_actor_id);
  select * into pay from public.payments where id = p_payment_id for update;
  if not found then
    perform app.fail('RD404', 'Payment not found');
  end if;
  perform app.assert_actor(p_actor_id, pay.owner_id, pay.customer_id, array['OWNER']::public.user_role[]);
  if v_reason = '' then
    perform app.fail('RD400', 'A reason is required to move a payment');
  end if;
  if pay.status not in ('ACCEPTED', 'PARTIAL') then
    perform app.fail('RD409', 'Only an accepted payment can be moved');
  end if;
  if pay.method = 'SECURITY_DEPOSIT' then
    perform app.fail('RD409', 'A payment from the security deposit cannot be moved');
  end if;
  if cardinality(v_new) <> (select count(distinct x) from unnest(v_new) x) then
    perform app.fail('RD400', 'A bill is listed twice');
  end if;
  perform app.assert_payment_credits_unused(pay.id);

  v_old := array(select a.invoice_id from public.payment_allocations a
                 where a.payment_id = pay.id and a.released_at is null and a.applied_cents > 0);
  if (select coalesce(array_agg(x order by x), '{}') from unnest(v_old) x)
     = (select coalesce(array_agg(x order by x), '{}') from unnest(v_new) x) then
    perform app.fail('RD400', 'Choose other bills than the ones the payment is on now');
  end if;
  v_all := array(select distinct x from unnest(v_old || v_new) x);
  perform app.lock_invoices_and_tickets(v_all);

  -- Every bill touched must be this customer's current, issued bill with no slip
  -- waiting and no dispute; a new one must also be in a payment stage.
  for inv in select * from public.invoices where id = any (v_all) order by id loop
    if inv.customer_id <> pay.customer_id or inv.invoice_no is null then
      perform app.fail('RD404', 'Bill not found');
    end if;
    if inv.status in ('CANCELLED', 'DISPUTED', 'PAYMENT_SUBMITTED') then
      perform app.fail('RD409', format('%s is %s; it cannot be changed now', inv.invoice_no,
        case inv.status when 'CANCELLED' then 'cancelled' when 'DISPUTED' then 'disputed' else 'waiting for a slip check' end));
    end if;
    select * into t from public.billing_cycle_tickets where id = inv.ticket_id;
    if t.current_invoice_id is distinct from inv.id then
      perform app.fail('RD409', format('%s was replaced by a newer invoice', inv.invoice_no));
    end if;
    if not (inv.id = any (v_old))
       and (inv.amount_paid_cents >= inv.total_cents
            or not (t.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED')
                    or (t.status = 'OVERDUE' and t.status_before_overdue in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED')))) then
      perform app.fail('RD409', format('%s has nothing left to pay', inv.invoice_no));
    end if;
  end loop;

  v_before := coalesce((select jsonb_agg(jsonb_build_object('invoice_id', a.invoice_id, 'applied_cents', a.applied_cents))
                        from public.payment_allocations a where a.payment_id = pay.id and a.released_at is null), '[]'::jsonb);
  v_plan := app.plan_allocation(pay.accepted_amount_cents, v_new, pay.id);

  for inv in
    select * from public.invoices where id = any (v_all)
    order by due_date nulls last, invoice_seq nulls last, id
  loop
    v_old_cents := coalesce((select sum(a.applied_cents) from public.payment_allocations a
                             where a.payment_id = pay.id and a.invoice_id = inv.id and a.released_at is null), 0);
    v_new_cents := coalesce((select (x ->> 'cents')::bigint from jsonb_array_elements(v_plan -> 'allocations') x
                             where (x ->> 'invoice_id')::uuid = inv.id), 0);
    v_settled := app.settle_invoice_payment(inv.id, inv.amount_paid_cents - v_old_cents + v_new_cents, p_actor_id,
      'Payment moved: ' || v_reason,
      jsonb_build_object('payment_id', pay.id, 'moved_from_cents', v_old_cents, 'moved_to_cents', v_new_cents));
    if v_new_cents > 0 then
      v_open := v_open or (v_settled ->> 'balance_cents')::bigint > 0;
      v_after := v_after || jsonb_build_object('invoice_id', inv.id, 'ticket_id', inv.ticket_id, 'cents', v_new_cents,
                                               'balance_cents', (v_settled ->> 'balance_cents')::bigint);
    end if;
  end loop;

  update public.payment_allocations
  set released_at = now(), release_reason = v_reason, waiting = false
  where payment_id = pay.id and released_at is null;
  insert into public.payment_allocations (owner_id, payment_id, invoice_id, ticket_id, customer_id, planned_cents,
                                          applied_cents, balance_after_cents)
  select pay.owner_id, pay.id, (x ->> 'invoice_id')::uuid, (x ->> 'ticket_id')::uuid, pay.customer_id,
         (x ->> 'cents')::bigint, (x ->> 'cents')::bigint, (x ->> 'balance_cents')::bigint
  from jsonb_array_elements(v_after) x;

  select k.kind into v_kind from public.credits k where k.source_payment_id = pay.id and k.status <> 'VOID' limit 1;
  update public.credits set status = 'VOID' where source_payment_id = pay.id and status <> 'VOID';
  v_credit := (v_plan ->> 'credit_cents')::bigint;
  if v_credit > 0 then
    v_kind := coalesce(v_kind, case when cardinality(v_new) = 0 then 'ADVANCE' else 'OVERPAYMENT' end::public.credit_kind);
    insert into public.credits (owner_id, customer_id, source_payment_id, kind, amount_cents, reason, created_by,
                                received_on, method, reference)
    values (pay.owner_id, pay.customer_id, pay.id, v_kind, v_credit,
            format('Left over after the payment of %s on %s was moved', app.format_rupees(pay.accepted_amount_cents),
                   to_char(pay.paid_on, 'DD Mon YYYY')),
            p_actor_id, pay.paid_on, pay.method, pay.reference);
  end if;

  update public.payments
  set status = (case when v_open then 'PARTIAL' else 'ACCEPTED' end)::public.payment_status, credit_cents = v_credit
  where id = pay.id;
  update public.receipts
  set content = app.receipt_content(pay.id)
                || jsonb_build_object('reallocated', jsonb_build_object('reason', v_reason, 'at', now()))
  where payment_id = pay.id;

  perform app.write_audit(p_actor_id, 'PAYMENT_REALLOCATED', 'payments', pay.id, pay.owner_id,
    jsonb_build_object('reason', v_reason, 'from', v_before, 'to', v_after, 'credit_cents', v_credit));
  perform app.enqueue_notifications(pay.owner_id, p_notifications, 'payment', pay.id);
  return jsonb_build_object('payment_id', pay.id, 'status', case when v_open then 'PARTIAL' else 'ACCEPTED' end,
                            'allocations', v_after, 'credit_cents', v_credit);
end;
$$;

-- PAY-12: the owner pays a credit back (amount, date, method, reference). Only the
-- part not used by an invoice or reserved by a draft can be refunded.
create function app.refund_credit(
  p_credit_id uuid,
  p_actor_id uuid,
  p_refund jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.credits;
  v_details jsonb;
  v_amount bigint;
  v_used bigint;
  v_free bigint;
  v_refund_id uuid;
begin
  perform app.set_actor(p_actor_id);
  select * into c from public.credits where id = p_credit_id for update;
  if not found then
    perform app.fail('RD404', 'Credit not found');
  end if;
  perform app.assert_actor(p_actor_id, c.owner_id, c.customer_id, array['OWNER']::public.user_role[]);
  if c.status in ('VOID', 'REFUNDED') then
    perform app.fail('RD409', 'Nothing is left of this credit to refund');
  end if;
  v_details := app.payment_details(
    jsonb_build_object('amount_cents', p_refund -> 'amount_cents', 'paid_on', p_refund -> 'refunded_on',
                       'method', p_refund -> 'method', 'reference', p_refund -> 'reference', 'note', p_refund -> 'note'),
    array['CASH', 'CHEQUE', 'BANK_TRANSFER', 'DEPOSIT', 'OTHER']::public.payment_method[]);
  v_amount := (v_details ->> 'amount_cents')::bigint;
  v_used := app.credit_used(c.id);
  v_free := c.amount_cents - c.refunded_cents - v_used;
  if v_amount > v_free then
    perform app.fail('RD409', format('Only %s of this credit can be refunded now%s', app.format_rupees(greatest(v_free, 0)),
      case when v_used > 0 then ' (the rest is used on an invoice or a draft)' else '' end));
  end if;

  insert into public.credit_refunds (owner_id, customer_id, credit_id, amount_cents, refunded_on, method, reference, note, created_by)
  values (c.owner_id, c.customer_id, c.id, v_amount, (v_details ->> 'paid_on')::date,
          (v_details ->> 'method')::public.payment_method, v_details ->> 'reference', v_details ->> 'note', p_actor_id)
  returning id into v_refund_id;
  update public.credits set refunded_cents = refunded_cents + v_amount where id = c.id;
  perform app.refresh_credit_status(array[c.id]);

  perform app.write_audit(p_actor_id, 'CREDIT_REFUNDED', 'credits', c.id, c.owner_id,
    jsonb_build_object('refund_id', v_refund_id, 'amount_cents', v_amount, 'refunded_on', v_details ->> 'paid_on',
                       'method', v_details ->> 'method', 'reference', v_details ->> 'reference'));
  perform app.enqueue_notifications(c.owner_id, p_notifications, 'credit', c.id);
  return jsonb_build_object('refund_id', v_refund_id, 'credit_id', c.id, 'amount_cents', v_amount,
                            'left_cents', v_free - v_amount,
                            'status', (select k.status from public.credits k where k.id = c.id));
end;
$$;

-- Slip files uploaded but never sent with a payment, older than 2 days (rule 30's
-- counterpart for slips).
create function app.cron_orphan_slips(p_now timestamptz, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(o.name order by o.created_at), '[]'::jsonb)
  from (
    select so.name, so.created_at
    from storage.objects so
    where so.bucket_id = 'payment-slips'
      and so.created_at < p_now - interval '2 days'
      and not exists (select 1 from public.payment_slips s where s.storage_path = so.name)
    order by so.created_at
    limit p_limit
  ) o;
$$;

-- =============================================================================
-- G. Security deposits pay bills through the same path (replaces 0017's)
-- =============================================================================
create or replace function app.deposit_deductible_invoices(p_agreement_id uuid) returns setof public.invoices
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
    and not exists (select 1 from public.payment_allocations pa where pa.invoice_id = i.id and pa.waiting)
  order by i.due_date nulls last, i.invoice_seq nulls last, i.id;
$$;

create or replace function app.apply_deposit_settlement(a public.rental_agreements, p_actor_id uuid, p_settlement jsonb, p_today date)
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
  v_ids uuid[];
  inv public.invoices;
  t public.billing_cycle_tickets;
  v_rest bigint;
  v_amount bigint;
  v_paid bigint;
  v_full boolean;
  v_payment_id uuid;
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

  v_ids := array(select d.id from app.deposit_deductible_invoices(a.id) d);
  perform app.lock_invoices_and_tickets(v_ids);
  select coalesce(sum(i.total_cents - i.amount_paid_cents), 0) into v_deductible
  from app.deposit_deductible_invoices(a.id) i;
  if v_deduct > v_deductible then
    perform app.fail('RD400', format('At most %s can be deducted (unpaid invoices without a slip waiting or a dispute)',
                                     app.format_rupees(v_deductible)));
  end if;

  v_rest := v_deduct;
  for inv in
    select i.* from public.invoices i
    where i.id = any (v_ids)
    order by i.due_date nulls last, i.invoice_seq nulls last, i.id
  loop
    exit when v_rest = 0;
    select * into t from public.billing_cycle_tickets where id = inv.ticket_id;
    v_amount := least(v_rest, inv.total_cents - inv.amount_paid_cents);
    v_rest := v_rest - v_amount;
    v_paid := inv.amount_paid_cents + v_amount;
    v_full := v_paid >= inv.total_cents;

    insert into public.payments (owner_id, customer_id, source, method, amount_cents, accepted_amount_cents, paid_on,
                                 reference, note, status, submitted_by, verified_by, verified_at)
    values (inv.owner_id, inv.customer_id, 'OWNER_MANUAL', 'SECURITY_DEPOSIT', v_amount, v_amount, p_today,
            'Security deposit', 'Deducted from the security deposit',
            (case when v_full then 'ACCEPTED' else 'PARTIAL' end)::public.payment_status, p_actor_id, p_actor_id, now())
    returning id into v_payment_id;

    if t.current_invoice_id = inv.id and t.status not in ('CLOSED', 'CANCELLED') then
      perform app.settle_invoice_payment(inv.id, v_paid, p_actor_id, 'Paid from the security deposit',
        jsonb_build_object('payment_id', v_payment_id, 'amount_cents', v_amount, 'method', 'SECURITY_DEPOSIT'));
    else
      update public.invoices
      set amount_paid_cents = v_paid,
          status = (case when v_full then 'PAID' else 'PARTIALLY_PAID' end)::public.invoice_status
      where id = inv.id;
    end if;
    insert into public.payment_allocations (owner_id, payment_id, invoice_id, ticket_id, customer_id, planned_cents,
                                            applied_cents, balance_after_cents)
    values (inv.owner_id, v_payment_id, inv.id, inv.ticket_id, inv.customer_id, v_amount, v_amount, inv.total_cents - v_paid);
    perform app.issue_receipt(v_payment_id);

    insert into public.deposit_transactions (owner_id, customer_id, agreement_id, kind, amount_cents, occurred_on,
                                             method, reference, invoice_id, payment_id, created_by)
    values (a.owner_id, a.customer_id, a.id, 'DEDUCTED', v_amount, p_today, 'SECURITY_DEPOSIT', inv.invoice_no,
            inv.id, v_payment_id, p_actor_id);

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

-- Every receipt issued before this migration (accepted payments, deposits).
do $$
declare
  v_id uuid;
begin
  for v_id in select p.id from public.payments p where p.status in ('ACCEPTED', 'PARTIAL') order by p.verified_at nulls first, p.submitted_at, p.id loop
    perform app.issue_receipt(v_id);
  end loop;
end;
$$;

-- =============================================================================
-- H. Storage
-- =============================================================================
drop policy "payment-slips: customer uploads for own ticket awaiting payment" on storage.objects;
drop policy "payment-slips: read by customer, owner, admin" on storage.objects;

-- The customer uploads into {owner}/{customer}/; the server checks the file before
-- recording it.
create policy "payment-slips: customer uploads to own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'payment-slips'
  and (select app.current_user_role()) = 'CUSTOMER'
  and array_length(storage.foldername(objects.name), 1) = 2
  and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
  and (storage.foldername(objects.name))[2] = (select app.current_customer_id())::text
);

-- The owner and admin see only slips that were checked and recorded; the customer
-- sees their own folder.
create policy "payment-slips: read recorded slips"
on storage.objects for select to authenticated
using (
  bucket_id = 'payment-slips'
  and (
    ((select app.is_admin()) and exists (select 1 from public.payment_slips s where s.storage_path = objects.name))
    or ((select app.current_user_role()) = 'OWNER'
        and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
        and exists (select 1 from public.payment_slips s where s.storage_path = objects.name))
    or ((select app.current_user_role()) = 'CUSTOMER'
        and (storage.foldername(objects.name))[2] = (select app.current_customer_id())::text)
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('receipts', 'receipts', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "receipts: read by owner, customer, admin"
on storage.objects for select to authenticated
using (
  bucket_id = 'receipts'
  and (
    (select app.is_admin())
    or ((select app.current_user_role()) = 'OWNER'
        and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text)
    or exists (
      select 1 from public.receipts r
      where r.owner_id::text = (storage.foldername(objects.name))[1]
        and r.id::text = (storage.foldername(objects.name))[2]
        and r.customer_id = (select app.current_customer_id())
    )
  )
);

-- =============================================================================
-- I. RLS and grants (new tables get no automatic grants in this project)
-- =============================================================================
alter table public.payment_allocations enable row level security;
alter table public.credit_refunds enable row level security;
alter table public.receipts enable row level security;
alter table public.receipt_counters enable row level security;
alter table public.receipt_pdf_versions enable row level security;

create policy payment_allocations_select on public.payment_allocations for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);
create policy credit_refunds_select on public.credit_refunds for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);
create policy receipts_select on public.receipts for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);
create policy receipt_counters_select on public.receipt_counters for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);
create policy receipt_pdf_versions_select on public.receipt_pdf_versions for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);

grant select on public.payment_allocations, public.credit_refunds, public.receipts, public.receipt_counters,
  public.receipt_pdf_versions to authenticated, service_role;

-- =============================================================================
-- J. Function grants and public.rpc_* wrappers (service role only)
-- =============================================================================
revoke all on function
  app.payment_stage_due(date),
  app.branding_snapshot(uuid),
  app.receipt_pdf_flag(),
  app.receipt_content(uuid),
  app.issue_receipt(uuid),
  app.claim_receipt_pdf(uuid, timestamptz),
  app.record_receipt_pdf(uuid, integer, integer, text, text, integer, text),
  app.mark_receipt_pdf_failed(uuid, text),
  app.cron_pending_receipt_pdfs(timestamptz, integer),
  app.ticket_hop(uuid, public.ticket_status, uuid, text, jsonb, timestamptz),
  app.lock_invoices_and_tickets(uuid[]),
  app.settle_invoice_payment(uuid, bigint, uuid, text, jsonb),
  app.assert_payable(uuid[], uuid),
  app.plan_allocation(bigint, uuid[], uuid),
  app.payment_duplicates(uuid, text, text, text, bigint, uuid),
  app.assert_payment_credits_unused(uuid),
  app.apply_payment(uuid, bigint, uuid, text, public.credit_kind),
  app.payment_details(jsonb, public.payment_method[]),
  app.submit_payment(uuid, uuid, uuid, uuid[], jsonb, jsonb, timestamptz, jsonb),
  app.verify_payment(uuid, uuid, boolean, bigint, text, jsonb),
  app.record_manual_payment(uuid, uuid, uuid, uuid[], jsonb, jsonb),
  app.reverse_payment(uuid, uuid, text, jsonb),
  app.reallocate_payment(uuid, uuid, uuid[], text, jsonb),
  app.refund_credit(uuid, uuid, jsonb, jsonb),
  app.cron_orphan_slips(timestamptz, integer)
from public, anon, authenticated;

grant execute on function
  app.payment_stage_due(date),
  app.plan_allocation(bigint, uuid[], uuid),
  app.payment_duplicates(uuid, text, text, text, bigint, uuid),
  app.claim_receipt_pdf(uuid, timestamptz),
  app.record_receipt_pdf(uuid, integer, integer, text, text, integer, text),
  app.mark_receipt_pdf_failed(uuid, text),
  app.cron_pending_receipt_pdfs(timestamptz, integer),
  app.submit_payment(uuid, uuid, uuid, uuid[], jsonb, jsonb, timestamptz, jsonb),
  app.verify_payment(uuid, uuid, boolean, bigint, text, jsonb),
  app.record_manual_payment(uuid, uuid, uuid, uuid[], jsonb, jsonb),
  app.reverse_payment(uuid, uuid, text, jsonb),
  app.reallocate_payment(uuid, uuid, uuid[], text, jsonb),
  app.refund_credit(uuid, uuid, jsonb, jsonb),
  app.cron_orphan_slips(timestamptz, integer)
to service_role;

create function public.rpc_submit_payment(
  p_actor_id uuid, p_customer_id uuid, p_idempotency_key uuid, p_invoice_ids uuid[], p_payment jsonb, p_slip jsonb,
  p_stage_due_at timestamptz, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.submit_payment(p_actor_id, p_customer_id, p_idempotency_key, p_invoice_ids, p_payment, p_slip, p_stage_due_at, p_notifications);
$$;

create function public.rpc_verify_payment(
  p_payment_id uuid, p_actor_id uuid, p_accept boolean, p_accepted_amount_cents bigint default null,
  p_reason text default null, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.verify_payment(p_payment_id, p_actor_id, p_accept, p_accepted_amount_cents, p_reason, p_notifications);
$$;

create function public.rpc_record_manual_payment(
  p_actor_id uuid, p_customer_id uuid, p_idempotency_key uuid, p_invoice_ids uuid[], p_payment jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.record_manual_payment(p_actor_id, p_customer_id, p_idempotency_key, p_invoice_ids, p_payment, p_notifications);
$$;

create function public.rpc_reverse_payment(
  p_payment_id uuid, p_actor_id uuid, p_reason text, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.reverse_payment(p_payment_id, p_actor_id, p_reason, p_notifications);
$$;

create function public.rpc_reallocate_payment(
  p_payment_id uuid, p_actor_id uuid, p_invoice_ids uuid[], p_reason text, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.reallocate_payment(p_payment_id, p_actor_id, p_invoice_ids, p_reason, p_notifications);
$$;

create function public.rpc_refund_credit(
  p_credit_id uuid, p_actor_id uuid, p_refund jsonb, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.refund_credit(p_credit_id, p_actor_id, p_refund, p_notifications);
$$;

create function public.rpc_payment_duplicates(
  p_owner_id uuid, p_sha256 text, p_original_sha256 text, p_reference text, p_amount_cents bigint
) returns jsonb language sql set search_path = '' as $$
  select app.payment_duplicates(p_owner_id, p_sha256, p_original_sha256, p_reference, p_amount_cents, null);
$$;

create function public.rpc_plan_allocation(p_amount_cents bigint, p_invoice_ids uuid[]) returns jsonb
language sql set search_path = '' as $$
  select app.plan_allocation(p_amount_cents, p_invoice_ids, null);
$$;

create function public.rpc_claim_receipt_pdf(p_receipt_id uuid, p_now timestamptz) returns jsonb
language sql set search_path = '' as $$
  select app.claim_receipt_pdf(p_receipt_id, p_now);
$$;

create function public.rpc_record_receipt_pdf(
  p_receipt_id uuid, p_revision integer, p_version integer, p_path text, p_hash text, p_size integer, p_template text
) returns jsonb language sql set search_path = '' as $$
  select app.record_receipt_pdf(p_receipt_id, p_revision, p_version, p_path, p_hash, p_size, p_template);
$$;

create function public.rpc_mark_receipt_pdf_failed(p_receipt_id uuid, p_error text) returns integer
language sql set search_path = '' as $$
  select app.mark_receipt_pdf_failed(p_receipt_id, p_error);
$$;

create function public.rpc_cron_pending_receipt_pdfs(p_now timestamptz, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_pending_receipt_pdfs(p_now, p_limit);
$$;

create function public.rpc_cron_orphan_slips(p_now timestamptz, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_orphan_slips(p_now, p_limit);
$$;

revoke execute on function
  public.rpc_submit_payment(uuid, uuid, uuid, uuid[], jsonb, jsonb, timestamptz, jsonb),
  public.rpc_verify_payment(uuid, uuid, boolean, bigint, text, jsonb),
  public.rpc_record_manual_payment(uuid, uuid, uuid, uuid[], jsonb, jsonb),
  public.rpc_reverse_payment(uuid, uuid, text, jsonb),
  public.rpc_reallocate_payment(uuid, uuid, uuid[], text, jsonb),
  public.rpc_refund_credit(uuid, uuid, jsonb, jsonb),
  public.rpc_payment_duplicates(uuid, text, text, text, bigint),
  public.rpc_plan_allocation(bigint, uuid[]),
  public.rpc_claim_receipt_pdf(uuid, timestamptz),
  public.rpc_record_receipt_pdf(uuid, integer, integer, text, text, integer, text),
  public.rpc_mark_receipt_pdf_failed(uuid, text),
  public.rpc_cron_pending_receipt_pdfs(timestamptz, integer),
  public.rpc_cron_orphan_slips(timestamptz, integer)
from public, anon, authenticated;
grant execute on function
  public.rpc_submit_payment(uuid, uuid, uuid, uuid[], jsonb, jsonb, timestamptz, jsonb),
  public.rpc_verify_payment(uuid, uuid, boolean, bigint, text, jsonb),
  public.rpc_record_manual_payment(uuid, uuid, uuid, uuid[], jsonb, jsonb),
  public.rpc_reverse_payment(uuid, uuid, text, jsonb),
  public.rpc_reallocate_payment(uuid, uuid, uuid[], text, jsonb),
  public.rpc_refund_credit(uuid, uuid, jsonb, jsonb),
  public.rpc_payment_duplicates(uuid, text, text, text, bigint),
  public.rpc_plan_allocation(bigint, uuid[]),
  public.rpc_claim_receipt_pdf(uuid, timestamptz),
  public.rpc_record_receipt_pdf(uuid, integer, integer, text, text, integer, text),
  public.rpc_mark_receipt_pdf_failed(uuid, text),
  public.rpc_cron_pending_receipt_pdfs(timestamptz, integer),
  public.rpc_cron_orphan_slips(timestamptz, integer)
to service_role;
