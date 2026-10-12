-- =============================================================================
-- 0036 The report guard runs once per call, not once per row (task 11).
--
-- 0035 filtered the row helpers with `where app.report_allowed(p_owner_id)`: a
-- function call per row, each reading profiles through the RLS helpers, and the
-- helpers run several times per dashboard. Under the e2e load the owner and customer
-- dashboards averaged over a second and hit the 8 s statement timeout. As a scalar
-- subquery the guard becomes an InitPlan, evaluated once. Bodies are unchanged.
-- =============================================================================

create or replace function public.report_income(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    with months as (
      select gs::date as month
      from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') gs
    ),
    inv as (
      select date_trunc('month', issued_on)::date as month,
             coalesce(sum(amount_cents) filter (where kind = 'COMMITMENT'), 0) as commitment,
             coalesce(sum(amount_cents) filter (where kind = 'EXCESS'), 0) as excess,
             coalesce(sum(amount_cents) filter (where kind = 'OTHER'), 0) as other,
             coalesce(sum(amount_cents) filter (where kind = 'DISCOUNT'), 0) as discounts,
             count(distinct invoice_id) as invoices
      from app.report_invoice_lines(p_owner_id, p_from, p_to)
      group by 1
    ),
    col as (
      select date_trunc('month', on_date)::date as month,
             coalesce(sum(amount_cents) filter (where source = 'PAYMENT'), 0) as payments,
             coalesce(sum(amount_cents) filter (where source = 'ADVANCE'), 0) as advances,
             coalesce(sum(amount_cents) filter (where source = 'DEPOSIT_KEPT'), 0) as deposits_kept,
             coalesce(sum(amount_cents) filter (where source = 'REFUND'), 0) as refunds
      from app.report_collected(p_owner_id, p_from, p_to)
      group by 1
    )
    select jsonb_build_object('months', coalesce(jsonb_agg(jsonb_build_object(
      'month', m.month,
      'commitment_cents', coalesce(inv.commitment, 0),
      'excess_cents', coalesce(inv.excess, 0),
      'other_cents', coalesce(inv.other, 0),
      'discount_cents', coalesce(inv.discounts, 0),
      'invoices', coalesce(inv.invoices, 0),
      'payments_cents', coalesce(col.payments, 0),
      'advances_cents', coalesce(col.advances, 0),
      'deposits_kept_cents', coalesce(col.deposits_kept, 0),
      'refunds_cents', coalesce(col.refunds, 0)
    ) order by m.month), '[]'::jsonb))
    from months m
    left join inv on inv.month = m.month
    left join col on col.month = m.month
  ) end;
$$;

