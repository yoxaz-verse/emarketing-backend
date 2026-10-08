# Production schema audit — 2026-10-08

Source: the schema-only export supplied on 2026-10-08. Because that export omits functions, triggers, policies, and some indexes, absence of those object types was treated as unknown rather than proof that they do not exist.

## Run now

Run only the files listed in `README.md`, in that exact order. Communications and campaign-deletion remain in the run list because their functions and triggers cannot be verified from the supplied table-only export. The production verifier is required because `social_publish_requests.updated_at` is absent. Campaign dynamic fields are new and absent.

## Moved to archive

- `20260915_repair_social_publish_job_outcomes.sql`: both provider outcome columns are present; the remaining index is recreated by the verifier.
- `20260916_align_social_connector_schema.sql`: the seven connector codes and `social_oauth_states.requested_platform` are present.

Archived scripts remain historical records and must not be batch-run against production.

## Runtime/schema gaps

Active services reference tables absent from the export: agent chat/context/memory tables, blog platform publishing tables, campaign voice-agent links, analytics aggregates, inquiry event tables, lead sequence assignments, password reset tokens, sequence run tables, and voice agents. `campaign_merge_mappings` is expected to be absent until the new migration runs.

These gaps may mean the export is incomplete, optional features have never been provisioned, or those features currently fail. Do not invent or drop schemas based only on their absence. Run `review/20261008_schema_cleanup_audit.sql`, then restore each confirmed missing feature from its owning schema contract in a separate migration.

## Removal candidates—not approved for deletion

No direct runtime reference was found for these tables: `agent_integrations_archive`, `agent_task_integration_links_archive`, `campaign_channels`, `lead_folder_memberships`, `voice_events`, and `warmup_schedule`.

The only low-signal columns with no source reference were `campaign_leads.locked_at` and `voice_calls.ended_at`. The latter is semantically important call history and should be retained unless the Voice Engine owner confirms otherwise. SQL-only fields used by communications functions are not candidates.

No destructive SQL is included. Row counts, data population, foreign-key dependencies, external consumers, retention requirements, and rollback/export steps must be reviewed before approving a removal migration.
