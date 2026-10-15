-- Backup manifest (docs/backup-restore.md): what a dump contains, to compare after a
-- restore. One line per table: schema.table <tab> row count; then the last migration.
-- Counts only: no personal data. Run with: psql "$URL" -At -F $'\t' -f scripts/backup/manifest.sql
select format('%I.%I', t.table_schema, t.table_name) as "table",
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text as "rows"
from information_schema.tables t
where t.table_schema in ('public', 'app', 'auth', 'storage', 'supabase_migrations')
  and t.table_type = 'BASE TABLE'
order by 1;
select 'last_migration', coalesce(max(version), 'none') from supabase_migrations.schema_migrations;
