-- =============================================================================
-- 0009 Grants and row-level security.
--
-- Project settings: "Automatically expose new tables" is OFF (so every grant below
-- is explicit) and "Automatic RLS" is ON (RLS is also enabled explicitly here).
--
-- Model
--   anon           nothing at all.
--   authenticated  SELECT on business tables, filtered by RLS; INSERT/UPDATE only on
--                  the few owner/admin-editable tables listed below, column-limited.
--                  No DELETE anywhere except an owner's own notification templates.
--   service_role   everything (server code). audit_logs is append-only even for it.
--
-- Policies only call the four read helpers (app.current_user_role, current_owner_id,
-- current_customer_id, is_admin). They return NULL for suspended/deactivated users
-- and for customers of a suspended owner, so those users match no policy.
-- Helpers are wrapped in (select ...) so Postgres evaluates them once per query.
--
-- SERVER-WRITE-ONLY tables (no client write grants): profiles, owners, customers
-- (insert), subscription_plans, billing_cycle_tickets, ticket_events, ticket_comments,
-- meter_submissions, meter_readings, meter_photos, invoices, invoice_lines,
-- invoice_counters, payments, payment_slips, disputes, credits, service_requests,
-- service_request_history, notifications (insert), idempotency_keys, login_attempts,
-- audit_logs.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Schema / function privileges
-- -----------------------------------------------------------------------------
revoke all on schema app from public, anon, authenticated;
grant usage on schema app to authenticated, service_role;

revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function
  app.current_user_role(),
  app.current_owner_id(),
  app.current_customer_id(),
  app.is_admin()
to authenticated;
grant execute on all functions in schema app to service_role;

-- -----------------------------------------------------------------------------
-- Table privileges
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke update, delete, truncate on public.audit_logs from service_role;

grant select on
  public.profiles,
  public.owners,
  public.owner_company_profiles,
  public.customers,
  public.subscription_plans,
  public.platform_settings,
  public.owner_settings,
  public.owner_settings_effective,
  public.machines,
  public.rental_agreements,
  public.meter_baselines,
  public.billing_cycle_tickets,
  public.ticket_events,
  public.ticket_comments,
  public.meter_submissions,
  public.meter_readings,
  public.meter_photos,
  public.invoices,
  public.invoice_lines,
  public.invoice_counters,
  public.payments,
  public.payment_slips,
  public.disputes,
  public.credits,
  public.service_requests,
  public.service_request_history,
  public.notifications,
  public.notification_templates,
  public.audit_logs
to authenticated;
-- Deliberately no grants to authenticated: login_attempts, idempotency_keys.

-- Owner: company profile / branding (onboarding_completed_at is server-set).
grant insert (owner_id, company_name, logo_path, address, phone, email, bank_name, bank_branch,
              bank_account_name, bank_account_no, letterhead_path, letterhead_layout),
      update (company_name, logo_path, address, phone, email, bank_name, bank_branch,
              bank_account_name, bank_account_no, letterhead_path, letterhead_layout)
  on public.owner_company_profiles to authenticated;

-- Owner: own settings overrides. Admin: global defaults.
grant insert (owner_id, default_cycle_length_days, meter_deadline_days, meter_reminder_days,
              review_deadline_hours, review_reminder_hours, review_escalation_hours, payment_due_days,
              payment_reminder_before_days, payment_reminder_on_due, payment_overdue_reminder_days,
              slip_review_deadline_hours, slip_review_reminder_hours, slip_review_escalation_hours,
              max_meter_rejections, rejected_photo_retention_days, payment_slip_retention_days,
              grace_period_days, late_fee_enabled, late_fee_cents, estimated_billing_enabled,
              service_ack_hours_urgent, service_ack_hours_normal, service_admin_escalation_hours_urgent,
              service_admin_escalation_hours_normal, weekly_summary_dow),
      update (default_cycle_length_days, meter_deadline_days, meter_reminder_days,
              review_deadline_hours, review_reminder_hours, review_escalation_hours, payment_due_days,
              payment_reminder_before_days, payment_reminder_on_due, payment_overdue_reminder_days,
              slip_review_deadline_hours, slip_review_reminder_hours, slip_review_escalation_hours,
              max_meter_rejections, rejected_photo_retention_days, payment_slip_retention_days,
              grace_period_days, late_fee_enabled, late_fee_cents, estimated_billing_enabled,
              service_ack_hours_urgent, service_ack_hours_normal, service_admin_escalation_hours_urgent,
              service_admin_escalation_hours_normal, weekly_summary_dow)
  on public.owner_settings to authenticated;