create or replace function public.report_machines(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    with lines as (
      select machine_id,
             coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT'), 0) as revenue,
             coalesce(sum(amount_cents) filter (where kind = 'COMMITMENT'), 0) as commitment,
             coalesce(sum(amount_cents) filter (where line_type = 'BW_EXCESS'), 0) as bw_excess,
             coalesce(sum(amount_cents) filter (where line_type = 'COLOUR_EXCESS'), 0) as colour_excess,
             coalesce(sum(amount_cents) filter (where kind in ('OTHER', 'DISCOUNT')), 0) as other
      from app.report_invoice_lines(p_owner_id, p_from, p_to)
      group by machine_id
    ),
    copies as (
      select i.machine_id,
             coalesce(sum((c ->> 'usage')::bigint) filter (where c ->> 'counter_type' = 'BW'), 0) as bw,
             coalesce(sum((c ->> 'usage')::bigint) filter (where c ->> 'counter_type' = 'COLOUR'), 0) as colour
      from public.invoices i
      cross join lateral jsonb_array_elements(coalesce(i.calculation -> 'counters', '[]'::jsonb)) c
      where i.owner_id = p_owner_id and i.type = 'NORMAL' and i.issued_at is not null and i.status <> 'CANCELLED'
        and (i.issued_at at time zone 'Asia/Colombo')::date between p_from and p_to
      group by i.machine_id
    ),
    costs as (
      select machine_id,
             sum(cost_cents) as service_cost,
             coalesce(sum(cost_cents) filter (where type = 'TONER'), 0) as toner_cost
      from app.report_service_costs(p_owner_id, p_from, p_to)
      group by machine_id
    ),
    requests as (
      select machine_id, count(*) as requests, count(*) filter (where type = 'TONER') as toner_requests
      from public.service_requests
      where owner_id = p_owner_id and (created_at at time zone 'Asia/Colombo')::date between p_from and p_to
      group by machine_id
    ),
    live as (
      select a.machine_id, c.name as customer
      from public.rental_agreements a join public.customers c on c.id = a.customer_id
      where a.owner_id = p_owner_id and a.status = 'ACTIVE'
    )
    select jsonb_build_object('machines', coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'brand', m.brand, 'model', m.model, 'serial_no', m.serial_no, 'type', m.type, 'status', m.status,
      'customer', live.customer,
      'revenue_cents', coalesce(l.revenue, 0), 'commitment_cents', coalesce(l.commitment, 0),
      'bw_excess_cents', coalesce(l.bw_excess, 0), 'colour_excess_cents', coalesce(l.colour_excess, 0),
      'other_cents', coalesce(l.other, 0),
      'bw_copies', coalesce(cp.bw, 0), 'colour_copies', coalesce(cp.colour, 0),
      'service_cost_cents', coalesce(co.service_cost, 0), 'toner_cost_cents', coalesce(co.toner_cost, 0),
      'requests', coalesce(rq.requests, 0), 'toner_requests', coalesce(rq.toner_requests, 0)
    ) order by coalesce(l.revenue, 0) desc, m.brand, m.model, m.serial_no), '[]'::jsonb))
    from public.machines m
    left join lines l on l.machine_id = m.id
    left join copies cp on cp.machine_id = m.id
    left join costs co on co.machine_id = m.id
    left join requests rq on rq.machine_id = m.id
    left join live on live.machine_id = m.id
    where m.owner_id = p_owner_id
      and (m.status <> 'RETIRED' or l.machine_id is not null or co.machine_id is not null)
  ) end;
$$;

create or replace function public.report_customers(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    with inv as (
      select customer_id,
             coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT'), 0) as invoiced,
             count(distinct invoice_id) as invoices
      from app.report_invoice_lines(p_owner_id, p_from, p_to)
      group by customer_id
    ),
    col as (
      select customer_id, sum(amount_cents) as collected
      from app.report_collected(p_owner_id, p_from, p_to)
      group by customer_id
    ),
    -- Bills due in the range that are paid: on time when the last money arrived by the due date.
    paid as (
      select i.customer_id, i.id, i.due_date, (i.issued_at at time zone 'Asia/Colombo')::date as issued_on,
             max(p.paid_on) as paid_on
      from public.invoices i
      join public.payment_allocations a on a.invoice_id = i.id and a.released_at is null and a.applied_cents > 0
      join public.payments p on p.id = a.payment_id and p.status in ('ACCEPTED', 'PARTIAL')
      where i.owner_id = p_owner_id and i.status = 'PAID' and i.due_date between p_from and p_to
      group by i.customer_id, i.id, i.due_date, i.issued_at
    ),
    behaviour as (
      select customer_id, count(*) as paid_bills,
             count(*) filter (where paid_on <= due_date) as on_time,
             round(avg(paid_on - issued_on), 1) as avg_days_to_pay
      from paid group by customer_id
    ),
    bal as (
      select customer_id,
             sum(total_cents - amount_paid_cents) as outstanding,
             sum(total_cents - amount_paid_cents) filter (
               where due_date < (now() at time zone 'Asia/Colombo')::date and status <> 'PAYMENT_SUBMITTED') as overdue
      from public.invoices
      where owner_id = p_owner_id and invoice_no is not null
        and status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
      group by customer_id
    ),
    cred as (
      select customer_id, sum(amount_cents - refunded_cents) as credit
      from public.credits where owner_id = p_owner_id and status = 'AVAILABLE'
      group by customer_id
    ),
    machines as (
      select customer_id, count(*) as machines from public.rental_agreements
      where owner_id = p_owner_id and status = 'ACTIVE' group by customer_id
    )
    select jsonb_build_object('customers', coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'business_name', c.business_name, 'status', pr.status,
      'machines', coalesce(mc.machines, 0),
      'invoiced_cents', coalesce(inv.invoiced, 0), 'invoices', coalesce(inv.invoices, 0),
      'collected_cents', coalesce(col.collected, 0),
      'outstanding_cents', coalesce(bal.outstanding, 0), 'overdue_cents', coalesce(bal.overdue, 0),
      'credit_cents', coalesce(cred.credit, 0),
      'paid_bills', coalesce(b.paid_bills, 0), 'paid_on_time', coalesce(b.on_time, 0),
      'avg_days_to_pay', b.avg_days_to_pay
    ) order by coalesce(bal.overdue, 0) desc, coalesce(bal.outstanding, 0) desc, c.name), '[]'::jsonb))
    from public.customers c
    join public.profiles pr on pr.id = c.id
    left join inv on inv.customer_id = c.id
    left join col on col.customer_id = c.id
    left join behaviour b on b.customer_id = c.id
    left join bal on bal.customer_id = c.id
    left join cred on cred.customer_id = c.id
    left join machines mc on mc.customer_id = c.id
    where c.owner_id = p_owner_id
      and (pr.status = 'ACTIVE' or inv.customer_id is not null or col.customer_id is not null or bal.customer_id is not null)
  ) end;
