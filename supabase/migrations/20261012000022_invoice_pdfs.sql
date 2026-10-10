-- =============================================================================
-- 0022 Invoice PDFs and the owner's letterhead (task 6b; INV-09, BRD-02..07,
-- CP-04, CP-05; decisions 33-38).
--
-- * invoices: PDF state. A trigger marks the PDF PENDING whenever an issued
--   invoice changes in a way the PDF shows (issued, late fee, due date, amounts,
--   cancelled); server code renders it, the daily job retries.
-- * invoice_pdf_versions: every PDF ever made for an invoice (v1, v2, ...),
--   kept; the newest is invoices.pdf_path.
-- * Private bucket `invoices`: {owner_id}/{invoice_id}/v{n}.pdf, read by the
--   owner, the invoice's customer and admin; written by the server only.
-- * Branding files are immutable: logos and letterheads live at content-hash
--   paths and are never overwritten or deleted, so a later PDF version of an old
--   invoice uses the files of its snapshot (decision 35). Owners no longer write
--   the company profile or the branding bucket directly (server code validates).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Company profile: payment instructions; server-write-only from now on.
-- -----------------------------------------------------------------------------
alter table public.owner_company_profiles
  add column payment_instructions text
    check (payment_instructions is null or length(payment_instructions) <= 300);

-- All writes go through rpc_save_company_profile / rpc_save_invoice_template,
-- which the server calls after validating (English only, decision 33; file checks).
revoke insert, update on public.owner_company_profiles from authenticated;

drop policy if exists "branding: owner uploads to own prefix" on storage.objects;
drop policy if exists "branding: owner updates own prefix" on storage.objects;
drop policy if exists "branding: owner deletes own prefix" on storage.objects;

-- Logo paths: the legacy fixed path, or a content-hash path (decision 35).
create or replace function app.valid_logo_path(p_owner_id uuid, p_path text) returns boolean
language sql immutable set search_path = '' as $$
  select p_path = p_owner_id::text || '/logo.png'
      or p_path ~ ('^' || p_owner_id::text || '/logos/[0-9a-f]{64}\.png$');
$$;

create or replace function app.valid_letterhead_path(p_owner_id uuid, p_path text) returns boolean
language sql immutable set search_path = '' as $$
  select p_path ~ ('^' || p_owner_id::text || '/letterheads/[0-9a-f]{64}\.(pdf|jpg|png)$');
$$;

