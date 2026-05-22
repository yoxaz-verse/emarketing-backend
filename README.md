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