$$;

create or replace function public.report_service_demand(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    with r as (
      -- Named columns: cost_cents is not readable by clients (decision 64).
      select sr.id, sr.machine_id, sr.customer_id, sr.type, sr.urgency, sr.status, sr.toner_colours, sr.rating,
             sr.created_at, sr.acknowledged_at, sr.resolved_at,
             (sr.created_at at time zone 'Asia/Colombo')::date as created_on
      from public.service_requests sr
      where sr.owner_id = p_owner_id and (sr.created_at at time zone 'Asia/Colombo')::date between p_from and p_to
    ),
    machine_names as (
      select id, brand || ' ' || model || ' (' || serial_no || ')' as name, type from public.machines where owner_id = p_owner_id
    )
    select jsonb_build_object(
      'total', (select count(*) from r),
      'open', (select count(*) from r where status not in ('CLOSED', 'CANCELLED', 'RESOLVED')),
      'by_type', (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb) from (select type, count(*) n from r group by type) x),
      'by_urgency', (select coalesce(jsonb_object_agg(urgency, n), '{}'::jsonb) from (select urgency, count(*) n from r group by urgency) x),
      'by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', month, 'requests', n, 'toner', t) order by month), '[]'::jsonb)
                   from (select date_trunc('month', created_on)::date as month, count(*) as n, count(*) filter (where type = 'TONER') t from r group by 1) x),
      'toner_colours', (select coalesce(jsonb_object_agg(colour, n), '{}'::jsonb)
                        from (select colour, count(*) n from r, unnest(r.toner_colours) colour where r.type = 'TONER' group by colour) x),
      'avg_ack_hours', (select round(avg(extract(epoch from acknowledged_at - created_at) / 3600)::numeric, 1) from r where acknowledged_at is not null),
      'avg_resolve_hours', (select round(avg(extract(epoch from resolved_at - created_at) / 3600)::numeric, 1) from r where resolved_at is not null),
      'avg_rating', (select round(avg(rating)::numeric, 2) from r where rating is not null),
      'ratings', (select count(*) from r where rating is not null),
      'by_machine', (select coalesce(jsonb_agg(x order by x.requests desc, x.name), '[]'::jsonb) from (
         select r.machine_id as id, mn.name, count(*) as requests,
                count(*) filter (where r.type = 'TONER') as toner,
                count(*) filter (where r.type = 'BREAKDOWN') as breakdowns
         from r join machine_names mn on mn.id = r.machine_id group by r.machine_id, mn.name) x),
      'by_customer', (select coalesce(jsonb_agg(x order by x.requests desc, x.name), '[]'::jsonb) from (
         select r.customer_id as id, c.name, count(*) as requests, count(*) filter (where r.type = 'TONER') as toner
         from r join public.customers c on c.id = r.customer_id group by r.customer_id, c.name) x),
      -- Toner history up to the end of the range, newest 6 per machine (forecast input).
      'toner_history', (select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) from (
         select mn.id, mn.name, mn.type,
                (select jsonb_agg(d order by d) from (
                   select (sr.created_at at time zone 'Asia/Colombo')::date d
                   from public.service_requests sr
                   where sr.owner_id = p_owner_id and sr.machine_id = mn.id and sr.type = 'TONER' and sr.status <> 'CANCELLED'
                     and (sr.created_at at time zone 'Asia/Colombo')::date <= p_to
                   order by sr.created_at desc limit 6) h) as dates
         from machine_names mn
         where exists (select 1 from public.service_requests sr where sr.owner_id = p_owner_id and sr.machine_id = mn.id and sr.type = 'TONER')) x)
    )
  ) end;
