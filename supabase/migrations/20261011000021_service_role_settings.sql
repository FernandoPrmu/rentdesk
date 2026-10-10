-- =============================================================================
-- 0021 Server code reads the effective settings (stage deadlines, rejection limit)
-- with the service role (src/lib/meter/service.ts). The view was recreated in 0017
-- and new objects get no automatic grants in this project.
-- =============================================================================
grant select on public.owner_settings_effective to service_role;
