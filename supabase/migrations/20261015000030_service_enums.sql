-- =============================================================================
-- 0030 Service requests: enum value in its own migration (a new value is usable
-- only once committed). A goodwill discount on a breakdown is a customer credit
-- (decision 60), taken off the next bills like the others (rule 13).
-- =============================================================================

alter type public.credit_kind add value if not exists 'SERVICE_DISCOUNT';
