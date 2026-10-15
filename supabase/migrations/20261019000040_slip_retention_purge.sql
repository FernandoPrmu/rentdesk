-- Task 12: payment slip retention purge (decision 91) and a tighter meter-photo bucket.
--
-- Slips are kept for `payment_slip_retention_days` (platform default 2,555 days = 7
-- years; the admin edits it in Admin › Settings, 30-3,650 days, decision 82; an owner
-- override in owner_settings applies when set). After that the daily job deletes the
-- FILE only. The payment_slips row stays (amount, reference, SHA-256 for duplicate
-- detection, who uploaded it and when) with `file_deleted_at`, and every purge writes
-- an audit entry. The setting in force on the day of the purge decides (counted from
-- the upload date in Asia/Colombo), so an admin change applies to every slip; a slip
-- whose payment still waits for the owner's check is never purged.

alter table public.payment_slips add column file_deleted_at timestamptz;

comment on column public.payment_slips.file_deleted_at is
  'When the daily job deleted the slip file after the retention period (decision 91). The row is kept.';
comment on column public.payment_slips.retention_until is
  'The retention end computed at upload. Informational: the purge uses the setting in force on the day (decision 91).';

create index payment_slips_retention_idx on public.payment_slips (uploaded_at) where file_deleted_at is null;

-- Slips whose retention has passed, oldest first.
create function app.cron_expired_slips(p_now timestamptz, p_limit integer) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'storage_path', x.storage_path) order by x.uploaded_at, x.id), '[]'::jsonb)
  from (
    select s.id, s.storage_path, s.uploaded_at
    from public.payment_slips s
    join public.payments p on p.id = s.payment_id and p.owner_id = s.owner_id
    join public.owner_settings_effective e on e.owner_id = s.owner_id
    where s.file_deleted_at is null
      and p.status <> 'SUBMITTED'
      and app.colombo_date(s.uploaded_at) + e.payment_slip_retention_days <= app.colombo_date(p_now)
    order by s.uploaded_at, s.id
    limit greatest(p_limit, 0)
  ) x;
$$;

-- The files are gone (server code removed them): mark the rows and audit each one.
create function app.mark_slips_deleted(p_ids jsonb, p_now timestamptz) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_count integer := 0;
begin
  perform app.set_actor(null);
  for s in
    update public.payment_slips sl
    set file_deleted_at = p_now
    from public.owner_settings_effective e
    where sl.file_deleted_at is null
      and e.owner_id = sl.owner_id
      and sl.id in (select (x #>> '{}')::uuid from jsonb_array_elements(p_ids) x)
    returning sl.id, sl.owner_id, sl.payment_id, sl.uploaded_at, e.payment_slip_retention_days as days
  loop
    perform app.write_audit(null, 'PAYMENT_SLIP_FILE_DELETED', 'payment_slips', s.id, s.owner_id,
      jsonb_build_object('payment_id', s.payment_id, 'uploaded_at', s.uploaded_at, 'retention_days', s.days, 'reason', 'Retention period ended'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function app.cron_expired_slips(timestamptz, integer), app.mark_slips_deleted(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function app.cron_expired_slips(timestamptz, integer), app.mark_slips_deleted(jsonb, timestamptz)
  to service_role;

create function public.rpc_cron_expired_slips(p_now timestamptz, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select app.cron_expired_slips(p_now, p_limit);
$$;

create function public.rpc_mark_slips_deleted(p_ids jsonb, p_now timestamptz) returns integer
language sql set search_path = '' as $$
  select app.mark_slips_deleted(p_ids, p_now);
$$;

revoke execute on function public.rpc_cron_expired_slips(timestamptz, integer), public.rpc_mark_slips_deleted(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.rpc_cron_expired_slips(timestamptz, integer), public.rpc_mark_slips_deleted(jsonb, timestamptz)
  to service_role;

-- Security review (task 12): meter photos are always JPEG (made on the phone, checked by
-- signature on the server, decision 30); the bucket no longer accepts WebP either.
update storage.buckets set allowed_mime_types = array['image/jpeg'] where id = 'meter-photos';