$$;

create or replace function public.report_usage(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    select jsonb_build_object('rows', coalesce(jsonb_agg(x order by x.month, x.machine), '[]'::jsonb))
    from (
      select date_trunc('month', i.period_end)::date as month,
             i.machine_id, m.brand || ' ' || m.model || ' (' || m.serial_no || ')' as machine,
             i.customer_id, c.name as customer,
             coalesce(sum((k ->> 'usage')::bigint) filter (where k ->> 'counter_type' = 'BW'), 0) as bw,
             coalesce(sum((k ->> 'usage')::bigint) filter (where k ->> 'counter_type' = 'COLOUR'), 0) as colour
      from public.invoices i
      join public.machines m on m.id = i.machine_id
      join public.customers c on c.id = i.customer_id
      cross join lateral jsonb_array_elements(coalesce(i.calculation -> 'counters', '[]'::jsonb)) k
      where i.owner_id = p_owner_id and i.type = 'NORMAL' and i.issued_at is not null and i.status <> 'CANCELLED'
        and i.period_end between p_from and p_to
      group by 1, i.machine_id, m.brand, m.model, m.serial_no, i.customer_id, c.name
    ) x
  ) end;
$$;

create or replace function public.report_rental(p_owner_id uuid, p_today date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    select jsonb_build_object(
      'machines', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                   from (select status, count(*) n from public.machines where owner_id = p_owner_id group by status) x),
      'notice_days', (select agreement_end_notice_days from public.owner_settings_effective where owner_id = p_owner_id),
      'agreements', (select coalesce(jsonb_agg(x order by x.end_date nulls last, x.customer), '[]'::jsonb) from (
         select a.id, a.start_date, a.end_date, a.next_cycle_date, a.monthly_commitment_cents,
                case when a.end_date is null then null else a.end_date - p_today end as days_left,
                c.name as customer, m.brand || ' ' || m.model || ' (' || m.serial_no || ')' as machine, m.type
         from public.rental_agreements a
         join public.customers c on c.id = a.customer_id
         join public.machines m on m.id = a.machine_id
         where a.owner_id = p_owner_id and a.status = 'ACTIVE') x)
    )
  ) end;
$$;

create or replace function public.report_cycle_status(p_owner_id uuid, p_from date, p_to date) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    with t as (
      select * from public.billing_cycle_tickets
      where owner_id = p_owner_id and cycle_date between p_from and p_to
    ),
    ev as (
      select e.ticket_id, e.from_status, e.to_status, e.event_type, e.created_at,
             lead(e.created_at) over (partition by e.ticket_id order by e.created_at, e.id) as next_at
      from public.ticket_events e
      join t on t.id = e.ticket_id
      where e.to_status is not null and (e.from_status is distinct from e.to_status or e.event_type = 'CREATED')
    )
    select jsonb_build_object(
      'tickets', (select count(*) from t),
      'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from t group by status) x),
      'avg_hours', (select coalesce(jsonb_object_agg(to_status, h), '{}'::jsonb) from (
         select to_status, round(avg(extract(epoch from next_at - created_at) / 3600)::numeric, 1) h
         from ev where next_at is not null group by to_status) x),
      'late_tickets', (select count(*) from t where t.is_late),
      'went_overdue', (select count(distinct ticket_id) from ev where to_status = 'OVERDUE'),
      'late_readings', (select count(distinct s.ticket_id) from public.meter_submissions s
         join ev on ev.ticket_id = s.ticket_id and ev.to_status = 'OVERDUE' and ev.from_status = 'METER_REQUESTED'
         where s.submitted_at > ev.created_at),
      'escalations', (select count(*) from public.ticket_events e join t on t.id = e.ticket_id where e.event_type = 'ESCALATION'),
      'reminders', (select count(*) from public.ticket_events e join t on t.id = e.ticket_id where e.event_type = 'REMINDER')
    )
  ) end;
$$;

