-- =============================================================================
-- 0037 The owner dashboard reads each row helper once (task 11).
--
-- It called app.report_collected three times and app.report_invoice_lines three
-- times (this month, last month, the same day last month, top machines). Now one read
-- of each over the window it needs (from last month's start, and two months back for
-- the top machines), split with FILTER: the same figures with a third of the scans.
-- Under the full e2e load the free-tier database stalled on CPU and the dashboard,
-- loaded on every owner Home, was the most frequent long statement.
-- =============================================================================

create or replace function public.report_owner_dashboard(p_owner_id uuid, p_today date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    with bounds as (
      select date_trunc('month', p_today)::date as this_start,
             (date_trunc('month', p_today) - interval '1 month')::date as last_start,
             (date_trunc('month', p_today) - interval '1 day')::date as last_end,
             -- Same point in last month (31 Oct -> 30 Sep).
             least((date_trunc('month', p_today) - interval '1 month')::date + (p_today - date_trunc('month', p_today)::date),
                   (date_trunc('month', p_today) - interval '1 day')::date) as last_same_day
    ),
    settings as (select * from public.owner_settings_effective where owner_id = p_owner_id),
    collected as (
      select c.on_date, c.amount_cents
      from bounds b, app.report_collected(p_owner_id, b.last_start, p_today) c
    ),
    lines as (
      select l.issued_on, l.machine_id, l.kind, l.amount_cents
      from bounds b, app.report_invoice_lines(p_owner_id, (b.this_start - interval '2 months')::date, p_today) l
    ),
    unpaid as (
      select i.status, i.due_date, i.total_cents - i.amount_paid_cents as balance
      from public.invoices i
      where i.owner_id = p_owner_id and i.invoice_no is not null and i.total_cents > i.amount_paid_cents
        and i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
    ),
    open_requests as (
      select r.id, r.type, r.urgency, r.status, r.created_at, r.escalation_level, r.toner_colours, r.part_name,
             c.name as customer,
             r.status = 'NEW' and r.created_at + make_interval(hours =>
               case when r.urgency in ('URGENT', 'HIGH') then s.service_ack_hours_urgent else s.service_ack_hours_normal end) < now() as overdue
      from public.service_requests r
      join public.customers c on c.id = r.customer_id
      cross join settings s
      where r.owner_id = p_owner_id and r.status in ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED')
    )
    select jsonb_build_object(
      'today', p_today,
      'collected_this_month', (select coalesce(sum(c.amount_cents) filter (where c.on_date >= b.this_start), 0) from bounds b, collected c),
      'collected_last_month', (select coalesce(sum(c.amount_cents) filter (where c.on_date <= b.last_end), 0) from bounds b, collected c),
      'collected_last_month_to_date', (select coalesce(sum(c.amount_cents) filter (where c.on_date <= b.last_same_day), 0) from bounds b, collected c),
      'invoiced_this_month', (select coalesce(sum(l.amount_cents) filter (where l.kind <> 'PAID_CREDIT' and l.issued_on >= b.this_start), 0)
                              from bounds b, lines l),
      'invoiced_last_month', (select coalesce(sum(l.amount_cents) filter (where l.kind <> 'PAID_CREDIT' and l.issued_on between b.last_start and b.last_end), 0)
                              from bounds b, lines l),
      'outstanding_cents', (select coalesce(sum(balance), 0) from unpaid),
      'overdue_cents', (select coalesce(sum(balance) filter (where status <> 'PAYMENT_SUBMITTED' and due_date < p_today), 0) from unpaid),
      'overdue_bills', (select count(*) filter (where status <> 'PAYMENT_SUBMITTED' and due_date < p_today) from unpaid),
      'readings_to_review', (select count(*) from public.billing_cycle_tickets where owner_id = p_owner_id and status = 'PENDING_OWNER_REVIEW'),
      'slips_to_verify', (select count(*) from public.payments where owner_id = p_owner_id and status = 'SUBMITTED'),
      'tickets_by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
         select status, count(*) n from public.billing_cycle_tickets
         where owner_id = p_owner_id and status not in ('CLOSED', 'CANCELLED') group by status) x),
      'tickets_escalated', (select count(*) from public.billing_cycle_tickets
         where owner_id = p_owner_id and status not in ('CLOSED', 'CANCELLED') and escalation_level > 0),
      'service', jsonb_build_object(
         'total', (select count(*) from open_requests),
         'by_urgency', (select coalesce(jsonb_object_agg(urgency, n), '{}'::jsonb) from (select urgency, count(*) n from open_requests group by urgency) x),
         'by_type', (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb) from (select type, count(*) n from open_requests group by type) x),
         'overdue', (select count(*) from open_requests where overdue),
         'to_confirm', (select count(*) from open_requests where status = 'RESOLVED'),
         'top', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
            select id, type, urgency, status, customer, overdue, toner_colours, part_name from open_requests
            order by case urgency when 'URGENT' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end, overdue desc, created_at
            limit 5) x)
      ),
      'deposits', (select jsonb_build_object('count', count(*), 'held_cents', coalesce(sum(b.held_cents), 0))
                   from public.agreement_deposit_balances b
                   join public.rental_agreements a on a.id = b.agreement_id and a.status = 'TERMINATED'
                   where a.owner_id = p_owner_id and b.held_cents > 0),
      'machines', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
         select status, count(*) n from public.machines where owner_id = p_owner_id group by status) x),
      'machines_in_service', (select count(distinct r.machine_id) from public.service_requests r
         join public.machines m on m.id = r.machine_id and m.status = 'RENTED'
         where r.owner_id = p_owner_id and r.status in ('ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS')),
      'rating', (select jsonb_build_object('average', round(avg(rating)::numeric, 2), 'count', count(rating))
                 from public.service_requests where owner_id = p_owner_id and rating is not null),
      'ending_soon', (select count(*) from public.rental_agreements a cross join settings s
         where a.owner_id = p_owner_id and a.status = 'ACTIVE' and a.end_date is not null
           and a.end_date between p_today and p_today + s.agreement_end_notice_days),
      'top_machines', (select coalesce(jsonb_agg(x order by x.revenue_cents desc), '[]'::jsonb) from (
         select l.machine_id as id, m.brand || ' ' || m.model || ' (' || m.serial_no || ')' as name,
                sum(l.amount_cents) filter (where l.kind <> 'PAID_CREDIT') as revenue_cents
         from lines l
         join public.machines m on m.id = l.machine_id
         group by l.machine_id, m.brand, m.model, m.serial_no
         order by 3 desc limit 5) x),
      'recent_payments', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
         select p.id, p.paid_on, p.status, coalesce(p.accepted_amount_cents, p.amount_cents) as amount_cents, p.method, c.name as customer
         from public.payments p join public.customers c on c.id = p.customer_id
         where p.owner_id = p_owner_id and p.status in ('ACCEPTED', 'PARTIAL')
         order by p.paid_on desc, p.verified_at desc nulls last limit 5) x)
    )
  ) end;
$$;
