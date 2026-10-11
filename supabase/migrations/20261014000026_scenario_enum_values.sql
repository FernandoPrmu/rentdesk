-- =============================================================================
-- 0026 Enum values for task 8 (disputes, section 11 scenarios). In their own
-- migration: a new enum value can be used only once it is committed.
--   credit_kind DISPUTE: a credit the owner gives to answer a dispute (11.4).
-- =============================================================================

alter type public.credit_kind add value if not exists 'DISPUTE';