create or replace function app.save_company_profile(p_owner_id uuid, p_details jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.user_role;
  v_completed timestamptz;
begin
  select p.role into v_role
  from public.profiles p
  where p.id = p_owner_id and p.status = 'ACTIVE';
  if v_role is distinct from 'OWNER' then
    perform app.fail('RD403', 'Only an active owner can change company details');
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    perform app.fail('RD400', 'Company details must be an object');
  end if;
  if p_details ? 'logo_path' and p_details ->> 'logo_path' is not null
     and not app.valid_logo_path(p_owner_id, p_details ->> 'logo_path') then
    perform app.fail('RD400', 'Invalid logo path');
  end if;

  perform app.set_actor(p_owner_id);

  insert into public.owner_company_profiles as c (
    owner_id, company_name, address, phone, email, bank_name, bank_branch,
    bank_account_name, bank_account_no, logo_path, onboarding_completed_at
  ) values (
    p_owner_id,
    p_details ->> 'company_name',
    p_details ->> 'address',
    p_details ->> 'phone',
    p_details ->> 'email',
    p_details ->> 'bank_name',
    p_details ->> 'bank_branch',
    p_details ->> 'bank_account_name',
    p_details ->> 'bank_account_no',
    p_details ->> 'logo_path',
    now()
  )
  on conflict (owner_id) do update
  set company_name = excluded.company_name,
      address = excluded.address,
      phone = excluded.phone,
      email = excluded.email,
      bank_name = excluded.bank_name,
      bank_branch = excluded.bank_branch,
      bank_account_name = excluded.bank_account_name,
      bank_account_no = excluded.bank_account_no,
      logo_path = case when p_details ? 'logo_path' then excluded.logo_path else c.logo_path end,
      onboarding_completed_at = coalesce(c.onboarding_completed_at, now())
  returning onboarding_completed_at into v_completed;

  return jsonb_build_object('owner_id', p_owner_id, 'onboarding_completed_at', v_completed);
end;
$$;

-- -----------------------------------------------------------------------------
-- Settings > Invoice template (BRD-04..07). The layout is validated by server
-- code (src/lib/invoices/pdf/layout.ts); the database keeps the area inside
-- the page and at least the minimum size.
-- -----------------------------------------------------------------------------
create function app.valid_letterhead_layout(p_layout jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  x numeric; y numeric; w numeric; h numeric;
begin
  if jsonb_typeof(p_layout) <> 'object' or jsonb_typeof(p_layout -> 'area') <> 'object' then return false; end if;
  if coalesce(p_layout ->> 'preset', '') not in ('HEADER_ONLY', 'HEADER_FOOTER', 'FULL_PAGE', 'CUSTOM') then return false; end if;
  if jsonb_typeof(p_layout -> 'area' -> 'x') <> 'number' or jsonb_typeof(p_layout -> 'area' -> 'y') <> 'number'
     or jsonb_typeof(p_layout -> 'area' -> 'w') <> 'number' or jsonb_typeof(p_layout -> 'area' -> 'h') <> 'number' then
    return false;
  end if;
  x := (p_layout -> 'area' ->> 'x')::numeric;
  y := (p_layout -> 'area' ->> 'y')::numeric;
  w := (p_layout -> 'area' ->> 'w')::numeric;
  h := (p_layout -> 'area' ->> 'h')::numeric;
  return x >= 0 and y >= 0 and w >= 50 and h >= 40 and x + w <= 100 and y + h <= 100;
end;
$$;

create function app.save_invoice_template(p_owner_id uuid, p_template jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := nullif(p_template ->> 'letterhead_path', '');
  v_layout jsonb := coalesce(p_template -> 'letterhead_layout', '{}'::jsonb);
  v_instructions text := nullif(btrim(coalesce(p_template ->> 'payment_instructions', '')), '');
begin
  if not exists (select 1 from public.profiles p where p.id = p_owner_id and p.role = 'OWNER' and p.status = 'ACTIVE') then
    perform app.fail('RD403', 'Only an active owner can change the invoice template');
  end if;
  if not exists (select 1 from public.owner_company_profiles where owner_id = p_owner_id) then
    perform app.fail('RD409', 'Complete the company details first');
  end if;
  if v_path is not null and not app.valid_letterhead_path(p_owner_id, v_path) then
    perform app.fail('RD400', 'Invalid letterhead path');
  end if;
  if v_path is not null and not app.valid_letterhead_layout(v_layout) then
    perform app.fail('RD400', 'Invalid letterhead layout');
  end if;
  if v_path is null then v_layout := '{}'::jsonb; end if;
  if length(v_instructions) > 300 then
    perform app.fail('RD400', 'Payment instructions are too long');
  end if;

  perform app.set_actor(p_owner_id);
  update public.owner_company_profiles
  set letterhead_path = v_path, letterhead_layout = v_layout, payment_instructions = v_instructions
  where owner_id = p_owner_id;
  return jsonb_build_object('letterhead_path', v_path, 'letterhead_layout', v_layout, 'payment_instructions', v_instructions);
end;
$$;

-- -----------------------------------------------------------------------------
-- invoices: PDF state (decision 34).
-- -----------------------------------------------------------------------------
alter table public.invoices
  add column pdf_status text not null default 'NONE' check (pdf_status in ('NONE', 'PENDING', 'READY')),
  add column pdf_revision integer not null default 0 check (pdf_revision >= 0),
  add column pdf_pending_reason text check (pdf_pending_reason in ('ISSUED', 'LATE_FEE', 'DUE_DATE', 'CANCELLED', 'CHANGED')),
  add column pdf_requested_at timestamptz,
  add column pdf_claimed_at timestamptz,
  add column pdf_attempts integer not null default 0 check (pdf_attempts >= 0),
  add column pdf_last_error text;
comment on column public.invoices.pdf_revision is
  'Bumped whenever the PDF content changes; a render is READY only if no change came in while it ran.';
create index invoices_pdf_pending_idx on public.invoices (pdf_attempts, pdf_requested_at) where pdf_status = 'PENDING';

-- Every invoice issued before this migration gets its first PDF from the daily job.
update public.invoices
set pdf_status = 'PENDING', pdf_revision = 1, pdf_pending_reason = 'ISSUED', pdf_requested_at = now()
where invoice_no is not null;

create function app.invoice_pdf_flag() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reason text;
begin
  if new.invoice_no is null then
    return new;
  end if;
  if tg_op = 'INSERT' or old.invoice_no is null then
    v_reason := 'ISSUED';
  elsif new.status = 'CANCELLED' and old.status <> 'CANCELLED' then
    v_reason := 'CANCELLED';
  elsif new.late_fee_cents <> old.late_fee_cents then
    v_reason := 'LATE_FEE';
  elsif new.due_date is distinct from old.due_date then
    v_reason := 'DUE_DATE';
  elsif (new.total_cents, new.subtotal_cents, new.credit_applied_cents, new.branding_snapshot)
        is distinct from (old.total_cents, old.subtotal_cents, old.credit_applied_cents, old.branding_snapshot) then
    v_reason := 'CHANGED';
  else
    return new; -- payment status changes are not printed (no PAID stamp)
  end if;
  new.pdf_status := 'PENDING';
  new.pdf_revision := case when tg_op = 'INSERT' then 1 else old.pdf_revision + 1 end;
  new.pdf_pending_reason := v_reason;
  new.pdf_requested_at := now();
  new.pdf_last_error := null;
  return new;
end;
$$;

create trigger invoices_pdf_flag before insert or update on public.invoices
  for each row execute function app.invoice_pdf_flag();

-- -----------------------------------------------------------------------------
-- invoice_pdf_versions. SERVER-WRITE-ONLY, append-only.
-- -----------------------------------------------------------------------------
create table public.invoice_pdf_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners (id),
  invoice_id uuid not null,
  customer_id uuid not null,
  version integer not null check (version >= 1),
  storage_path text not null,
  reason text not null check (reason in ('ISSUED', 'LATE_FEE', 'DUE_DATE', 'CANCELLED', 'CHANGED')),
  template text not null check (template in ('BUILT_IN', 'LETTERHEAD')),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check (byte_size > 0),
  -- Customer and machine as printed on version 1; later versions reuse them.
  parties jsonb not null check (jsonb_typeof(parties) = 'object'),
  created_at timestamptz not null default now(),
  constraint invoice_pdf_versions_version_key unique (invoice_id, version),
  constraint invoice_pdf_versions_path check (storage_path = owner_id::text || '/' || invoice_id::text || '/v' || version::text || '.pdf'),
  constraint invoice_pdf_versions_invoice_fkey foreign key (invoice_id, owner_id) references public.invoices (id, owner_id),
  constraint invoice_pdf_versions_customer_fkey foreign key (customer_id, owner_id) references public.customers (id, owner_id)
);
comment on table public.invoice_pdf_versions is 'SERVER-WRITE-ONLY, append-only. Every PDF made for an invoice (decision 34).';
create index invoice_pdf_versions_owner_idx on public.invoice_pdf_versions (owner_id);
create index invoice_pdf_versions_customer_idx on public.invoice_pdf_versions (customer_id, owner_id);

alter table public.invoice_pdf_versions enable row level security;
create policy invoice_pdf_versions_select on public.invoice_pdf_versions for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or exists (
    select 1 from public.invoices i
    where i.id = invoice_pdf_versions.invoice_id
      and i.customer_id = (select app.current_customer_id())
      and i.status not in ('DRAFT', 'REJECTED')
  )
);
-- Append-only through grants (as deposit_transactions): no update or delete for anyone.
grant select on public.invoice_pdf_versions to authenticated;
grant select, insert on public.invoice_pdf_versions to service_role;

-- -----------------------------------------------------------------------------
-- Bucket `invoices`.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('invoices', 'invoices', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "invoices: read by owner, customer, admin"
on storage.objects for select to authenticated
using (
  bucket_id = 'invoices'
  and (
    (select app.is_admin())
    or ((select app.current_user_role()) = 'OWNER'
        and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text)
    or exists (
      select 1 from public.invoices i
      where i.owner_id::text = (storage.foldername(objects.name))[1]
        and i.id::text = (storage.foldername(objects.name))[2]
        and i.customer_id = (select app.current_customer_id())
        and i.status not in ('DRAFT', 'REJECTED')
    )
  )
);

-- -----------------------------------------------------------------------------
-- Rendering: claim → (render, upload) → record, or → failed.
-- -----------------------------------------------------------------------------

-- A pending invoice's data for the renderer, claimed for 5 minutes so two
-- renderers (the confirm action and the daily job) never make the same version.
-- Null when there is nothing to do.
create function app.claim_invoice_pdf(p_invoice_id uuid, p_now timestamptz) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  v_latest public.invoice_pdf_versions;
  v_first public.invoice_pdf_versions;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if not found or inv.invoice_no is null or inv.pdf_status <> 'PENDING' then
    return null;
  end if;
  if inv.pdf_claimed_at is not null and inv.pdf_claimed_at > p_now - interval '5 minutes' then
    return null;
  end if;
  update public.invoices set pdf_claimed_at = p_now where id = inv.id;

  select * into v_latest from public.invoice_pdf_versions where invoice_id = inv.id order by version desc limit 1;
  select * into v_first from public.invoice_pdf_versions where invoice_id = inv.id order by version limit 1;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', inv.id, 'owner_id', inv.owner_id, 'customer_id', inv.customer_id, 'invoice_no', inv.invoice_no,
      'type', inv.type, 'status', inv.status, 'period_start', inv.period_start, 'period_end', inv.period_end,
      'cycles_covered', inv.cycles_covered, 'subtotal_cents', inv.subtotal_cents, 'late_fee_cents', inv.late_fee_cents,
      'credit_applied_cents', inv.credit_applied_cents, 'total_cents', inv.total_cents, 'due_date', inv.due_date,
      'issued_at', inv.issued_at, 'cancelled_at', inv.cancelled_at, 'cancel_reason', inv.cancel_reason,
      'calculation', inv.calculation, 'branding_snapshot', inv.branding_snapshot,
      'pdf_revision', inv.pdf_revision, 'pdf_pending_reason', inv.pdf_pending_reason),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'line_type', l.line_type, 'description', l.description, 'quantity', l.quantity,
        'rate_cents', l.rate_cents, 'amount_cents', l.amount_cents) order by l.sort_order, l.created_at, l.id), '[]'::jsonb)
      from public.invoice_lines l where l.invoice_id = inv.id),
    'customer', (
      select jsonb_build_object('name', c.name, 'business_name', c.business_name, 'address', c.address)
      from public.customers c where c.id = inv.customer_id),
    'machine', (
      select jsonb_build_object('brand', m.brand, 'model', m.model, 'serial_no', m.serial_no, 'type', m.type)
      from public.machines m where m.id = inv.machine_id),
    'location', (select a.installation_location from public.rental_agreements a where a.id = inv.agreement_id),
    'cycle_no', (select t.cycle_no from public.billing_cycle_tickets t where t.id = inv.ticket_id),
    'latest', case when v_latest.id is null then null
                   else jsonb_build_object('version', v_latest.version, 'content_hash', v_latest.content_hash) end,
    'parties', v_first.parties
  );