grant update (default_cycle_length_days, meter_deadline_days, meter_reminder_days,
              review_deadline_hours, review_reminder_hours, review_escalation_hours, payment_due_days,
              payment_reminder_before_days, payment_reminder_on_due, payment_overdue_reminder_days,
              slip_review_deadline_hours, slip_review_reminder_hours, slip_review_escalation_hours,
              max_meter_rejections, rejected_photo_retention_days, payment_slip_retention_days,
              grace_period_days, late_fee_enabled, late_fee_cents, estimated_billing_enabled,
              service_ack_hours_urgent, service_ack_hours_normal, service_admin_escalation_hours_urgent,
              service_admin_escalation_hours_normal, weekly_summary_dow)
  on public.platform_settings to authenticated;

-- Owner: customer contact details (account creation and status are server-side).
grant update (name, business_name, phone, email, address) on public.customers to authenticated;

-- Owner: machines.
grant insert (owner_id, brand, model, serial_no, type, status, purchase_date,
              bw_counter_max, colour_counter_max, notes),
      update (brand, model, serial_no, status, purchase_date, bw_counter_max, colour_counter_max, notes)
  on public.machines to authenticated;

-- Owner: agreements. The cycle calendar (next_cycle_*) and start/initial readings
-- are not client-editable once created.
grant insert (owner_id, customer_id, machine_id, status, start_date, end_date, cycle_length_days,
              billing_day, due_days, monthly_commitment_cents, bw_included, bw_rate_cents,
              colour_included, colour_rate_cents, installation_location,
              initial_bw_reading, initial_colour_reading),
      update (status, end_date, cycle_length_days, billing_day, due_days, monthly_commitment_cents,
              bw_included, bw_rate_cents, colour_included, colour_rate_cents, installation_location,
              closing_bw_reading, closing_colour_reading, termination_reason)
  on public.rental_agreements to authenticated;

-- Owner: meter baselines (recorded_by defaults to auth.uid()).
grant insert (owner_id, agreement_id, counter_type, value, reason) on public.meter_baselines to authenticated;

-- Everyone: mark own notifications read.
grant update (read_at) on public.notifications to authenticated;

-- Admin (global) / owner (own overrides): notification templates.
grant insert (owner_id, event, channel, locale, subject, body),
      update (subject, body),
      delete
  on public.notification_templates to authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere (idempotent with "Automatic RLS").
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.owners enable row level security;
alter table public.owner_company_profiles enable row level security;
alter table public.customers enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.platform_settings enable row level security;
alter table public.owner_settings enable row level security;
alter table public.login_attempts enable row level security;
alter table public.machines enable row level security;
alter table public.rental_agreements enable row level security;
alter table public.meter_baselines enable row level security;
alter table public.billing_cycle_tickets enable row level security;
alter table public.ticket_events enable row level security;
alter table public.ticket_comments enable row level security;
alter table public.meter_submissions enable row level security;
alter table public.meter_readings enable row level security;
alter table public.meter_photos enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.payments enable row level security;
alter table public.payment_slips enable row level security;
alter table public.disputes enable row level security;
alter table public.credits enable row level security;
alter table public.service_requests enable row level security;
alter table public.service_request_history enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_templates enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.audit_logs enable row level security;
-- login_attempts and idempotency_keys have no policies: only service_role (which
-- bypasses RLS) can touch them.

-- -----------------------------------------------------------------------------
-- Accounts
-- -----------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or id = (select app.current_customer_id())
);

-- Owners see themselves; customers see their own owner's business details.
create policy owners_select on public.owners for select to authenticated using (
  (select app.is_admin())
  or id = (select app.current_owner_id())
);

-- Customers read their owner's branding (logo, company details on invoices).
create policy owner_company_profiles_select on public.owner_company_profiles for select to authenticated using (
  (select app.is_admin())
  or owner_id = (select app.current_owner_id())
);
create policy owner_company_profiles_insert on public.owner_company_profiles for insert to authenticated with check (
  (select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id())
);
create policy owner_company_profiles_update on public.owner_company_profiles for update to authenticated
using ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
with check ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()));

create policy customers_select on public.customers for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or id = (select app.current_customer_id())
);
create policy customers_update on public.customers for update to authenticated
using ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
with check ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()));

create policy subscription_plans_select on public.subscription_plans for select to authenticated using (
  (select app.current_user_role()) is not null
);

create policy platform_settings_select on public.platform_settings for select to authenticated using (
  (select app.current_user_role()) is not null
);
create policy platform_settings_update on public.platform_settings for update to authenticated
using ((select app.is_admin()))
with check ((select app.is_admin()));

create policy owner_settings_select on public.owner_settings for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);
create policy owner_settings_insert on public.owner_settings for insert to authenticated with check (
  (select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id())
);
create policy owner_settings_update on public.owner_settings for update to authenticated
using ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
with check ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()));

