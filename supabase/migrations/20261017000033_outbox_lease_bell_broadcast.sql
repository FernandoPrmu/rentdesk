-- =============================================================================
-- 0033 A cheaper outbox (decision 67, revised in task 10 verification).
--
-- Before: every kick ran the quota counts and a claim (with an UPDATE) even when
-- nothing was waiting, and separate server instances could drain at the same time.
-- Now a sender first calls app.outbox_begin: one indexed, read-only check; only when
-- something is due does it take the single sender lease (one row update). A second
-- sender, anywhere, gets null and stops. app.outbox_end releases the lease; a sender
-- that dies loses it after the lease time.
-- =============================================================================

-- "Anything due?" in one index range scan.
create index notification_deliveries_next_idx on public.notification_deliveries (next_attempt_at)
  where status = 'PENDING';

create table public.outbox_lease (
  id boolean primary key default true check (id),
  holder uuid,
  locked_until timestamptz not null default '-infinity'
);
comment on table public.outbox_lease is 'The one email sender at a time (decision 67). SERVER-ONLY.';
insert into public.outbox_lease default values;
alter table public.outbox_lease enable row level security;
grant select, update on public.outbox_lease to service_role;

-- Returns the lease token, or null when nothing is due (no write at all) or another
-- sender holds the lease. Lease times use the database clock, so a simulated "now"
-- (daily job outside production) can never lock it into the future.
create function app.outbox_begin(p_now timestamptz, p_lease_seconds integer default 60) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid;
begin
  if not exists (
    select 1 from public.notification_deliveries d
    where d.status = 'PENDING' and d.next_attempt_at <= p_now
      and (d.claimed_until is null or d.claimed_until < p_now)
  ) then
    return null;
  end if;
  update public.outbox_lease
  set holder = gen_random_uuid(), locked_until = clock_timestamp() + make_interval(secs => greatest(p_lease_seconds, 5))
  where id and locked_until < clock_timestamp()
  returning holder into v_token;
  return v_token;
end;
$$;

create function app.outbox_end(p_token uuid) returns void
language sql
security definer
set search_path = ''
as $$
  update public.outbox_lease set holder = null, locked_until = '-infinity' where id and holder = p_token;
$$;

revoke all on function app.outbox_begin(timestamptz, integer), app.outbox_end(uuid) from public, anon, authenticated;
grant execute on function app.outbox_begin(timestamptz, integer), app.outbox_end(uuid) to service_role;

create function public.rpc_outbox_begin(p_now timestamptz, p_lease_seconds integer default 60) returns uuid
language sql set search_path = '' as $$ select app.outbox_begin(p_now, p_lease_seconds); $$;
create function public.rpc_outbox_end(p_token uuid) returns void
language sql set search_path = '' as $$ select app.outbox_end(p_token); $$;

revoke execute on function public.rpc_outbox_begin(timestamptz, integer), public.rpc_outbox_end(uuid) from public, anon, authenticated;
grant execute on function public.rpc_outbox_begin(timestamptz, integer), public.rpc_outbox_end(uuid) to service_role;

-- =============================================================================
-- The bell (NOT-01) on Realtime Broadcast instead of Postgres Changes.
--
-- Postgres Changes made Realtime decode the whole write-ahead log (every write of
-- every table) and check RLS per subscriber while any bell was open; on the free
-- tier that competed with the app for the database's CPU. Now a trigger sends a tiny
-- signal (no content) on the private topic "notifications:<user id>"; the browser
-- then counts its unread rows itself, through RLS. Only the user may join their topic.
-- =============================================================================
alter publication supabase_realtime drop table public.notifications;

-- One signal per user per statement (marking 30 rows read sends one, not 30).
create function app.bell_send(p_users uuid[], p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  foreach v_user in array coalesce(p_users, '{}') loop
    begin
      perform realtime.send(jsonb_build_object('kind', p_kind), 'changed', 'notifications:' || v_user::text, true);
    exception when others then
      -- A missed signal only delays the bell; never fail the change itself.
      raise warning 'bell signal: %', sqlerrm;
    end;
  end loop;
end;
$$;

create function app.bell_signal_insert() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.bell_send(array(select distinct n.user_id from new_rows n where n.channel = 'IN_APP'), 'insert');
  return null;
end;
$$;

create function app.bell_signal_update() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.bell_send(array(
    select distinct n.user_id from new_rows n join old_rows o on o.id = n.id
    where n.channel = 'IN_APP' and o.read_at is distinct from n.read_at
  ), 'read');
  return null;
end;
$$;
revoke all on function app.bell_send(uuid[], text), app.bell_signal_insert(), app.bell_signal_update() from public, anon, authenticated;

create trigger notifications_bell_insert after insert on public.notifications
  referencing new table as new_rows
  for each statement execute function app.bell_signal_insert();
create trigger notifications_bell_update after update on public.notifications
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.bell_signal_update();

-- Private topics: a signed-in, active user receives only their own.
create policy "rentdesk: own bell signals" on realtime.messages for select to authenticated using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'notifications:' || (select auth.uid())::text
  and (select app.current_user_role()) is not null
);
