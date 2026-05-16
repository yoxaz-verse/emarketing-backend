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

## OpenClaw Queue Integration

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