-- -----------------------------------------------------------------------------
-- Machines and agreements
-- -----------------------------------------------------------------------------
create policy machines_select on public.machines for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or exists (
    select 1 from public.rental_agreements a
    where a.machine_id = machines.id and a.customer_id = (select app.current_customer_id())
  )
);
create policy machines_insert on public.machines for insert to authenticated with check (
  (select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id())
);
create policy machines_update on public.machines for update to authenticated
using ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
with check ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()));

create policy rental_agreements_select on public.rental_agreements for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);
create policy rental_agreements_insert on public.rental_agreements for insert to authenticated with check (
  (select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id())
);
create policy rental_agreements_update on public.rental_agreements for update to authenticated
using ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
with check ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()));

create policy meter_baselines_select on public.meter_baselines for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);
create policy meter_baselines_insert on public.meter_baselines for insert to authenticated with check (
  (select app.current_user_role()) = 'OWNER'
  and owner_id = (select app.current_owner_id())
  and recorded_by = (select auth.uid())
);

-- -----------------------------------------------------------------------------
-- Billing cycle (read-only for clients)
-- -----------------------------------------------------------------------------
create policy billing_cycle_tickets_select on public.billing_cycle_tickets for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);

create policy ticket_events_select on public.ticket_events for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or exists (
    select 1 from public.billing_cycle_tickets t
    where t.id = ticket_events.ticket_id and t.customer_id = (select app.current_customer_id())
  )
);

create policy ticket_comments_select on public.ticket_comments for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or exists (
    select 1 from public.billing_cycle_tickets t
    where t.id = ticket_comments.ticket_id and t.customer_id = (select app.current_customer_id())
  )
);

create policy meter_submissions_select on public.meter_submissions for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);

create policy meter_readings_select on public.meter_readings for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or exists (
    select 1 from public.meter_submissions s
    where s.id = meter_readings.submission_id and s.customer_id = (select app.current_customer_id())
  )
);

-- Spec 6.5: photo access is limited to the owning owner (customers never read photo rows).
create policy meter_photos_select on public.meter_photos for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);

-- Customers never see DRAFT or REJECTED invoices (spec 6.6).
create policy invoices_select on public.invoices for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or (customer_id = (select app.current_customer_id()) and status not in ('DRAFT', 'REJECTED'))
);

create policy invoice_lines_select on public.invoice_lines for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or exists (
    select 1 from public.invoices i
    where i.id = invoice_lines.invoice_id
      and i.customer_id = (select app.current_customer_id())
      and i.status not in ('DRAFT', 'REJECTED')
  )
);

create policy invoice_counters_select on public.invoice_counters for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);

-- -----------------------------------------------------------------------------
-- Payments (read-only for clients)
-- -----------------------------------------------------------------------------
create policy payments_select on public.payments for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);

create policy payment_slips_select on public.payment_slips for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or exists (
    select 1 from public.payments p
    where p.id = payment_slips.payment_id and p.customer_id = (select app.current_customer_id())
  )
);

create policy disputes_select on public.disputes for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);

create policy credits_select on public.credits for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);

-- -----------------------------------------------------------------------------
-- Service requests (read-only for clients)
-- -----------------------------------------------------------------------------
create policy service_requests_select on public.service_requests for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or customer_id = (select app.current_customer_id())
);

create policy service_request_history_select on public.service_request_history for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or exists (
    select 1 from public.service_requests r
    where r.id = service_request_history.request_id and r.customer_id = (select app.current_customer_id())
  )
);

-- -----------------------------------------------------------------------------
-- Notifications, templates, audit
-- -----------------------------------------------------------------------------
-- Own notifications; owners also see their tenant's delivery log; admin sees all (NOT-05).
create policy notifications_select on public.notifications for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
  or (user_id = (select auth.uid()) and (select app.current_user_role()) is not null)
);
create policy notifications_update_own on public.notifications for update to authenticated
using (user_id = (select auth.uid()) and (select app.current_user_role()) is not null)
with check (user_id = (select auth.uid()) and (select app.current_user_role()) is not null);

create policy notification_templates_select on public.notification_templates for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER'
      and (owner_id is null or owner_id = (select app.current_owner_id())))
);
create policy notification_templates_insert on public.notification_templates for insert to authenticated with check (
  ((select app.is_admin()) and owner_id is null)
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);
create policy notification_templates_update on public.notification_templates for update to authenticated
using (
  ((select app.is_admin()) and owner_id is null)
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
)
with check (
  ((select app.is_admin()) and owner_id is null)
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);
create policy notification_templates_delete on public.notification_templates for delete to authenticated using (
  ((select app.is_admin()) and owner_id is null)
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);

create policy audit_logs_select on public.audit_logs for select to authenticated using (
  (select app.is_admin())
  or ((select app.current_user_role()) = 'OWNER' and owner_id = (select app.current_owner_id()))
);
