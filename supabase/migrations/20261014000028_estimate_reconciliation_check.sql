-- =============================================================================
-- 0028 Estimate reconciliation is checked by the database (spec 11.6; rule 22).
--
-- At the next real reading after an estimated invoice, the billing engine credits
-- the estimated charge (loadMeterContext -> estimateCredits). The database checked
-- the terms, cycles, readings and credits of such a calculation, but not that the
-- estimates were credited: a calculation without them would have billed the
-- commitment twice. app.expected_estimate_credits lists the issued estimated
-- invoices of the agreement for the cycles after the last confirmed reading and
-- before the ticket's cycle (same query as the TypeScript loader); the meter and
-- final invoice checks now compare it with calculation.estimate_credits.
-- =============================================================================

create function app.expected_estimate_credits(p_agreement_id uuid, p_before_cycle integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('invoice_no', i.invoice_no, 'cycle_no', t.cycle_no, 'amount_cents', i.subtotal_cents)
                            order by t.cycle_no), '[]'::jsonb)
  from public.invoices i
  join public.billing_cycle_tickets t on t.id = i.ticket_id
  where i.agreement_id = p_agreement_id
    and i.type = 'ESTIMATED'
    and i.status not in ('DRAFT', 'REJECTED', 'CANCELLED')
    and t.cycle_no < p_before_cycle
    and t.cycle_no > coalesce((
      select max(tt.cycle_no)
      from public.meter_submissions s
      join public.billing_cycle_tickets tt on tt.id = s.ticket_id
      where tt.agreement_id = p_agreement_id and s.status = 'CONFIRMED'
    ), 0);
$$;

create function app.verify_estimate_credits(p_agreement_id uuid, p_before_cycle integer, p_calc jsonb) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(p_calc -> 'estimate_credits', '[]'::jsonb) is distinct from app.expected_estimate_credits(p_agreement_id, p_before_cycle) then
    perform app.fail('RD409', 'The estimated invoices to credit have changed; recalculate the invoice');
  end if;
end;
$$;

