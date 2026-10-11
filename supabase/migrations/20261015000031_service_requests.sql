-- =============================================================================
-- 0031 Service requests end to end (spec 4.9, 7; SRV-01..09, CP-07, MAC-05;
-- decisions 57-64).
--
-- A. Columns: photo, cancel reason, reopen count, rating time, escalation time,
--    the charge for the next bill; credits.service_request_id (the discount).
-- B. Status trail: kind + metadata; the trigger records the actor and a note.
-- C. Storage: service-photos (customer's own folder; owner reads sent photos only).
-- D. Workflow: raise (idempotent, key checked under a lock), one action function
--    for the owner's and the customer's steps, rating, escalation (daily job).
-- E. Service charges on the next normal invoice, checked at commit.
-- F. Grants and public.rpc_* wrappers (service role only).
-- =============================================================================

-- =============================================================================
-- A. Columns
-- =============================================================================
alter table public.service_requests
  add column photo_path text,
  add column photo_mime text check (photo_mime in ('image/jpeg', 'image/png')),
  add column photo_size integer check (photo_size between 1 and 5242880),
  add column photo_sha256 text check (photo_sha256 ~ '^[0-9a-f]{64}$'),
  add column cancel_reason text check (length(cancel_reason) <= 1000),
  add column cancelled_by uuid references public.profiles (id),
  add column closed_by uuid references public.profiles (id),
  add column reopen_count smallint not null default 0 check (reopen_count >= 0),
  add column rated_at timestamptz,
  add column escalated_at timestamptz,
  add column charge_cents bigint check (charge_cents > 0),
  add column charge_description text check (length(btrim(charge_description)) between 1 and 200),
  add column charged_by uuid references public.profiles (id),
  add column charged_at timestamptz,
  add constraint service_requests_photo_whole check (
    (photo_path is null) = (photo_mime is null) and (photo_path is null) = (photo_size is null)
    and (photo_path is null) = (photo_sha256 is null)),
  add constraint service_requests_charge_whole check (
    (charge_cents is null) = (charge_description is null) and (charge_cents is null) = (charged_at is null)),
  add constraint service_requests_charge_needs_agreement check (charge_cents is null or agreement_id is not null),
  add constraint service_requests_rating_comment check (rating_comment is null or length(rating_comment) <= 500),
  add constraint service_requests_rating_whole check ((rating is null) = (rated_at is null));

comment on column public.service_requests.charge_cents is
  'Decision 59: charged to the customer as an ADJUSTMENT line on the agreement''s next normal invoice (invoices.calculation.service_charges).';
create index service_requests_owner_created_idx on public.service_requests (owner_id, created_at desc);
create index service_requests_charges_idx on public.service_requests (agreement_id) where charge_cents is not null;
create index service_requests_cancelled_by_idx on public.service_requests (cancelled_by);
create index service_requests_closed_by_idx on public.service_requests (closed_by);
create index service_requests_charged_by_idx on public.service_requests (charged_by);

-- The owner's own cost (SRV-07) is their business, not the customer's: clients read every
-- column but cost_cents (and the idempotency key); the owner's pages read it on the server.
revoke select on public.service_requests from authenticated;
grant select (
  id, owner_id, customer_id, machine_id, agreement_id, type, description, urgency, status, toner_colours, part_name,
  preferred_date, assigned_to_name, planned_date, work_done, parts_used, rating, rating_comment, escalation_level,
  created_by, acknowledged_at, resolved_at, closed_at, cancelled_at, created_at, updated_at,
  photo_path, photo_mime, photo_size, photo_sha256, cancel_reason, cancelled_by, closed_by, reopen_count, rated_at,
  escalated_at, charge_cents, charge_description, charged_by, charged_at
) on public.service_requests to authenticated;

-- The goodwill discount on a breakdown (decision 60) is a customer credit linked to its request.
alter table public.credits
  add column service_request_id uuid,
  add constraint credits_service_request_fkey foreign key (service_request_id, owner_id)
    references public.service_requests (id, owner_id);
create unique index credits_service_request_idx on public.credits (service_request_id) where service_request_id is not null;

-- =============================================================================
-- B. Status trail
-- =============================================================================
alter table public.service_request_history
  add column kind text not null default 'STATUS'
    check (kind in ('STATUS', 'NOTE', 'ASSIGNMENT', 'ESCALATION', 'RATING', 'CHARGE')),
  add column metadata jsonb not null default '{}'::jsonb;

-- Every status change writes a row in the same transaction (unchanged). The workflow
-- functions set `app.status_note` / `app.status_meta` for it; the actor is the
-- function's (app.actor_id), as these tables are written by server code only.
create or replace function app.record_service_request_status() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.service_request_history (owner_id, request_id, from_status, to_status, note, changed_by, kind, metadata)
    values (
      new.owner_id,
      new.id,
      case when tg_op = 'UPDATE' then old.status end,
      new.status,
      nullif(current_setting('app.status_note', true), ''),
      coalesce(app.resolve_actor(), nullif(current_setting('app.actor_id', true), '')::uuid),
      'STATUS',
      coalesce(nullif(current_setting('app.status_meta', true), '')::jsonb, '{}'::jsonb)
    );
  end if;
  return null;
end;
$$;

-- =============================================================================
-- C. Storage: the optional photo of the problem (camera or gallery, decision 58)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('service-photos', 'service-photos', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "service-photos: customer uploads to own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'service-photos'
  and (select app.current_user_role()) = 'CUSTOMER'
  and array_length(storage.foldername(objects.name), 1) = 2
  and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
  and (storage.foldername(objects.name))[2] = (select app.current_customer_id())::text
);

create policy "service-photos: read sent photos"
on storage.objects for select to authenticated
using (
  bucket_id = 'service-photos'
  and (
    ((select app.is_admin()) and exists (select 1 from public.service_requests r where r.photo_path = objects.name))
    or ((select app.current_user_role()) = 'OWNER'
        and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
        and exists (select 1 from public.service_requests r where r.photo_path = objects.name))
    or ((select app.current_user_role()) = 'CUSTOMER'
        and (storage.foldername(objects.name))[2] = (select app.current_customer_id())::text)
  )
);

-- Photos uploaded but never sent with a request, older than 2 days.
create function app.cron_orphan_service_photos(p_now timestamptz, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(o.name order by o.created_at), '[]'::jsonb)
  from (
    select so.name, so.created_at
    from storage.objects so
    where so.bucket_id = 'service-photos'
      and so.created_at < p_now - interval '2 days'
      and not exists (select 1 from public.service_requests r where r.photo_path = so.name)
    order by so.created_at
    limit p_limit
  ) o;
$$;

-- =============================================================================
-- D. Workflow
-- =============================================================================

-- SRV-03 (spec 7.2): New → Acknowledged → Assigned → In progress → Resolved → Closed,
-- Cancelled from any open status; "still not fixed" takes a resolved request back to
-- In progress (decision 57). Mirrors src/lib/service/states.ts.
create function app.service_transition_allowed(p_from public.service_request_status, p_to public.service_request_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'NEW'          then p_to in ('ACKNOWLEDGED', 'CANCELLED')
    when 'ACKNOWLEDGED' then p_to in ('ASSIGNED', 'CANCELLED')
    when 'ASSIGNED'     then p_to in ('IN_PROGRESS', 'CANCELLED')
    when 'IN_PROGRESS'  then p_to in ('RESOLVED', 'CANCELLED')
    when 'RESOLVED'     then p_to in ('CLOSED', 'IN_PROGRESS', 'CANCELLED')
    else false
  end;
$$;

create function app.lock_service_request(p_request_id uuid) returns public.service_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.service_requests;
begin
  select * into r from public.service_requests where id = p_request_id for update;
  if not found then
    perform app.fail('RD404', 'Service request not found');
  end if;
  return r;
end;
$$;

-- A trail row that is not a status change (note, assignment, escalation, rating, charge).
create function app.service_history(
  r public.service_requests,
  p_kind text,
  p_note text,
  p_actor_id uuid,
  p_metadata jsonb
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.service_request_history (owner_id, request_id, from_status, to_status, note, changed_by, kind, metadata)
  values (r.owner_id, r.id, r.status, r.status, nullif(btrim(p_note), ''), p_actor_id, p_kind, coalesce(p_metadata, '{}'::jsonb));
$$;

-- Moves a locked request to a new status; the trigger writes the trail row with this note.
create function app.service_set_status(
  p_request_id uuid,
  p_to public.service_request_status,
  p_note text,
  p_metadata jsonb
) returns public.service_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.service_requests;
begin
  perform set_config('app.status_note', coalesce(btrim(p_note), ''), true);
  perform set_config('app.status_meta', coalesce(p_metadata, '{}'::jsonb)::text, true);
  update public.service_requests set status = p_to where id = p_request_id returning * into r;
  perform set_config('app.status_note', '', true);
  perform set_config('app.status_meta', '', true);
  return r;
end;
$$;

-- -----------------------------------------------------------------------------
-- SRV-01, SRV-02, SRV-06, CP-07: the customer raises a request for a machine they rent.
-- p_input: { type, description, urgency, toner_colours[], part_name, preferred_date }
-- p_photo: { storage_path, sha256, mime_type, size_bytes } or null.
-- Idempotent: the key is checked under an advisory lock, so an overlapping retry waits
-- for the first request and returns it (as 0029).
-- -----------------------------------------------------------------------------
create function app.raise_service_request(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_machine_id uuid,
  p_input jsonb,
  p_photo jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.service_requests;
  v_owner_id uuid;
  v_agreement public.rental_agreements;
  v_machine_type public.machine_type;
  v_type text := p_input ->> 'type';
  v_urgency text := coalesce(p_input ->> 'urgency', 'NORMAL');
  v_description text := btrim(coalesce(p_input ->> 'description', ''));
  v_part text := nullif(btrim(coalesce(p_input ->> 'part_name', '')), '');
  v_preferred date;
  v_today date := app.colombo_date(now());
  v_colours text[];
  v_path text := nullif(btrim(p_photo ->> 'storage_path'), '');
  v_id uuid;
begin
  perform app.set_actor(p_actor_id);
  if p_idempotency_key is null then
    perform app.fail('RD400', 'An idempotency key is required');
  end if;
  perform pg_advisory_xact_lock(hashtext('rentdesk.service.raise.' || p_idempotency_key::text));
  select * into r from public.service_requests where idempotency_key = p_idempotency_key;
  if found then
    if r.created_by is distinct from p_actor_id then
      perform app.fail('RD409', 'Idempotency key already used');
    end if;
    return jsonb_build_object('request_id', r.id, 'status', r.status, 'replayed', true);
  end if;

  select p.owner_id into v_owner_id from public.profiles p where p.id = p_actor_id;
  perform app.assert_actor(p_actor_id, v_owner_id, p_actor_id, array['CUSTOMER']::public.user_role[]);

  select a.* into v_agreement from public.rental_agreements a
  where a.machine_id = p_machine_id and a.customer_id = p_actor_id and a.status <> 'TERMINATED'
  order by a.created_at desc limit 1;
  if not found then
    perform app.fail('RD404', 'MACHINE_NOT_RENTED: This machine is not rented to you.');
  end if;
  select m.type into v_machine_type from public.machines m where m.id = p_machine_id;

  if v_type is null or v_type not in ('BREAKDOWN', 'TONER', 'SPARE_PART', 'MAINTENANCE', 'OTHER') then
    perform app.fail('RD400', 'Choose what you need');
  end if;
  if v_urgency not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    perform app.fail('RD400', 'Choose how urgent it is');
  end if;
  if length(v_description) = 0 or length(v_description) > 1000 then
    perform app.fail('RD400', 'A description (up to 1,000 characters) is required');
  end if;
  if v_part is not null and (v_type <> 'SPARE_PART' or length(v_part) > 100) then
    perform app.fail('RD400', 'A part name (up to 100 characters) is only for spare part requests');
  end if;
  if nullif(p_input ->> 'preferred_date', '') is not null then
    v_preferred := (p_input ->> 'preferred_date')::date;
    if v_preferred < v_today or v_preferred > v_today + 365 then
      perform app.fail('RD400', 'The preferred date must be from today, within a year');
    end if;
  end if;

  -- SRV-06: toner colours. A mono machine takes black only (set here); a colour machine
  -- names at least one of its four colours.
  select coalesce(array_agg(distinct x order by x), '{}') into v_colours
  from jsonb_array_elements_text(coalesce(p_input -> 'toner_colours', '[]'::jsonb)) x;
  if exists (select 1 from unnest(v_colours) c where c not in ('BLACK', 'CYAN', 'MAGENTA', 'YELLOW')) then
    perform app.fail('RD400', 'Unknown toner colour');
  end if;
  if v_type = 'TONER' then
    if v_machine_type = 'MONO' then
      if v_colours <> '{}' and v_colours <> array['BLACK'] then
        perform app.fail('RD400', 'A mono machine uses black toner only');
      end if;
      v_colours := array['BLACK'];
    elsif cardinality(v_colours) = 0 then
      perform app.fail('RD400', 'Choose the toner colour(s) you need');
    end if;
  elsif cardinality(v_colours) > 0 then
    perform app.fail('RD400', 'Toner colours are only for toner requests');
  end if;

  if v_path is not null and (
       v_path !~ ('^' || v_owner_id::text || '/' || p_actor_id::text || '/[0-9a-f-]{36}\.(jpg|png)$')
       or coalesce(p_photo ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       or coalesce(p_photo ->> 'mime_type', '') not in ('image/jpeg', 'image/png')
       or coalesce((p_photo ->> 'size_bytes')::integer, 0) not between 1 and 5242880) then
    perform app.fail('RD400', 'The photo is not valid');
  end if;

  if (select count(*) from public.service_requests x
      where x.customer_id = p_actor_id and x.created_at > now() - interval '1 hour') >= 10 then
    perform app.fail('RD409', 'TOO_MANY_REQUESTS: Too many requests in the last hour. Please call your rental company.');
  end if;

  insert into public.service_requests (
    owner_id, customer_id, machine_id, agreement_id, type, description, urgency, toner_colours, part_name,
    preferred_date, idempotency_key, created_by, photo_path, photo_mime, photo_size, photo_sha256
  ) values (
    v_owner_id, p_actor_id, p_machine_id, v_agreement.id, v_type::public.service_request_type, v_description,
    v_urgency::public.urgency, v_colours::public.toner_colour[], v_part, v_preferred, p_idempotency_key, p_actor_id,
    v_path,
    case when v_path is not null then p_photo ->> 'mime_type' end,
    case when v_path is not null then (p_photo ->> 'size_bytes')::integer end,
    case when v_path is not null then p_photo ->> 'sha256' end
  )
  returning id into v_id;

  perform app.write_audit(p_actor_id, 'SERVICE_REQUEST_RAISED', 'service_request', v_id, v_owner_id,
                          jsonb_build_object('machine_id', p_machine_id, 'type', v_type, 'urgency', v_urgency,
                                             'toner_colours', to_jsonb(v_colours), 'photo', v_path is not null));
  perform app.enqueue_notifications(v_owner_id, p_notifications, 'service_request', v_id);
  return jsonb_build_object('request_id', v_id, 'status', 'NEW', 'replayed', false);
end;
$$;

-- Decision 59: a charge is billed while a live (not rejected or cancelled) invoice of
-- the agreement lists it in calculation.service_charges.
create function app.service_charge_invoice(p_request_id uuid) returns public.invoices
language sql
stable
security definer
set search_path = ''
as $$
  select i.* from public.invoices i
  join public.service_requests r on r.agreement_id = i.agreement_id
  where r.id = p_request_id
    and i.status not in ('REJECTED', 'CANCELLED')
    and coalesce(i.calculation -> 'service_charges', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', p_request_id::text))
  order by i.created_at desc
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- SRV-03..05, SRV-07 (spec 7.2): every step of a request, by its owner or customer.
--   ACKNOWLEDGE  owner     New → Acknowledged
--   ASSIGN       owner     Acknowledged → Assigned (technician, planned date); while
--                          Assigned or In progress: changes them (trail row, no status)
--   START        owner     Assigned → In progress
--   RESOLVE      owner     In progress → Resolved: work done, parts used, cost; optional
--                          charge (next bill) and, for a breakdown, a discount (credit)
--   CLOSE        owner     Resolved → Closed
--   CONFIRM      customer  Resolved → Closed ("it is fixed")
--   REOPEN       customer  Resolved → In progress ("still not fixed", reason)
--   CANCEL       customer while New; owner from any open status (reason)
--   NOTE         owner     a note on an open request
-- p_input: { note, reason, technician, planned_date, work_done, parts_used, cost_cents,
--            charge: { amount_cents, description }, discount: { amount_cents, description } }
-- -----------------------------------------------------------------------------
create function app.service_request_action(
  p_request_id uuid,
  p_actor_id uuid,
  p_action text,
  p_input jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.service_requests;
  v_role public.user_role;
  v_to public.service_request_status;
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_note text := nullif(btrim(coalesce(v_input ->> 'note', '')), '');
  v_reason text := nullif(btrim(coalesce(v_input ->> 'reason', '')), '');
  v_today date := app.colombo_date(now());
  v_tech text := nullif(btrim(coalesce(v_input ->> 'technician', '')), '');
  v_planned date;
  v_work text := nullif(btrim(coalesce(v_input ->> 'work_done', '')), '');
  v_parts text := nullif(btrim(coalesce(v_input ->> 'parts_used', '')), '');
  v_cost bigint := (v_input ->> 'cost_cents')::bigint;
  v_charge jsonb := nullif(v_input -> 'charge', 'null'::jsonb);
  v_discount jsonb := nullif(v_input -> 'discount', 'null'::jsonb);
  v_meta jsonb := '{}'::jsonb;
  v_billed public.invoices;
  v_credit_id uuid;
  v_status_note text;
begin
  perform app.set_actor(p_actor_id);
  r := app.lock_service_request(p_request_id);
  v_role := app.assert_actor(p_actor_id, r.owner_id, r.customer_id, array['OWNER', 'CUSTOMER']::public.user_role[]);
  if length(v_note) > 1000 or length(v_reason) > 1000 then
    perform app.fail('RD400', 'A note or reason has at most 1,000 characters');
  end if;
  if p_action in ('ACKNOWLEDGE', 'ASSIGN', 'START', 'RESOLVE', 'CLOSE', 'NOTE') and v_role <> 'OWNER' then
    perform app.fail('RD403', 'Only the rental company can do this');
  end if;
  if p_action in ('CONFIRM', 'REOPEN') and v_role <> 'CUSTOMER' then
    perform app.fail('RD403', 'Only the customer can do this');
  end if;

  v_to := case p_action
    when 'ACKNOWLEDGE' then 'ACKNOWLEDGED'
    when 'ASSIGN' then case when r.status in ('ASSIGNED', 'IN_PROGRESS') then null else 'ASSIGNED' end
    when 'START' then 'IN_PROGRESS'
    when 'RESOLVE' then 'RESOLVED'
    when 'CLOSE' then 'CLOSED'
    when 'CONFIRM' then 'CLOSED'
    when 'REOPEN' then 'IN_PROGRESS'
    when 'CANCEL' then 'CANCELLED'
    when 'NOTE' then null
  end::public.service_request_status;
  if p_action not in ('ACKNOWLEDGE', 'ASSIGN', 'START', 'RESOLVE', 'CLOSE', 'CONFIRM', 'REOPEN', 'CANCEL', 'NOTE') then
    perform app.fail('RD400', 'Unknown action');
  end if;
  if v_to is not null and not app.service_transition_allowed(r.status, v_to) then
    perform app.fail('RD409', format('This request is %s, so it cannot be changed this way. Reload the page.',
                                     lower(replace(r.status::text, '_', ' '))));
  end if;
  if p_action = 'NOTE' and r.status in ('CLOSED', 'CANCELLED') then
    perform app.fail('RD409', 'This request is finished; notes are closed.');
  end if;

  case p_action
    when 'ACKNOWLEDGE' then
      update public.service_requests set acknowledged_at = now() where id = r.id;
      v_status_note := v_note;

    when 'ASSIGN' then
      if v_tech is null or length(v_tech) > 100 then
        perform app.fail('RD400', 'Name the technician or staff member (up to 100 characters)');
      end if;
      if nullif(v_input ->> 'planned_date', '') is not null then
        v_planned := (v_input ->> 'planned_date')::date;
        if v_planned < v_today or v_planned > v_today + 365 then
          perform app.fail('RD400', 'The planned visit must be from today, within a year');
        end if;
      end if;
      v_meta := jsonb_build_object('technician', v_tech, 'planned_date', v_planned,
                                   'previous_technician', r.assigned_to_name, 'previous_planned_date', r.planned_date);
      update public.service_requests set assigned_to_name = v_tech, planned_date = v_planned where id = r.id;
      if v_to is null then
        if v_tech = r.assigned_to_name and v_planned is not distinct from r.planned_date and v_note is null then
          perform app.fail('RD400', 'Nothing was changed');
        end if;
        select * into r from public.service_requests where id = r.id;
        perform app.service_history(r, 'ASSIGNMENT', v_note, p_actor_id, v_meta);
      end if;
      v_status_note := v_note;

    when 'START' then
      v_status_note := v_note;

    when 'RESOLVE' then
      if v_work is null or length(v_work) > 1000 then
        perform app.fail('RD400', 'Describe the work done (up to 1,000 characters)');
      end if;
      if length(v_parts) > 500 then
        perform app.fail('RD400', 'Parts used: at most 500 characters');
      end if;
      if v_cost is not null and v_cost < 0 then
        perform app.fail('RD400', 'The cost cannot be negative');
      end if;
      update public.service_requests
      set work_done = v_work, parts_used = v_parts, cost_cents = v_cost, resolved_at = now()
      where id = r.id;
      -- The cost stays out of the trail (the customer reads it); the audit entry keeps it.
      v_meta := jsonb_build_object('work_done', v_work, 'parts_used', v_parts);

      -- Decision 59: the charge waits for the agreement's next normal invoice.
      if v_charge is not null then
        if r.charge_cents is not null then
          perform app.fail('RD409', 'CHARGE_EXISTS: This request already has a charge.');
        end if;
        if r.agreement_id is null or not exists (
             select 1 from public.rental_agreements a where a.id = r.agreement_id and a.status <> 'TERMINATED') then
          perform app.fail('RD409', 'AGREEMENT_ENDED: The machine was returned, so there is no next bill to add the charge to.');
        end if;
        if coalesce((v_charge ->> 'amount_cents')::bigint, 0) <= 0
           or coalesce(btrim(v_charge ->> 'description'), '') = '' or length(btrim(v_charge ->> 'description')) > 200 then
          perform app.fail('RD400', 'A charge needs an amount above zero and a description (up to 200 characters)');
        end if;
        update public.service_requests
        set charge_cents = (v_charge ->> 'amount_cents')::bigint, charge_description = btrim(v_charge ->> 'description'),
            charged_by = p_actor_id, charged_at = clock_timestamp()
        where id = r.id;
        v_meta := v_meta || jsonb_build_object('charge_cents', (v_charge ->> 'amount_cents')::bigint,
                                               'charge_description', btrim(v_charge ->> 'description'));
      end if;

      -- Decision 60: a goodwill discount on a breakdown is a customer credit (rule 13).
      if v_discount is not null then
        if r.type <> 'BREAKDOWN' then
          perform app.fail('RD400', 'A discount is for breakdowns only');
        end if;
        if exists (select 1 from public.credits c where c.service_request_id = r.id) then
          perform app.fail('RD409', 'DISCOUNT_EXISTS: This request already has a discount.');
        end if;
        if coalesce((v_discount ->> 'amount_cents')::bigint, 0) <= 0
           or coalesce(btrim(v_discount ->> 'description'), '') = '' or length(btrim(v_discount ->> 'description')) > 200 then
          perform app.fail('RD400', 'A discount needs an amount above zero and a reason (up to 200 characters)');
        end if;
        -- clock_timestamp(): newest of the customer's credits (rule 13 order).
        insert into public.credits (owner_id, customer_id, kind, amount_cents, reason, created_by, created_at, service_request_id)
        values (r.owner_id, r.customer_id, 'SERVICE_DISCOUNT', (v_discount ->> 'amount_cents')::bigint,
                format('Service discount: %s', btrim(v_discount ->> 'description')), p_actor_id, clock_timestamp(), r.id)
        returning id into v_credit_id;
        v_meta := v_meta || jsonb_build_object('discount_cents', (v_discount ->> 'amount_cents')::bigint,
                                               'discount_description', btrim(v_discount ->> 'description'),
                                               'credit_id', v_credit_id);
      end if;
      v_status_note := v_note;

    when 'CLOSE' then
      update public.service_requests set closed_at = now(), closed_by = p_actor_id where id = r.id;
      v_status_note := v_note;

    when 'CONFIRM' then
      update public.service_requests set closed_at = now(), closed_by = p_actor_id where id = r.id;
      v_status_note := v_note;
      v_meta := jsonb_build_object('confirmed_by_customer', true);

    when 'REOPEN' then
      if v_reason is null then
        perform app.fail('RD400', 'Tell your rental company what is still wrong');
      end if;
      update public.service_requests set reopen_count = reopen_count + 1, resolved_at = null where id = r.id;
      v_status_note := v_reason;
      v_meta := jsonb_build_object('reopen_no', r.reopen_count + 1);

    when 'CANCEL' then
      if v_reason is null then
        perform app.fail('RD400', 'A reason is required to cancel');
      end if;
      if v_role = 'CUSTOMER' and r.status <> 'NEW' then
        perform app.fail('RD409', 'NOT_NEW: Your rental company is already working on this request. Ask them to cancel it.');
      end if;
      -- A charge already on a bill stays there (correct the bill instead); one still waiting is dropped.
      if r.charge_cents is not null then
        v_billed := app.service_charge_invoice(r.id);
        if v_billed.id is not null then
          perform app.fail('RD409', format('CHARGE_BILLED: The charge is on bill %s. Correct that bill instead.',
                                           coalesce(v_billed.invoice_no, 'waiting for review')));
        end if;
        perform app.service_history(r, 'CHARGE', 'Charge removed: request cancelled', p_actor_id,
                                    jsonb_build_object('removed_cents', r.charge_cents, 'description', r.charge_description));
        update public.service_requests
        set charge_cents = null, charge_description = null, charged_by = null, charged_at = null
        where id = r.id;
      end if;
      update public.service_requests set cancelled_at = now(), cancelled_by = p_actor_id, cancel_reason = v_reason where id = r.id;
      v_status_note := v_reason;
      v_meta := jsonb_build_object('by', v_role);

    when 'NOTE' then
      if v_note is null then
        perform app.fail('RD400', 'Write the note');
      end if;
      perform app.service_history(r, 'NOTE', v_note, p_actor_id, '{}'::jsonb);
  end case;

  if v_to is not null then
    r := app.service_set_status(r.id, v_to, v_status_note, v_meta);
  else
    select * into r from public.service_requests where id = r.id;
  end if;

  perform app.write_audit(p_actor_id, 'SERVICE_REQUEST_' || p_action, 'service_request', r.id, r.owner_id,
                          v_meta || jsonb_build_object('status', r.status)
                                 || case when p_action = 'RESOLVE' then jsonb_build_object('cost_cents', v_cost) else '{}'::jsonb end
                                 || case when v_note is not null then jsonb_build_object('note', v_note) else '{}'::jsonb end
                                 || case when v_reason is not null then jsonb_build_object('reason', v_reason) else '{}'::jsonb end);
  perform app.enqueue_notifications(r.owner_id, p_notifications, 'service_request', r.id);
  return jsonb_build_object('request_id', r.id, 'status', r.status, 'credit_id', v_credit_id);
end;
$$;

-- SRV-09: the customer rates a closed request once (1-5 stars, optional comment).
create function app.rate_service_request(
  p_request_id uuid,
  p_actor_id uuid,
  p_rating integer,
  p_comment text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.service_requests;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  perform app.set_actor(p_actor_id);
  r := app.lock_service_request(p_request_id);
  perform app.assert_actor(p_actor_id, r.owner_id, r.customer_id, array['CUSTOMER']::public.user_role[]);
  if r.status <> 'CLOSED' then
    perform app.fail('RD409', 'NOT_CLOSED: You can rate the service once the request is closed.');
  end if;
  if r.rating is not null then
    perform app.fail('RD409', 'ALREADY_RATED: You already rated this service. Thank you!');
  end if;
  if p_rating is null or p_rating not between 1 and 5 then
    perform app.fail('RD400', 'Choose 1 to 5 stars');
  end if;
  if length(v_comment) > 500 then
    perform app.fail('RD400', 'A comment has at most 500 characters');
  end if;
  update public.service_requests set rating = p_rating, rating_comment = v_comment, rated_at = now()
  where id = r.id returning * into r;
  perform app.service_history(r, 'RATING', v_comment, p_actor_id, jsonb_build_object('rating', p_rating));
  perform app.write_audit(p_actor_id, 'SERVICE_REQUEST_RATED', 'service_request', r.id, r.owner_id,
                          jsonb_build_object('rating', p_rating, 'comment', v_comment));
  perform app.enqueue_notifications(r.owner_id, p_notifications, 'service_request', r.id);
  return jsonb_build_object('request_id', r.id, 'rating', p_rating);
end;
$$;

-- -----------------------------------------------------------------------------
-- SRV-08 (spec 7.3; decision 61): the daily job escalates a request still New
-- after the acknowledgement time: level 1 re-notifies the owner, level 2 alerts the
-- admins. Compare-and-set: a request acknowledged meanwhile, or already at the level,
-- is skipped.
-- -----------------------------------------------------------------------------
create function app.escalate_service_request(
  p_request_id uuid,
  p_level smallint,
  p_now timestamptz,
  p_reason text,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.service_requests;
begin
  perform app.set_actor(null);
  if p_level not in (1, 2) then
    perform app.fail('RD400', 'Escalation level is 1 (owner) or 2 (admin)');
  end if;
  r := app.lock_service_request(p_request_id);
  if r.status <> 'NEW' or r.escalation_level >= p_level then
    return jsonb_build_object('skipped', true, 'status', r.status, 'escalation_level', r.escalation_level);
  end if;
  update public.service_requests set escalation_level = p_level, escalated_at = p_now where id = r.id returning * into r;
  perform app.service_history(r, 'ESCALATION', p_reason, null, jsonb_build_object('level', p_level));
  perform app.write_audit(null, 'SERVICE_REQUEST_ESCALATED', 'service_request', r.id, r.owner_id,
                          jsonb_build_object('level', p_level, 'reason', p_reason));
  perform app.enqueue_notifications(r.owner_id, p_notifications, 'service_request', r.id);
  return jsonb_build_object('request_id', r.id, 'escalation_level', p_level);
end;
$$;

-- Requests the daily job may escalate: still New, not yet at the admin level, customer
-- and owner active (a suspended account's requests wait, as rule 24). Keyset pages by id.
create function app.cron_service_candidates(p_after uuid, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x ->> 'id'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', r.id, 'owner_id', r.owner_id, 'customer_id', r.customer_id, 'created_at', r.created_at,
      'type', r.type, 'urgency', r.urgency, 'escalation_level', r.escalation_level,
      'customer_name', c.name, 'machine_name', m.brand || ' ' || m.model, 'serial_no', m.serial_no,
      'settings', jsonb_build_object(
        'service_ack_hours_urgent', s.service_ack_hours_urgent,
        'service_ack_hours_normal', s.service_ack_hours_normal,
        'service_admin_escalation_hours_urgent', s.service_admin_escalation_hours_urgent,
        'service_admin_escalation_hours_normal', s.service_admin_escalation_hours_normal)
    ) as x
    from public.service_requests r
    join public.customers c on c.id = r.customer_id
    join public.machines m on m.id = r.machine_id
    join public.profiles pc on pc.id = r.customer_id
    join public.profiles po on po.id = r.owner_id
    join public.owner_settings_effective s on s.owner_id = r.owner_id
    where r.status = 'NEW'
      and r.escalation_level < 2
      and pc.status = 'ACTIVE' and po.status = 'ACTIVE'
      and (p_after is null or r.id > p_after)
    order by r.id
    limit p_limit
  ) q;
$$;

-- =============================================================================
-- E. Service charges on the next normal invoice (decision 59)
-- =============================================================================

-- The agreement's charges not on a live invoice other than p_exclude_invoice, oldest
-- first. Same as loadServiceCharges (src/lib/billing/context.ts).
create function app.service_charges_free(p_agreement_id uuid, p_exclude_invoice uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id::text, 'description', r.charge_description,
                                               'amount_cents', r.charge_cents) order by r.charged_at, r.id), '[]'::jsonb)
  from public.service_requests r
  where r.agreement_id = p_agreement_id
    and r.charge_cents is not null
    and not exists (
      select 1 from public.invoices i
      where i.agreement_id = p_agreement_id
        and i.id is distinct from p_exclude_invoice
        and i.status not in ('REJECTED', 'CANCELLED')
        and coalesce(i.calculation -> 'service_charges', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', r.id::text))
    );
$$;

-- A list of charges as a comparable set: id, description, amount.
create function app.service_charge_set(p_list jsonb) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x ->> 'id', 'description', x ->> 'description',
                                               'amount_cents', (x ->> 'amount_cents')::bigint) order by x ->> 'id'), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_list) = 'array' then p_list else '[]'::jsonb end) x;
$$;

-- Checked when the transaction commits (the lines are written after the invoice row):
--   a new normal invoice lists exactly the agreement's free charges; a corrected one
--   (replaces_invoice_id) carries the charges of the bill it replaces; a recalculated
--   draft keeps the ones it had. Each listed charge has its ADJUSTMENT line, and no
--   charge is on two live invoices. Estimates never carry charges (the next reading
--   credits an estimate in full).
create function app.check_invoice_service_charges() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  v_listed jsonb;
  v_expected jsonb;
begin
  select * into inv from public.invoices where id = new.id;
  if not found or inv.status in ('REJECTED', 'CANCELLED') or inv.agreement_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.calculation is not distinct from new.calculation then
    return null;
  end if;
  v_listed := app.service_charge_set(inv.calculation -> 'service_charges');
  if inv.type <> 'NORMAL' then
    if v_listed <> '[]'::jsonb then
      perform app.fail('RD400', 'Service charges go on a normal invoice');
    end if;
    return null;
  end if;

  if tg_op = 'UPDATE' then
    v_expected := app.service_charge_set(old.calculation -> 'service_charges');
  elsif inv.replaces_invoice_id is not null then
    select app.service_charge_set(o.calculation -> 'service_charges') into v_expected
    from public.invoices o where o.id = inv.replaces_invoice_id;
  else
    v_expected := app.service_charge_set(app.service_charges_free(inv.agreement_id, inv.id));
  end if;
  if v_listed is distinct from v_expected then
    perform app.fail('RD409', 'SERVICE_CHARGES_CHANGED: The service charges to bill have changed; recalculate the invoice.');
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_listed) c
    where (select count(*) from public.invoice_lines l
           where l.invoice_id = inv.id and l.line_type = 'ADJUSTMENT'
             and l.amount_cents = (c ->> 'amount_cents')::bigint and l.description = c ->> 'description')
          < (select count(*) from jsonb_array_elements(v_listed) c2
             where c2 ->> 'description' = c ->> 'description' and c2 ->> 'amount_cents' = c ->> 'amount_cents')
  ) then
    perform app.fail('RD400', 'A service charge is missing its invoice line');
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_listed) c
    join public.invoices o on o.agreement_id = inv.agreement_id and o.id <> inv.id
    where o.status not in ('REJECTED', 'CANCELLED')
      and coalesce(o.calculation -> 'service_charges', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', c ->> 'id'))
  ) then
    perform app.fail('RD409', 'SERVICE_CHARGES_CHANGED: A service charge is already on another bill; recalculate the invoice.');
  end if;
  return null;
end;
$$;

create constraint trigger invoices_service_charges
  after insert or update on public.invoices
  deferrable initially deferred
  for each row execute function app.check_invoice_service_charges();

-- =============================================================================
-- F. Grants and public.rpc_* wrappers (service role only)
-- =============================================================================
revoke all on function
  app.cron_orphan_service_photos(timestamptz, integer),
  app.service_transition_allowed(public.service_request_status, public.service_request_status),
  app.lock_service_request(uuid),
  app.service_history(public.service_requests, text, text, uuid, jsonb),
  app.service_set_status(uuid, public.service_request_status, text, jsonb),
  app.raise_service_request(uuid, uuid, uuid, jsonb, jsonb, jsonb),
  app.service_charge_invoice(uuid),
  app.service_request_action(uuid, uuid, text, jsonb, jsonb),
  app.rate_service_request(uuid, uuid, integer, text, jsonb),
  app.escalate_service_request(uuid, smallint, timestamptz, text, jsonb),
  app.cron_service_candidates(uuid, integer),
  app.service_charges_free(uuid, uuid),
  app.service_charge_set(jsonb),
  app.check_invoice_service_charges()
from public, anon, authenticated;

grant execute on function
  app.cron_orphan_service_photos(timestamptz, integer),
  app.raise_service_request(uuid, uuid, uuid, jsonb, jsonb, jsonb),
  app.service_request_action(uuid, uuid, text, jsonb, jsonb),
  app.rate_service_request(uuid, uuid, integer, text, jsonb),
  app.escalate_service_request(uuid, smallint, timestamptz, text, jsonb),
  app.cron_service_candidates(uuid, integer),
  app.service_charges_free(uuid, uuid)
to service_role;

create function public.rpc_raise_service_request(
  p_actor_id uuid, p_idempotency_key uuid, p_machine_id uuid, p_input jsonb, p_photo jsonb default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.raise_service_request(p_actor_id, p_idempotency_key, p_machine_id, p_input, p_photo, p_notifications);
$$;

create function public.rpc_service_request_action(
  p_request_id uuid, p_actor_id uuid, p_action text, p_input jsonb default '{}'::jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.service_request_action(p_request_id, p_actor_id, p_action, p_input, p_notifications);
$$;

create function public.rpc_rate_service_request(
  p_request_id uuid, p_actor_id uuid, p_rating integer, p_comment text default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.rate_service_request(p_request_id, p_actor_id, p_rating, p_comment, p_notifications);
$$;

create function public.rpc_escalate_service_request(
  p_request_id uuid, p_level smallint, p_now timestamptz, p_reason text, p_notifications jsonb default '[]'::jsonb
) returns jsonb language sql set search_path = '' as $$
  select app.escalate_service_request(p_request_id, p_level, p_now, p_reason, p_notifications);
$$;

create function public.rpc_cron_service_candidates(p_after uuid, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_service_candidates(p_after, p_limit);
$$;

create function public.rpc_cron_orphan_service_photos(p_now timestamptz, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_orphan_service_photos(p_now, p_limit);
$$;

revoke execute on function
  public.rpc_raise_service_request(uuid, uuid, uuid, jsonb, jsonb, jsonb),
  public.rpc_service_request_action(uuid, uuid, text, jsonb, jsonb),
  public.rpc_rate_service_request(uuid, uuid, integer, text, jsonb),
  public.rpc_escalate_service_request(uuid, smallint, timestamptz, text, jsonb),
  public.rpc_cron_service_candidates(uuid, integer),
  public.rpc_cron_orphan_service_photos(timestamptz, integer)
from public, anon, authenticated;
grant execute on function
  public.rpc_raise_service_request(uuid, uuid, uuid, jsonb, jsonb, jsonb),
  public.rpc_service_request_action(uuid, uuid, text, jsonb, jsonb),
  public.rpc_rate_service_request(uuid, uuid, integer, text, jsonb),
  public.rpc_escalate_service_request(uuid, smallint, timestamptz, text, jsonb),
  public.rpc_cron_service_candidates(uuid, integer),
  public.rpc_cron_orphan_service_photos(timestamptz, integer)
to service_role;
