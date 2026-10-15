-- Task 13: the production lock (decision 95).
--
-- `platform_settings.environment` says whether this database is the live one. A fresh
-- database (every migration from zero) is 'development'; only the go-live script
-- (`npm run golive:wipe`, scripts/go-live-wipe.ts) sets 'production', over a direct
-- `postgres` connection. Every developer tool that writes test or demo data (test:db,
-- the e2e suites, db:seed, db:cleanup-test-data) and `npm run dev` read it first and
-- refuse to run against a production database. No environment variable overrides it.
--
-- Rules, enforced here so neither the app nor a mistyped SQL statement can undo them:
--   - only a direct `postgres` session may change it (not the Data API: PostgREST's
--     session user is `authenticator`, even inside a security definer function);
--   - once 'production', it stays 'production' (no way back short of dropping this
--     trigger on purpose);
--   - it is not an admin setting (app.platform_setting_keys does not list it).
--
-- `public.rentdesk_environment()` returns only that word and may be called with the
-- public anon key: the dev guard and the health check need nothing secret. It is the one
-- public function anon may execute (rls.db.test.ts).

alter table public.platform_settings
  add column environment text not null default 'development'
  constraint platform_settings_environment_check check (environment in ('development', 'production'));

comment on column public.platform_settings.environment is
  'development | production. Set to production only by npm run golive:wipe (decision 95); never changed back.';

create function app.guard_platform_environment() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.environment is not distinct from old.environment then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.environment = 'production' then
    perform app.fail('RD403', 'This database is production: the environment flag cannot be changed back');
  end if;
  if new.environment <> 'development' and session_user <> 'postgres' then
    perform app.fail('RD403', 'The environment flag is set only by the go-live script over a direct database connection');
  end if;
  return new;
end;
$$;

create trigger platform_settings_environment_guard
  before insert or update of environment on public.platform_settings
  for each row execute function app.guard_platform_environment();

create function public.rentdesk_environment() returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select environment from public.platform_settings limit 1), 'development');
$$;

comment on function public.rentdesk_environment() is
  'development | production (decision 95). Public on purpose: the dev guard and /api/health call it with the anon key.';

revoke all on function public.rentdesk_environment() from public;
grant execute on function public.rentdesk_environment() to anon, authenticated, service_role;
revoke all on function app.guard_platform_environment() from public, anon, authenticated;
