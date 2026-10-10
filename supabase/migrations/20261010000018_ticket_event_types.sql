-- =============================================================================
-- 0018 Ticket event types used by the daily job (0019).
--
-- In its own migration: a new enum value can be used only after the transaction
-- that added it has committed.
-- =============================================================================

-- TKT-12: a ticket frozen while the customer or the owner is suspended, and resumed.
alter type public.ticket_event_type add value if not exists 'PAUSED';
alter type public.ticket_event_type add value if not exists 'RESUMED';
-- PAY-13 / LATE-01: a late fee added to the ticket's invoice.
alter type public.ticket_event_type add value if not exists 'LATE_FEE';
