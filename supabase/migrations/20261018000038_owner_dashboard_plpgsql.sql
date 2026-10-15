-- =============================================================================
-- 0038 Cheaper Home dashboards (task 11 load fix, decision 84).
--
-- Measured with EXPLAIN (ANALYZE, BUFFERS) as an owner: the dashboard was 28 ms of
-- execution plus 4.4 ms of planning on every call (a SQL function with a SET clause is
-- re-planned each time) and ran the RLS helpers ~100 times (199 InitPlans): every
-- reference to an RLS table re-evaluates its policy. The data is small; the cost was
-- per reference. Now:
--   - PL/pgSQL: the statement is prepared once per connection and its plan reused;
--   - each table is read once into a CTE (tickets, payments, service requests,
--     machines, agreements, customers) and the cards are computed from those;
--   - the customer summary gets the same treatment.
-- The figures are unchanged (checked against 0037 for every owner on three dates).
-- Still security invoker: RLS decides what is read; the guard answers only the owner
-- or an admin.
-- =============================================================================

drop function public.report_owner_dashboard(uuid, date);

create function public.report_owner_dashboard(p_owner_id uuid, p_today date) returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_this_start date := date_trunc('month', p_today)::date;
  v_last_start date := (date_trunc('month', p_today) - interval '1 month')::date;
  v_last_end date := (date_trunc('month', p_today) - interval '1 day')::date;
  -- Same point in last month (31 Oct -> 30 Sep).
  v_last_same date;
  v_top_from date := (date_trunc('month', p_today) - interval '2 months')::date;
begin
  if not app.report_allowed(p_owner_id) then
    return null;
  end if;
  v_last_same := least(v_last_start + (p_today - v_this_start), v_last_end);

  return (
    with settings as (
      select s.service_ack_hours_urgent, s.service_ack_hours_normal, s.agreement_end_notice_days
      from public.owner_settings_effective s where s.owner_id = p_owner_id
    ),
    cust as (
      select c.id, c.name from public.customers c where c.owner_id = p_owner_id
    ),
    mach as (
      select m.id, m.status, m.brand || ' ' || m.model || ' (' || m.serial_no || ')' as name
      from public.machines m where m.owner_id = p_owner_id
    ),
    tickets as (
      select t.status, t.escalation_level
      from public.billing_cycle_tickets t
      where t.owner_id = p_owner_id and t.status not in ('CLOSED', 'CANCELLED')
    ),
    unpaid as (
      select i.status, i.due_date, i.total_cents - i.amount_paid_cents as balance
      from public.invoices i
      where i.owner_id = p_owner_id and i.invoice_no is not null and i.total_cents > i.amount_paid_cents
        and i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
    ),
    -- Open requests and the rated ones (for the average), in one read.
    requests as (
      select r.id, r.type, r.urgency, r.status, r.created_at, r.toner_colours, r.part_name, r.machine_id, r.customer_id, r.rating
      from public.service_requests r
      where r.owner_id = p_owner_id
        and (r.status in ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED') or r.rating is not null)
    ),
    open_requests as (
      select r.*, c.name as customer,
             r.status = 'NEW' and r.created_at + make_interval(hours =>
               case when r.urgency in ('URGENT', 'HIGH') then s.service_ack_hours_urgent else s.service_ack_hours_normal end) < now() as overdue
      from requests r
      join cust c on c.id = r.customer_id
      cross join settings s
      where r.status in ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED')
    ),
    agreements as (
      select a.id, a.status, a.end_date
      from public.rental_agreements a
      where a.owner_id = p_owner_id and a.status in ('ACTIVE', 'TERMINATED')
    ),
    collected as (
      select c.on_date, c.amount_cents from app.report_collected(p_owner_id, v_last_start, p_today) c
    ),
    lines as (
      select l.issued_on, l.machine_id, l.kind, l.amount_cents from app.report_invoice_lines(p_owner_id, v_top_from, p_today) l
    ),
    payments as (
      select p.id, p.paid_on, p.status, coalesce(p.accepted_amount_cents, p.amount_cents) as amount_cents, p.method, p.customer_id, p.verified_at
      from public.payments p
      where p.owner_id = p_owner_id and p.status in ('SUBMITTED', 'ACCEPTED', 'PARTIAL')
    )
    select jsonb_build_object(
      'today', p_today,
      'collected_this_month', (select coalesce(sum(amount_cents) filter (where on_date >= v_this_start), 0) from collected),
      'collected_last_month', (select coalesce(sum(amount_cents) filter (where on_date <= v_last_end), 0) from collected),
      'collected_last_month_to_date', (select coalesce(sum(amount_cents) filter (where on_date <= v_last_same), 0) from collected),
      'invoiced_this_month', (select coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT' and issued_on >= v_this_start), 0) from lines),
      'invoiced_last_month', (select coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT' and issued_on between v_last_start and v_last_end), 0) from lines),
      'outstanding_cents', (select coalesce(sum(balance), 0) from unpaid),
      'overdue_cents', (select coalesce(sum(balance) filter (where status <> 'PAYMENT_SUBMITTED' and due_date < p_today), 0) from unpaid),
      'overdue_bills', (select count(*) filter (where status <> 'PAYMENT_SUBMITTED' and due_date < p_today) from unpaid),
      'readings_to_review', (select count(*) filter (where status = 'PENDING_OWNER_REVIEW') from tickets),
      'slips_to_verify', (select count(*) filter (where status = 'SUBMITTED') from payments),
      'tickets_by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from tickets group by status) x),
      'tickets_escalated', (select count(*) filter (where escalation_level > 0) from tickets),
      'service', jsonb_build_object(
         'total', (select count(*) from open_requests),
         'by_urgency', (select coalesce(jsonb_object_agg(urgency, n), '{}'::jsonb) from (select urgency, count(*) n from open_requests group by urgency) x),
         'by_type', (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb) from (select type, count(*) n from open_requests group by type) x),
         'overdue', (select count(*) filter (where overdue) from open_requests),
         'to_confirm', (select count(*) filter (where status = 'RESOLVED') from open_requests),
         'top', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
            select id, type, urgency, status, customer, overdue, toner_colours, part_name from open_requests
            order by case urgency when 'URGENT' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end, overdue desc, created_at
            limit 5) x)
      ),
      'deposits', (select jsonb_build_object('count', count(*), 'held_cents', coalesce(sum(b.held_cents), 0))
                   from public.agreement_deposit_balances b
                   join agreements a on a.id = b.agreement_id and a.status = 'TERMINATED'
                   where b.held_cents > 0),
      'machines', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from mach group by status) x),
      'machines_in_service', (select count(distinct r.machine_id) from requests r join mach m on m.id = r.machine_id and m.status = 'RENTED'
                              where r.status in ('ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS')),
      'rating', (select jsonb_build_object('average', round(avg(rating)::numeric, 2), 'count', count(rating)) from requests where rating is not null),
      'ending_soon', (select count(*) from agreements a cross join settings s
                      where a.status = 'ACTIVE' and a.end_date is not null and a.end_date between p_today and p_today + s.agreement_end_notice_days),
      'top_machines', (select coalesce(jsonb_agg(x order by x.revenue_cents desc), '[]'::jsonb) from (
         select l.machine_id as id, m.name, sum(l.amount_cents) filter (where l.kind <> 'PAID_CREDIT') as revenue_cents
         from lines l join mach m on m.id = l.machine_id
         group by l.machine_id, m.name
         order by 3 desc limit 5) x),
      'recent_payments', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
         select p.id, p.paid_on, p.status, p.amount_cents, p.method, c.name as customer
         from payments p join cust c on c.id = p.customer_id
         where p.status in ('ACCEPTED', 'PARTIAL')
         order by p.paid_on desc, p.verified_at desc nulls last limit 5) x)
    )
  );
