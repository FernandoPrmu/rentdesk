-- =============================================================================
-- 0016 Payment method SECURITY_DEPOSIT ("From security deposit", DEP-03).
--
-- An unpaid invoice paid from the customer's security deposit when a machine is
-- returned. DEPOSIT stays what it was: a cash deposit at the bank.
-- On its own migration: a new enum value can only be used after it is committed.
-- =============================================================================

alter type public.payment_method add value if not exists 'SECURITY_DEPOSIT';