create or replace function public.report_ageing_invoices(p_owner_id uuid) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when (select app.report_allowed(p_owner_id)) then (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'invoice_no', i.invoice_no, 'customer_id', i.customer_id, 'customer_name', c.name,
      'status', i.status, 'due_date', i.due_date, 'balance_cents', i.total_cents - i.amount_paid_cents
    ) order by i.due_date nulls last, i.invoice_no), '[]'::jsonb)
    from public.invoices i join public.customers c on c.id = i.customer_id
    where i.owner_id = p_owner_id and i.invoice_no is not null
      and i.status in ('AWAITING_PAYMENT', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED')
      and i.total_cents > i.amount_paid_cents
  ) end;
$$;

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
      'collected_this_month', (select coalesce(sum(amount_cents), 0) from bounds b, app.report_collected(p_owner_id, b.this_start, p_today)),
      'collected_last_month', (select coalesce(sum(amount_cents), 0) from bounds b, app.report_collected(p_owner_id, b.last_start, b.last_end)),
      'collected_last_month_to_date', (select coalesce(sum(amount_cents), 0) from bounds b, app.report_collected(p_owner_id, b.last_start, b.last_same_day)),
      'invoiced_this_month', (select coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT'), 0)
                              from bounds b, app.report_invoice_lines(p_owner_id, b.this_start, p_today)),
      'invoiced_last_month', (select coalesce(sum(amount_cents) filter (where kind <> 'PAID_CREDIT'), 0)
                              from bounds b, app.report_invoice_lines(p_owner_id, b.last_start, b.last_end)),
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
         from bounds b, app.report_invoice_lines(p_owner_id, (b.this_start - interval '2 months')::date, p_today) l
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

create or replace function app.report_invoice_lines(p_owner_id uuid, p_from date, p_to date)
returns table (invoice_id uuid, customer_id uuid, machine_id uuid, issued_on date, line_type public.invoice_line_type,
               kind text, amount_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select x.* from (
      select i.id, i.customer_id, i.machine_id, (i.issued_at at time zone 'Asia/Colombo')::date, l.line_type,
             case
               when l.line_type = 'COMMITMENT' then 'COMMITMENT'
               when l.line_type in ('BW_EXCESS', 'COLOUR_EXCESS') then 'EXCESS'
               when l.line_type in ('LATE_FEE', 'ADJUSTMENT') then 'OTHER'
               when c.kind in ('OVERPAYMENT', 'ADVANCE', 'CANCELLED_INVOICE') then 'PAID_CREDIT'
               else 'DISCOUNT'
             end,
             l.amount_cents
      from public.invoices i
      join public.invoice_lines l on l.invoice_id = i.id
      left join public.credits c on c.id = l.credit_id
      where i.owner_id = p_owner_id
        and i.issued_at is not null
        and i.status <> 'CANCELLED'
        and (i.issued_at at time zone 'Asia/Colombo')::date between p_from and p_to
  ) x
  where (select app.report_allowed(p_owner_id));
$$;

create or replace function app.report_collected(p_owner_id uuid, p_from date, p_to date)
returns table (customer_id uuid, on_date date, source text, amount_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select x.* from (
      select p.customer_id, p.paid_on, 'PAYMENT', coalesce(p.accepted_amount_cents, p.amount_cents)
      from public.payments p
      where p.owner_id = p_owner_id and p.status in ('ACCEPTED', 'PARTIAL') and p.paid_on between p_from and p_to
      union all
      select c.customer_id, coalesce(c.received_on, (c.created_at at time zone 'Asia/Colombo')::date), 'ADVANCE', c.amount_cents
      from public.credits c
      where c.owner_id = p_owner_id and c.kind = 'ADVANCE' and c.source_payment_id is null and c.status <> 'VOID'
        and coalesce(c.received_on, (c.created_at at time zone 'Asia/Colombo')::date) between p_from and p_to
      union all
      select d.customer_id, d.occurred_on, 'DEPOSIT_KEPT', d.amount_cents
      from public.deposit_transactions d
      where d.owner_id = p_owner_id and d.kind = 'RETAINED' and d.occurred_on between p_from and p_to
      union all
      select r.customer_id, r.refunded_on, 'REFUND', -r.amount_cents
      from public.credit_refunds r
      where r.owner_id = p_owner_id and r.refunded_on between p_from and p_to
  ) x
  where (select app.report_allowed(p_owner_id));
$$;