-- The meter check (0027's) gains the estimate check; the cycle is the ticket's.
create or replace function app.verify_meter_invoice(
  t public.billing_cycle_tickets,
  p_readings jsonb,
  p_invoice jsonb,
  p_anomaly_flag text
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := p_invoice -> 'calculation';
  v_gap integer;
  v_cycles integer := (p_invoice ->> 'cycles_covered')::integer;
  v_reading jsonb;
  v_calc jsonb;
begin
  if jsonb_typeof(c) is distinct from 'object' or coalesce(c ->> 'engine', '') = '' then
    perform app.fail('RD400', 'The invoice must be calculated by the billing engine');
  end if;
  if coalesce(p_invoice ->> 'type', 'NORMAL') <> 'NORMAL' or (c ->> 'type') is distinct from 'NORMAL' then
    perform app.fail('RD400', 'A meter reading creates a normal invoice');
  end if;
  if jsonb_typeof(c -> 'partial') is distinct from 'null' then
    perform app.fail('RD400', 'A final partial cycle is billed when the machine is returned');
  end if;

  if (c -> 'terms') is distinct from jsonb_build_object(
    'commitment_cents', t.commitment_cents, 'bw_included', t.bw_included, 'bw_rate_cents', t.bw_rate_cents,
    'colour_included', t.colour_included, 'colour_rate_cents', t.colour_rate_cents
  ) then
    perform app.fail('RD409', 'The invoice was calculated with other terms than this ticket''s');
  end if;

  select t.cycle_no - coalesce(max(tt.cycle_no), 0) into v_gap
  from public.meter_submissions s
  join public.billing_cycle_tickets tt on tt.id = s.ticket_id
  where tt.agreement_id = t.agreement_id and s.status = 'CONFIRMED';
  if v_cycles is null or v_cycles <> v_gap
     or (c ->> 'cycles_covered')::integer is distinct from v_gap
     or (c ->> 'full_cycles')::integer is distinct from v_gap then
    perform app.fail('RD409', format('This reading covers %s cycle(s); recalculate the invoice', v_gap));
  end if;

  if jsonb_typeof(c -> 'counters') is distinct from 'array'
     or jsonb_array_length(c -> 'counters') <> jsonb_array_length(p_readings) then
    perform app.fail('RD400', 'The calculation does not match the readings');
  end if;
  for v_reading in select * from jsonb_array_elements(p_readings) loop
    v_calc := null;
    select x into v_calc from jsonb_array_elements(c -> 'counters') x
    where x ->> 'counter_type' = v_reading ->> 'counter_type';
    if v_calc is null
       or (v_calc ->> 'previous_value')::bigint is distinct from (v_reading ->> 'previous_value')::bigint
       or (v_calc ->> 'current_value')::bigint is distinct from (v_reading ->> 'current_value')::bigint
       or coalesce((v_calc ->> 'rolled_over')::boolean, false)
          is distinct from coalesce((v_reading ->> 'rolled_over')::boolean, false) then
      perform app.fail('RD400', 'The calculation does not match the readings');
    end if;
    if app.last_known_reading(t.agreement_id, (v_reading ->> 'counter_type')::public.counter_type)
       is distinct from (v_reading ->> 'previous_value')::bigint then
      perform app.fail('RD409', 'The previous meter reading has changed; recalculate the invoice');
    end if;
  end loop;
  perform app.verify_carried_copies(t.agreement_id, c);
  perform app.verify_estimate_credits(t.agreement_id, t.cycle_no, c);
  if p_anomaly_flag is distinct from (c ->> 'anomaly') then
    perform app.fail('RD400', 'The anomaly flag does not match the calculation');
  end if;

  perform app.verify_invoice_lines(p_invoice);
end;
$$;

-- The final invoice check (0027's): estimates before the final cycle are credited too.
create or replace function app.verify_final_invoice(
  a public.rental_agreements,
  p_facts jsonb,
  h public.agreement_terms_history,
  p_readings jsonb,
  p_invoice jsonb,
  p_anomaly_flag text,
  p_rule text
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := p_invoice -> 'calculation';
  v_full integer := (p_facts ->> 'full_cycles')::integer;
  v_reading jsonb;
  v_calc jsonb;
begin
  if jsonb_typeof(c) is distinct from 'object' or coalesce(c ->> 'engine', '') = '' then
    perform app.fail('RD400', 'The invoice must be calculated by the billing engine');
  end if;
  if coalesce(p_invoice ->> 'type', 'NORMAL') <> 'NORMAL' or (c ->> 'type') is distinct from 'NORMAL' then
    perform app.fail('RD400', 'A final invoice is a normal invoice');
  end if;
  if (c -> 'terms') is distinct from jsonb_build_object(
    'commitment_cents', h.monthly_commitment_cents, 'bw_included', h.bw_included, 'bw_rate_cents', h.bw_rate_cents,
    'colour_included', h.colour_included, 'colour_rate_cents', h.colour_rate_cents
  ) then
    perform app.fail('RD409', 'The final invoice was calculated with other terms than the agreement''s');
  end if;
  if (c ->> 'full_cycles')::integer is distinct from v_full
     or (c ->> 'cycles_covered')::integer is distinct from v_full + 1
     or (p_invoice ->> 'cycles_covered')::integer is distinct from v_full + 1 then
    perform app.fail('RD409', format('The final invoice covers %s whole cycle(s) and the cycle in progress; recalculate it', v_full));
  end if;
  if (c -> 'partial') is distinct from jsonb_build_object(
    'days_used', (p_facts ->> 'days_used')::integer,
    'days_in_cycle', (p_facts ->> 'days_in_cycle')::integer,
    'rule', p_rule
  ) then
    perform app.fail('RD409', format('The final cycle has %s of %s days used today; recalculate the invoice',
                                     p_facts ->> 'days_used', p_facts ->> 'days_in_cycle'));
  end if;

  if jsonb_typeof(c -> 'counters') is distinct from 'array'
     or jsonb_array_length(c -> 'counters') <> jsonb_array_length(p_readings) then
    perform app.fail('RD400', 'The calculation does not match the closing readings');
  end if;
  for v_reading in select * from jsonb_array_elements(p_readings) loop
    v_calc := null;
    select x into v_calc from jsonb_array_elements(c -> 'counters') x
    where x ->> 'counter_type' = v_reading ->> 'counter_type';
    if v_calc is null
       or (v_calc ->> 'previous_value')::bigint is distinct from (v_reading ->> 'previous_value')::bigint
       or (v_calc ->> 'current_value')::bigint is distinct from (v_reading ->> 'current_value')::bigint
       or coalesce((v_calc ->> 'rolled_over')::boolean, false)
          is distinct from coalesce((v_reading ->> 'rolled_over')::boolean, false) then
      perform app.fail('RD400', 'The calculation does not match the closing readings');
    end if;
    if app.last_known_reading(a.id, (v_reading ->> 'counter_type')::public.counter_type)
       is distinct from (v_reading ->> 'previous_value')::bigint then
      perform app.fail('RD409', 'The previous meter reading has changed; recalculate the invoice');
    end if;
  end loop;
  perform app.verify_carried_copies(a.id, c);
  perform app.verify_estimate_credits(a.id, (p_facts ->> 'cycle_no')::integer, c);
  if p_anomaly_flag is distinct from (c ->> 'anomaly') then
    perform app.fail('RD400', 'The anomaly flag does not match the calculation');
  end if;

  perform app.verify_invoice_lines(p_invoice);
end;
$$;

revoke all on function
  app.expected_estimate_credits(uuid, integer),
  app.verify_estimate_credits(uuid, integer, jsonb)
from public, anon, authenticated;
grant execute on function app.expected_estimate_credits(uuid, integer) to service_role;