end;
$$;

drop function public.report_customer_dashboard();

create function public.report_customer_dashboard() returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_me uuid := app.current_customer_id();
begin
  if v_me is null then
    return null;
  end if;
  return (
    with bills as (
      select i.id, i.invoice_no, i.status, i.total_cents, i.amount_paid_cents, i.due_date, i.issued_at, i.pdf_path
      from public.invoices i
      where i.customer_id = v_me and i.invoice_no is not null and i.status <> 'CANCELLED'
    )
    select jsonb_build_object(
      'outstanding_cents', (select coalesce(sum(total_cents - amount_paid_cents), 0) from bills
         where status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')),
      'credit_cents', (select coalesce(sum(c.amount_cents - c.refunded_cents), 0) from public.credits c
         where c.customer_id = v_me and c.status = 'AVAILABLE'),
      'machines', (select coalesce(jsonb_agg(x order by x.next_cycle_date, x.name), '[]'::jsonb) from (
         select a.id as agreement_id, m.brand || ' ' || m.model as name, m.serial_no, m.type, a.next_cycle_date, a.end_date,
                a.installation_location as location
         from public.rental_agreements a join public.machines m on m.id = a.machine_id
         where a.customer_id = v_me and a.status = 'ACTIVE') x),
      'latest_invoice', (select to_jsonb(x) from (
         select id, invoice_no, status, total_cents, amount_paid_cents, due_date, issued_at, pdf_path is not null as has_pdf
         from bills order by issued_at desc nulls last limit 1) x),
      'recent_payments', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
         select p.id, p.paid_on, p.status, p.amount_cents, p.accepted_amount_cents
         from public.payments p where p.customer_id = v_me
         order by p.submitted_at desc limit 3) x),
      'open_requests', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
         select r.id, r.type, r.status, r.urgency, r.toner_colours, r.part_name, m.brand || ' ' || m.model as machine
         from public.service_requests r join public.machines m on m.id = r.machine_id
         where r.customer_id = v_me and r.status in ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED')
         order by r.created_at desc limit 5) x)
    )
  );
end;
$$;

revoke execute on function public.report_owner_dashboard(uuid, date), public.report_customer_dashboard() from public, anon;
grant execute on function public.report_owner_dashboard(uuid, date), public.report_customer_dashboard() to authenticated, service_role;
