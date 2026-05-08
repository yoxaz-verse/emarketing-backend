# Auth Login Recovery Runbook

Use this when UI login shows `Invalid credentials` for a known user.

## 1) Verify backend is connected to the expected Supabase project

1. Start backend with `npm run dev` in `Backend/`.
2. Check startup log `[BACKEND_RUNTIME]`.
3. Confirm `supabaseProjectRef` matches your intended Supabase project.

If this does not match, fix `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `Backend/.env`.

## 2) Verify auth user and app user linkage

In Supabase SQL editor:

```sql
select id, email
from auth.users
where lower(email) = lower('admin@obaol.com');
```

```sql
select id, auth_user_id, email, role, active
from public.users
where lower(email) = lower('admin@obaol.com');
```

`public.users.auth_user_id` must match `auth.users.id` and `active` must be `true`.

## 3) Reset password for affected user

Use Supabase Dashboard Auth UI or admin API to set a known password.

## 4) Re-test login

```bash
curl -i http://localhost:3004/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@obaol.com","password":"<known-password>"}'
```

Expected: `200` with `{ token, user }`.

If it fails:
- Backend logs `[AUTH_LOGIN_INVALID_CREDENTIALS]` when Supabase auth fails.
- Backend logs `[AUTH_LOGIN_UNAUTHORIZED_USER]` when auth succeeds but app user is missing/inactive.
