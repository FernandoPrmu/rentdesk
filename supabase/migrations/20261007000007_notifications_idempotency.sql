-- =============================================================================
-- 0007 Notifications (in-app centre + delivery outbox), templates, idempotency keys.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- notifications: one row per recipient per channel. IN_APP rows are delivered on
-- insert; EMAIL/SMS/WHATSAPP rows start PENDING and are sent by server code after
-- the transaction commits (outbox), which updates status/attempts (NOT-05).
-- Inserts are SERVER-WRITE-ONLY; users may only set read_at on their own rows.
-- -----------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.owners (id), -- null for platform (admin) notifications
  user_id uuid not null references public.profiles (id),
  event text not null,
  channel public.notification_channel not null default 'IN_APP',
  title text not null,
  body text not null default '',
  link text,
  data jsonb not null default '{}'::jsonb,
  entity_type text,
  entity_id uuid,
  status public.notification_status not null default 'PENDING',
  attempts smallint not null default 0 check (attempts >= 0),
  last_error text,
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_owner_id_idx on public.notifications (owner_id, created_at desc);
create index notifications_outbox_idx on public.notifications (created_at) where status = 'PENDING';
create index notifications_entity_idx on public.notifications (entity_type, entity_id);

create function app.notification_mark_read() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.read_at is not null and old.read_at is null then
    new.status := 'READ';
  end if;
  return new;
end;
$$;

create trigger notifications_mark_read before update of read_at on public.notifications
  for each row execute function app.notification_mark_read();
create trigger notifications_set_updated_at before update on public.notifications
  for each row execute function app.set_updated_at();

-- In-app notification centre (NOT-01) uses Realtime; RLS still applies to it.
alter publication supabase_realtime add table public.notifications;

-- -----------------------------------------------------------------------------
-- notification_templates (NOT-04, ADM-06). owner_id null = global default;
-- an owner row overrides it for that owner's tenant.
-- -----------------------------------------------------------------------------
create table public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.owners (id),
  event text not null check (event ~ '^[a-z0-9_.]+$'),
  channel public.notification_channel not null,
  locale text not null default 'en' check (locale in ('en', 'si', 'ta')),
  subject text not null default '',
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_templates_key unique nulls not distinct (owner_id, event, channel, locale)
);
create index notification_templates_owner_id_idx on public.notification_templates (owner_id);

create trigger notification_templates_set_updated_at before update on public.notification_templates
  for each row execute function app.set_updated_at();
create trigger notification_templates_audit after insert or update or delete on public.notification_templates
  for each row execute function app.audit_row_change('all');

-- -----------------------------------------------------------------------------
-- idempotency_keys (INV-13, spec 11.2): generic request de-duplication for server
-- actions. The workflow functions additionally enforce uniqueness on the business
-- row (meter_submissions / payments / service_requests.idempotency_key).
-- SERVER-ONLY: no client grants at all.
-- -----------------------------------------------------------------------------
create table public.idempotency_keys (
  user_id uuid not null references public.profiles (id),
  scope public.idempotency_scope not null,
  key uuid not null,
  owner_id uuid references public.owners (id),
  request_hash text not null,
  status text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  response jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  primary key (user_id, scope, key)
);
create index idempotency_keys_owner_id_idx on public.idempotency_keys (owner_id);
create index idempotency_keys_expires_idx on public.idempotency_keys (expires_at);
