-- =============================================================================
-- 0029 Retries that overlap the first request (task 8 review).
--
-- raise_dispute and add_ticket_comment looked up the idempotency key before taking
-- the ticket lock. A retry sent while the first request was still running (a slow
-- database, a lost response, a second tap) missed the key, waited for the lock and
-- then failed: "Ticket is DISPUTED; this invoice cannot be disputed now", or a unique
-- violation for a comment. Never a duplicate, but the customer was told it failed.
-- Both now check the key under the lock, like submit_meter_reading: the retry waits
-- and returns the first result. Same signatures; the grants and wrappers stay.
-- =============================================================================

create or replace function app.raise_dispute(
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
  -- The key is checked under the ticket lock: a retry that overlaps the first request
  -- (lost response, tapped again) waits for it and then returns its dispute.
  t := app.lock_ticket(p_ticket_id);
  select * into d from public.disputes where idempotency_key = p_idempotency_key;
  if found then
    if d.ticket_id <> p_ticket_id then
      perform app.fail('RD409', 'Idempotency key already used for another ticket');
    end if;
    return jsonb_build_object('ticket_id', d.ticket_id, 'dispute_id', d.id, 'status', 'DISPUTED', 'replayed', true);
  end if;
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

create or replace function app.add_ticket_comment(
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
  -- Checked under the ticket lock, so an overlapping retry returns the first message.
  t := app.lock_ticket(p_ticket_id);
  select * into c from public.ticket_comments where idempotency_key = p_idempotency_key;
  if found then
    if c.ticket_id <> p_ticket_id or c.author_id is distinct from p_actor_id then
      perform app.fail('RD409', 'Idempotency key already used');
    end if;
    return jsonb_build_object('comment_id', c.id, 'replayed', true);
  end if;
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
