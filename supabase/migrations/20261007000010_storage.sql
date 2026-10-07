-- =============================================================================
-- 0010 Storage: private buckets and policies.
--
-- Paths always start with the tenant:
--   meter-photos   {owner_id}/{ticket_id}/{file}.jpg
--   payment-slips  {owner_id}/{ticket_id}/{file}.{jpg|png|pdf}
--   branding       {owner_id}/{logo|letterhead}.{ext}
-- Files are served only through short-lived signed URLs created by server code.
-- Bucket limits are a backstop; server code also checks size, magic bytes and
-- (for slips) the SHA-256 fingerprint before recording a file.
-- Direct client access is limited to: a customer uploading a meter photo or a slip
-- for their own ticket at the right stage, an owner managing their branding, and
-- reads that match the table rules. Deletes of photos/slips are server-only.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('meter-photos', 'meter-photos', false, 1048576, array['image/jpeg', 'image/webp']),
  ('payment-slips', 'payment-slips', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf']),
  ('branding', 'branding', false, 5242880, array['image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- meter-photos: customer uploads while the ticket is waiting for a reading;
-- only the owning owner can read (spec 6.5). No client update/delete.
-- -----------------------------------------------------------------------------
create policy "meter-photos: customer uploads for own ticket awaiting reading"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'meter-photos'
  and (select app.current_user_role()) = 'CUSTOMER'
  and exists (
    select 1 from public.billing_cycle_tickets t
    where t.owner_id::text = (storage.foldername(objects.name))[1]
      and t.id::text = (storage.foldername(objects.name))[2]
      and t.customer_id = (select app.current_customer_id())
      and t.paused_at is null
      and (t.status = 'METER_REQUESTED'
           or (t.status = 'OVERDUE' and t.status_before_overdue = 'METER_REQUESTED'))
  )
);

create policy "meter-photos: owner reads own tenant"
on storage.objects for select to authenticated
using (
  bucket_id = 'meter-photos'
  and (select app.current_user_role()) = 'OWNER'
  and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
);

-- -----------------------------------------------------------------------------
-- payment-slips: customer uploads while the ticket is waiting for payment;
-- customer reads own, owner reads tenant, admin reads all.
-- -----------------------------------------------------------------------------
create policy "payment-slips: customer uploads for own ticket awaiting payment"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'payment-slips'
  and (select app.current_user_role()) = 'CUSTOMER'
  and exists (
    select 1 from public.billing_cycle_tickets t
    where t.owner_id::text = (storage.foldername(objects.name))[1]
      and t.id::text = (storage.foldername(objects.name))[2]
      and t.customer_id = (select app.current_customer_id())
      and t.paused_at is null
      and (t.status in ('AWAITING_PAYMENT', 'PARTIALLY_PAID')
           or (t.status = 'OVERDUE' and t.status_before_overdue in ('AWAITING_PAYMENT', 'PARTIALLY_PAID', 'REOPENED')))
  )
);

create policy "payment-slips: read by customer, owner, admin"
on storage.objects for select to authenticated
using (
  bucket_id = 'payment-slips'
  and (
    (select app.is_admin())
    or ((select app.current_user_role()) = 'OWNER'
        and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text)
    or exists (
      select 1 from public.billing_cycle_tickets t
      where t.owner_id::text = (storage.foldername(objects.name))[1]
        and t.id::text = (storage.foldername(objects.name))[2]
        and t.customer_id = (select app.current_customer_id())
    )
  )
);

-- -----------------------------------------------------------------------------
-- branding: owner manages own prefix; that owner's customers and admin read.
-- -----------------------------------------------------------------------------
create policy "branding: read by tenant and admin"
on storage.objects for select to authenticated
using (
  bucket_id = 'branding'
  and (
    (select app.is_admin())
    or (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
  )
);

create policy "branding: owner uploads to own prefix"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'branding'
  and (select app.current_user_role()) = 'OWNER'
  and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
);

create policy "branding: owner updates own prefix"
on storage.objects for update to authenticated
using (
  bucket_id = 'branding'
  and (select app.current_user_role()) = 'OWNER'
  and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
)
with check (
  bucket_id = 'branding'
  and (select app.current_user_role()) = 'OWNER'
  and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
);

create policy "branding: owner deletes own prefix"
on storage.objects for delete to authenticated
using (
  bucket_id = 'branding'
  and (select app.current_user_role()) = 'OWNER'
  and (storage.foldername(objects.name))[1] = (select app.current_owner_id())::text
);
