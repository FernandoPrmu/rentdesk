-- =============================================================================
-- 0012 public.rpc_* wrappers for the server-only workflow functions.
--
-- The `app` schema stays private (not exposed through the Data API). Server code
-- calls these thin wrappers with the service-role client: supabase.rpc('rpc_...').
-- Each wrapper only forwards to the app.* function, which does all checks and
-- writes in one transaction. SECURITY INVOKER: they run as the caller, and only
-- service_role may execute them (and holds EXECUTE on app.*).
-- =============================================================================

-- New functions in public must not be executable by anon/authenticated by default.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

create function public.rpc_open_billing_cycle(
  p_agreement_id uuid,
  p_cycle_no integer,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.open_billing_cycle(p_agreement_id, p_cycle_no, p_stage_due_at, p_notifications);
$$;

create function public.rpc_transition_ticket(
  p_ticket_id uuid,
  p_from public.ticket_status,
  p_to public.ticket_status,
  p_actor_id uuid,
  p_reason text default null,
  p_stage_due_at timestamptz default null,
  p_invoice_status public.invoice_status default null,
  p_event_type public.ticket_event_type default 'STATUS_CHANGE',
  p_metadata jsonb default '{}'::jsonb,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.transition_ticket(p_ticket_id, p_from, p_to, p_actor_id, p_reason, p_stage_due_at,
                               p_invoice_status, p_event_type, p_metadata, p_notifications);
$$;

create function public.rpc_submit_meter_reading(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_source public.reading_source,
  p_readings jsonb,
  p_photo jsonb,
  p_invoice jsonb,
  p_stage_due_at timestamptz,
  p_note text default null,
  p_anomaly_flag text default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.submit_meter_reading(p_ticket_id, p_actor_id, p_idempotency_key, p_source, p_readings,
                                  p_photo, p_invoice, p_stage_due_at, p_note, p_anomaly_flag, p_notifications);
$$;

create function public.rpc_confirm_meter_submission(
  p_ticket_id uuid,
  p_submission_id uuid,
  p_actor_id uuid,
  p_due_date date,
  p_stage_due_at timestamptz,
  p_branding_snapshot jsonb default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.confirm_meter_submission(p_ticket_id, p_submission_id, p_actor_id, p_due_date,
                                      p_stage_due_at, p_branding_snapshot, p_notifications);
$$;

create function public.rpc_reject_meter_submission(
  p_ticket_id uuid,
  p_submission_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_stage_due_at timestamptz,
  p_photo_expires_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.reject_meter_submission(p_ticket_id, p_submission_id, p_actor_id, p_reason,
                                     p_stage_due_at, p_photo_expires_at, p_notifications);
$$;

create function public.rpc_submit_payment(
  p_ticket_id uuid,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_source public.payment_source,
  p_payment jsonb,
  p_slip jsonb,
  p_stage_due_at timestamptz,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.submit_payment(p_ticket_id, p_actor_id, p_idempotency_key, p_source, p_payment,
                            p_slip, p_stage_due_at, p_notifications);
$$;

create function public.rpc_verify_payment(
  p_ticket_id uuid,
  p_payment_id uuid,
  p_actor_id uuid,
  p_accept boolean,
  p_accepted_amount_cents bigint default null,
  p_reason text default null,
  p_stage_due_at timestamptz default null,
  p_notifications jsonb default '[]'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.verify_payment(p_ticket_id, p_payment_id, p_actor_id, p_accept, p_accepted_amount_cents,
                            p_reason, p_stage_due_at, p_notifications);
$$;

create function public.rpc_assign_invoice_number(p_invoice_id uuid) returns text
language sql
set search_path = ''
as $$
  select app.assign_invoice_number(p_invoice_id);
$$;

create function public.rpc_provision_account(
  p_user_id uuid,
  p_role public.user_role,
  p_username text,
  p_full_name text,
  p_owner_id uuid,
  p_created_by uuid,
  p_must_change_password boolean default true,
  p_details jsonb default '{}'::jsonb
) returns jsonb
language sql
set search_path = ''
as $$
  select app.provision_account(p_user_id, p_role, p_username, p_full_name, p_owner_id,
                               p_created_by, p_must_change_password, p_details);
$$;

create function public.rpc_write_audit(
  p_actor_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid default null,
  p_owner_id uuid default null,
  p_details jsonb default '{}'::jsonb
) returns void
language sql
set search_path = ''
as $$
  select app.write_audit(p_actor_id, p_action, p_entity, p_entity_id, p_owner_id, p_details);
$$;

-- Only the service role may execute the wrappers.
revoke execute on function
  public.rpc_open_billing_cycle(uuid, integer, timestamptz, jsonb),
  public.rpc_transition_ticket(uuid, public.ticket_status, public.ticket_status, uuid, text, timestamptz,
                               public.invoice_status, public.ticket_event_type, jsonb, jsonb),
  public.rpc_submit_meter_reading(uuid, uuid, uuid, public.reading_source, jsonb, jsonb, jsonb, timestamptz,
                                  text, text, jsonb),
  public.rpc_confirm_meter_submission(uuid, uuid, uuid, date, timestamptz, jsonb, jsonb),
  public.rpc_reject_meter_submission(uuid, uuid, uuid, text, timestamptz, timestamptz, jsonb),
  public.rpc_submit_payment(uuid, uuid, uuid, public.payment_source, jsonb, jsonb, timestamptz, jsonb),
  public.rpc_verify_payment(uuid, uuid, uuid, boolean, bigint, text, timestamptz, jsonb),
  public.rpc_assign_invoice_number(uuid),
  public.rpc_provision_account(uuid, public.user_role, text, text, uuid, uuid, boolean, jsonb),
  public.rpc_write_audit(uuid, text, text, uuid, uuid, jsonb)
from public, anon, authenticated;

grant execute on function
  public.rpc_open_billing_cycle(uuid, integer, timestamptz, jsonb),
  public.rpc_transition_ticket(uuid, public.ticket_status, public.ticket_status, uuid, text, timestamptz,
                               public.invoice_status, public.ticket_event_type, jsonb, jsonb),
  public.rpc_submit_meter_reading(uuid, uuid, uuid, public.reading_source, jsonb, jsonb, jsonb, timestamptz,
                                  text, text, jsonb),
  public.rpc_confirm_meter_submission(uuid, uuid, uuid, date, timestamptz, jsonb, jsonb),
  public.rpc_reject_meter_submission(uuid, uuid, uuid, text, timestamptz, timestamptz, jsonb),
  public.rpc_submit_payment(uuid, uuid, uuid, public.payment_source, jsonb, jsonb, timestamptz, jsonb),
  public.rpc_verify_payment(uuid, uuid, uuid, boolean, bigint, text, timestamptz, jsonb),
  public.rpc_assign_invoice_number(uuid),
  public.rpc_provision_account(uuid, public.user_role, text, text, uuid, uuid, boolean, jsonb),
  public.rpc_write_audit(uuid, text, text, uuid, uuid, jsonb)
to service_role;
