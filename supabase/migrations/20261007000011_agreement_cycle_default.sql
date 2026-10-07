-- =============================================================================
-- 0011 rental_agreements.next_cycle_date: add a default so clients can omit it.
--
-- The value is always computed by app.rental_agreement_before_write() on insert
-- (start_date + cycle_length_days) and owners have no column grant for it. Without
-- a default the generated Insert type marks it required, forcing app code to send a
-- column it is not allowed to write. The default is overwritten by the trigger.
-- =============================================================================

alter table public.rental_agreements alter column next_cycle_date set default current_date;
