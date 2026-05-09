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