end;
$$;

-- Records a rendered PDF. p_version null = the content equals the newest version
-- (nothing new to store). READY only when no change came in during the render.
create function app.record_invoice_pdf(
  p_invoice_id uuid,
  p_revision integer,
  p_version integer,
  p_path text,
  p_hash text,
  p_size integer,
  p_template text,
  p_parties jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  v_max integer;
  v_reason text;
  v_ready boolean;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if not found or inv.invoice_no is null then
    perform app.fail('RD404', 'Invoice not found or not issued');
  end if;
  select max(version) into v_max from public.invoice_pdf_versions where invoice_id = inv.id;

  if p_version is not null then
    if p_version <> coalesce(v_max, 0) + 1 then
      perform app.fail('RD409', 'PDF_VERSION_CONFLICT');
    end if;
    v_reason := case when v_max is null then 'ISSUED' else coalesce(inv.pdf_pending_reason, 'CHANGED') end;
    insert into public.invoice_pdf_versions (owner_id, invoice_id, customer_id, version, storage_path, reason,
                                             template, content_hash, byte_size, parties)
    values (inv.owner_id, inv.id, inv.customer_id, p_version, p_path, v_reason, p_template, p_hash, p_size, p_parties);
    perform app.write_audit(null, 'INVOICE_PDF_CREATED', 'invoices', inv.id, inv.owner_id,
      jsonb_build_object('invoice_no', inv.invoice_no, 'version', p_version, 'reason', v_reason, 'template', p_template));
  elsif v_max is null then
    perform app.fail('RD400', 'There is no earlier PDF to keep');
  end if;

  v_ready := inv.pdf_revision = p_revision;
  update public.invoices
  set pdf_path = case when p_version is not null then p_path else pdf_path end,
      pdf_claimed_at = null,
      pdf_status = case when v_ready then 'READY' else pdf_status end,
      pdf_pending_reason = case when v_ready then null else pdf_pending_reason end,
      pdf_attempts = case when v_ready then 0 else pdf_attempts end,
      pdf_last_error = case when v_ready then null else pdf_last_error end
  where id = inv.id;
  return jsonb_build_object('version', coalesce(p_version, v_max), 'ready', v_ready);
end;
$$;

create function app.mark_invoice_pdf_failed(p_invoice_id uuid, p_error text) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  update public.invoices
  set pdf_attempts = pdf_attempts + 1, pdf_last_error = left(coalesce(p_error, 'Unknown error'), 500), pdf_claimed_at = null
  where id = p_invoice_id and pdf_status = 'PENDING'
  returning pdf_attempts into v_attempts;
  return coalesce(v_attempts, 0);
end;
$$;

-- The daily job's list: pending and not claimed, fewest attempts first.
create function app.cron_pending_invoice_pdfs(p_now timestamptz, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(q.id), '[]'::jsonb)
  from (
    select i.id from public.invoices i
    where i.pdf_status = 'PENDING'
      and (i.pdf_claimed_at is null or i.pdf_claimed_at <= p_now - interval '5 minutes')
    order by i.pdf_attempts, i.pdf_requested_at nulls first, i.id
    limit greatest(p_limit, 0)
  ) q;
$$;

revoke all on function
  app.valid_logo_path(uuid, text),
  app.valid_letterhead_path(uuid, text),
  app.valid_letterhead_layout(jsonb),
  app.save_invoice_template(uuid, jsonb),
  app.invoice_pdf_flag(),
  app.claim_invoice_pdf(uuid, timestamptz),
  app.record_invoice_pdf(uuid, integer, integer, text, text, integer, text, jsonb),
  app.mark_invoice_pdf_failed(uuid, text),
  app.cron_pending_invoice_pdfs(timestamptz, integer)
from public, anon, authenticated;
grant execute on function
  app.save_invoice_template(uuid, jsonb),
  app.claim_invoice_pdf(uuid, timestamptz),
  app.record_invoice_pdf(uuid, integer, integer, text, text, integer, text, jsonb),
  app.mark_invoice_pdf_failed(uuid, text),
  app.cron_pending_invoice_pdfs(timestamptz, integer)
to service_role;

-- -----------------------------------------------------------------------------
-- public.rpc_* wrappers (service_role only).
-- -----------------------------------------------------------------------------
create function public.rpc_save_invoice_template(p_owner_id uuid, p_template jsonb) returns jsonb
language sql set search_path = '' as $$
  select app.save_invoice_template(p_owner_id, p_template);
$$;

create function public.rpc_claim_invoice_pdf(p_invoice_id uuid, p_now timestamptz) returns jsonb
language sql set search_path = '' as $$
  select app.claim_invoice_pdf(p_invoice_id, p_now);
$$;

create function public.rpc_record_invoice_pdf(
  p_invoice_id uuid, p_revision integer, p_version integer, p_path text, p_hash text,
  p_size integer, p_template text, p_parties jsonb
) returns jsonb
language sql set search_path = '' as $$
  select app.record_invoice_pdf(p_invoice_id, p_revision, p_version, p_path, p_hash, p_size, p_template, p_parties);
$$;

create function public.rpc_mark_invoice_pdf_failed(p_invoice_id uuid, p_error text) returns integer
language sql set search_path = '' as $$
  select app.mark_invoice_pdf_failed(p_invoice_id, p_error);
$$;

create function public.rpc_cron_pending_invoice_pdfs(p_now timestamptz, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_pending_invoice_pdfs(p_now, p_limit);
$$;

revoke all on function
  public.rpc_save_invoice_template(uuid, jsonb),
  public.rpc_claim_invoice_pdf(uuid, timestamptz),
  public.rpc_record_invoice_pdf(uuid, integer, integer, text, text, integer, text, jsonb),
  public.rpc_mark_invoice_pdf_failed(uuid, text),
  public.rpc_cron_pending_invoice_pdfs(timestamptz, integer)
from public, anon, authenticated;

grant execute on function
  public.rpc_save_invoice_template(uuid, jsonb),
  public.rpc_claim_invoice_pdf(uuid, timestamptz),
  public.rpc_record_invoice_pdf(uuid, integer, integer, text, text, integer, text, jsonb),
  public.rpc_mark_invoice_pdf_failed(uuid, text),
  public.rpc_cron_pending_invoice_pdfs(timestamptz, integer)
to service_role;
