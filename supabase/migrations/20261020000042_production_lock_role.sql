-- Task 13: the production lock (0041, decision 95), tightened. The service role has
-- table-level UPDATE on platform_settings, so the flag now requires BOTH the session user
-- and the current role to be `postgres`: a direct connection, not acting as another role.
-- Through the Data API the session user is `authenticator` (also inside a security
-- definer function), and a statement run as service_role has current_user service_role.

create or replace function app.guard_platform_environment() returns trigger
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
  if new.environment <> 'development' and (session_user <> 'postgres' or current_user <> 'postgres') then
    perform app.fail('RD403', 'The environment flag is set only by the go-live script over a direct database connection');
  end if;
  return new;
end;
$$;
