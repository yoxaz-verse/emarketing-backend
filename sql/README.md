# Production SQL runbook

The `current` directory contains the scripts that must match the running application. The `archive` directory preserves previously applied, bootstrap, seed, cleanup, and superseded migrations for audit and disaster recovery. Do not run the archive as a batch against an existing production database.

## Run now on the current production database

Run these files in Supabase SQL Editor in this order:

1. `current/20260906_unified_communications.sql`
2. `current/20260915_atomic_campaign_delete.sql`
3. `current/20260915_repair_social_publish_job_outcomes.sql`
4. `current/20260916_align_social_connector_schema.sql`
5. `current/20260917_verify_and_repair_production_schema.sql`

All five scripts are designed to be rerunnable. The fourth script replaces the failed `20260915_split_meta_channels.sql`; do not run the archived version again. The fifth repairs objects omitted from table-only schema exports and finishes with an audit query. Its missing-object result must contain zero rows.

Expected final results:

- The communication queue, item, conversation, message, read, and state tables exist.
- Campaign deletion RPC functions exist.
- Social publish jobs have provider outcome columns and `social_publish_jobs_due_idx`.
- `social_connectors_code_check` permits `meta`, `facebook`, `instagram`, `linkedin`, `reddit`, `telegram`, and `whatsapp`.
- `social_oauth_states.requested_platform` exists and PostgREST reloads its schema cache.
- Facebook and Instagram connector rows exist while the legacy Meta row is retained.
- Scheduled requests have `updated_at`, and required functions and indexes pass the final audit.

## Archived migrations

Archived files are not obsolete database history. Use a specific archived bootstrap or feature migration only when provisioning or repairing an environment that is missing that feature. In particular, do not rerun `archive/20260618_fix_social_app_oauth_schema.sql` on the supplied production schema because its core social tables are already present.

After running the current scripts, deploy or restart the backend and verify LinkedIn, Facebook, and Instagram authorization from Social Connectors.
