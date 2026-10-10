-- =============================================================================
-- 0023 Invoice PDF reason: issuing updates the invoice twice in one transaction
-- (assign_invoice_number, then status / due date / branding), so the second
-- update relabelled the first PDF "due date changed". A PDF still waiting for
-- its first version stays ISSUED whatever else changes before it is made.
-- =============================================================================

create or replace function app.invoice_pdf_flag() returns trigger
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
  new.pdf_pending_reason := case
    when tg_op = 'UPDATE' and old.pdf_status = 'PENDING' and old.pdf_pending_reason = 'ISSUED' then 'ISSUED'
    else v_reason
  end;
  new.pdf_requested_at := now();
  new.pdf_last_error := null;
  return new;
end;
$$;
