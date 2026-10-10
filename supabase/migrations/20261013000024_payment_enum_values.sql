-- =============================================================================
-- 0024 Enum values for payments (task 7). Its own migration: a value added with
-- ALTER TYPE ... ADD VALUE can only be used once this transaction has committed
-- (0025 uses them).
--
-- * payment_status REVERSED: an accepted payment taken back (returned cheque,
--   TKT-10 / spec 11.5).
-- * credit_status VOID: an unused credit removed because the payment that made
--   it was reversed (kept as a record, never available again).
-- * ticket_event_type PAYMENT: a payment change on a ticket that does not change
--   its status (a reversal or reallocation on a partly paid ticket).
-- =============================================================================

alter type public.payment_status add value if not exists 'REVERSED';
alter type public.credit_status add value if not exists 'VOID';
alter type public.ticket_event_type add value if not exists 'PAYMENT';
