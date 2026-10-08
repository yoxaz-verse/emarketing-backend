# Production SQL runbook

The `current` directory contains the scripts that must match the running application. The `archive` directory preserves previously applied, bootstrap, seed, cleanup, and superseded migrations for audit and disaster recovery. Do not run the archive as a batch against an existing production database.

## Run now on the current production database

Run these files in Supabase SQL Editor in this order:

1. `current/20260906_unified_communications.sql`
2. `current/20260915_atomic_campaign_delete.sql`
3. `current/20260917_verify_and_repair_production_schema.sql`
4. `current/20261008_campaign_dynamic_fields.sql`
5. `current/20261009_reply_capture_rebuild.sql`

The first four scripts are rerunnable schema repairs. The fifth creates durable reply-capture cursors and performs one guarded reply-history reset; its destructive block executes only once for its reset key. Disable reply capture before applying it, deploy the matching backend, configure `REPLY_CAPTURE_IMAP_HOST=chocobo.mxrouting.net`, port `993`, TLS enabled, and then re-enable capture.

Expected final results:

- The communication queue, item, conversation, message, read, and state tables exist.
- Campaign deletion RPC functions exist.
- Social publish jobs have `social_publish_jobs_due_idx`; provider outcome columns are already present.
- `social_connectors_code_check` permits `meta`, `facebook`, `instagram`, `linkedin`, `reddit`, `telegram`, and `whatsapp`.
- `social_oauth_states.requested_platform` exists and PostgREST reloads its schema cache.
- Facebook and Instagram connector rows exist while the legacy Meta row is retained.
- Scheduled requests have `updated_at`, and required functions and indexes pass the final audit.
- Campaign dynamic-field mappings are stored with reviewed sequence signatures.
- Reply capture resumes from a durable per-inbox UID cursor and rebuilds only the configured backfill window.

## Review before cleanup

Run `review/20261008_schema_cleanup_audit.sql` separately. It is read-only and reports missing runtime tables, row counts for apparently unreferenced tables, population of candidate columns, and foreign-key dependencies. See `SCHEMA_AUDIT_20261008.md` for the evidence and limitations. It is not part of the upgrade sequence.

## Archived migrations

Archived files are not obsolete database history. Use a specific archived bootstrap or feature migration only when provisioning or repairing an environment that is missing that feature. In particular, do not rerun `archive/20260618_fix_social_app_oauth_schema.sql` on the supplied production schema because its core social tables are already present.

After running the current scripts, confirm the verification query returns zero missing objects, deploy or restart the backend, test campaign dynamic-field mapping and launch, and verify LinkedIn, Facebook, and Instagram authorization from Social Connectors.
