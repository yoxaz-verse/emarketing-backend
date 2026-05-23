# emailmarketing-backend

## Local Runbook (Campaign Inbox Assignment)

1. Start backend on port `3004`:
```bash
cd Backend
npm run start
```

2. Verify backend is reachable:
```bash
curl http://localhost:3004/ping
```
Expected response includes `ok: true`.

3. If dashboard shows backend offline while saving inboxes:
```bash
lsof -nP -iTCP:3004 -sTCP:LISTEN
```
If no process is listening, restart backend with `npm run start`.

## Reply/Open Tracking Recovery (MXroute)

If replies/open metrics show empty or zero while real mail activity exists:

1. Apply DB patch in Supabase SQL editor:
   - `Backend/sql/20260522_reply_open_tracking_recovery.sql`
2. Restart backend.
3. Verify worker health:
```bash
curl http://localhost:3004/execution/system/reply-capture-health
```
Expected:
- `running: true`
- `stale: false`
- per inbox `connect_ok/auth_ok/mailbox_open_ok: true`

## OpenClaw Task Queue (Task-Creator-Only)

### Required backend env vars
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENCLAW_WORKER_SECRET`

### CapRover setup for worker secret
1. Open CapRover dashboard.
2. Navigate to backend app -> App Configs -> Environmental Variables.
3. Add `OPENCLAW_WORKER_SECRET=<strong-random-secret>`.
4. Save and redeploy backend.

### Local worker runbook
See `/openclaw-worker/README.md` for setup/run instructions targeting `~/openclaw-worker`.

### Persistent Agent Missions (Employee Agents)

Apply migration:

- `Backend/migrations/20260516_add_agent_missions.sql`

This enables:

- reusable mission contracts per agent
- scheduler-driven task dispatch into `agent_tasks`
- mission run audit logs (`agent_mission_runs`)
- Running Agents runtime controls (run now / pause / resume)

### Fix: `type` NOT NULL mismatch on `agent_tasks`

If Agent Integrations page shows:
`null value in column "type" of relation "agent_tasks" violates not-null constraint`

Apply this migration in your cloud Supabase SQL editor:

- `Backend/migrations/20260516_normalize_agent_tasks_type_to_task_type.sql`

Then restart backend so runtime/schema caches refresh.

## Delivered Metric Guardrail (No More False-Zero Loop)

Use this one command against production API to verify the right backend/runtime is active and returning the delivery invariant payload:

```bash
curl -sS -H "Authorization: Bearer <auth_token>" \
  "$NEXT_PUBLIC_API_BASE_URL/campaigns/<campaign_id>/reply-open-analytics" \
  | jq '{analytics_version, sent, delivered, opened, bounced_total, pending_outcome, diagnostics: {delivery_invariant_applied, delivered_confirmed, delivered_inferred, delivered_promoted_from_open_reply, unmatched_events_count}}'
```

Expected guardrail checks:
- `analytics_version` is `"delivery_invariant_v2"`
- diagnostics include `delivery_invariant_applied`, `delivered_confirmed`, `delivered_inferred`, `delivered_promoted_from_open_reply`
- if `sent > 0`, `opened > 0`, and `bounced_total = 0`, then `delivered` should not remain `0`

If any guardrail field is missing, treat deployment as stale or API base misconfigured and verify dashboard `NEXT_PUBLIC_API_BASE_URL` points to the intended backend runtime.

## Outlook Junk Placement Runbook (Cold Outreach)

If mail lands in Outlook Junk, use this playbook before scaling volume:

1. Sender auth gates
   - Ensure `spf_verified`, `dkim_verified`, and `dmarc_verified` are all true for sending domain records.
   - Pause inboxes/domains that fail auth checks.

2. Warmup and health gates
   - Keep inbox warmup enabled and respect warmup limits.
   - Do not ramp volume sharply; increase gradually across days.

3. Microsoft-first touch controls
   - Use conservative ramps for Outlook/Hotmail/Live/MSN cohorts.
   - Prefer first-touch minimal tracking (no open pixel and no tracked-link rewriting).
   - Aim for early positive engagement (replies, trusted sender interactions) before scaling.

4. Audience hygiene
   - Start with cleaner leads (avoid risky/unknown cohorts in wave 1).
   - Remove repeat non-engagers and pause domains with repeated bounce/complaint signals.

### Remove Queue Integration Stack (archive then drop)

If you want task-creator-only flow with no `agent_integrations` usage:

- Apply migration:
  - `Backend/migrations/20260516_archive_and_remove_agent_integrations.sql`
- Or run standalone cloud SQL:
  - `sql/remove_agent_integrations_stack.sql`

This will archive existing integration data, then remove:
- `agent_integrations` table
- `agent_tasks.integration_id` column + FK/index

## Production Auth Secret Rotation Runbook (`JWT_SECRET`)

When rotating `JWT_SECRET` in production, old browser cookies contain tokens signed by the previous secret and will fail with `invalid signature`.

### Required steps
1. Set a single canonical `JWT_SECRET` in CapRover backend env.
2. Ensure all running backend instances use the same env/version.
3. Restart backend deployment.
4. Force logout flow for users once:
   - ask users to hit `/api/auth/logout` or
   - clear cookies `auth_token`, `user_role`, `operator_id`.
5. Users log in again to receive a token signed by the new secret.

### Verification checklist
- Backend boot logs do not show missing JWT secret.
- `/auth/me` succeeds after fresh login.
- Repeated `[requireAuthLite] Token verification failed: invalid signature` stops for fresh sessions.

## Inquiry Fetching Schema Bootstrap

If Inquiry Fetching shows errors such as:
- `Could not find the table 'public.inquiry_fetch_runs' in the schema cache`
- `DB seed missing or unavailable. Showing fallback source catalog.`

Apply DB patch in Supabase SQL editor:
- `Backend/sql/20260523_inquiry_pipeline_bootstrap.sql`

Then restart backend so runtime/schema caches refresh.
