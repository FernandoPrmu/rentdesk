-- Restore test into a PLAIN Postgres 17 (docs/backup-restore.md, part B). A Supabase
-- database has these roles and extensions; a plain one does not, and the dump's RLS
-- policies (TO authenticated ...) and column defaults need them. Safe to run twice.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin',
                           'supabase_auth_admin', 'supabase_storage_admin', 'supabase_realtime_admin', 'dashboard_user'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end
$$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
