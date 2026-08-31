import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

test('LinkedIn authorize URL includes the configured redirect URI exactly', async () => {
  const { linkedInAuthorizeUrl } = await import('./linkedin.client.js');
  const redirectUri = 'https://emarketing-backend.infra.obaol.com/social/oauth2-credential/callback';
  const authUrl = linkedInAuthorizeUrl('state-value', {
    clientId: 'linkedin-client-id',
    clientSecret: 'linkedin-client-secret',
    redirectUri,
    scopes: ['w_member_social', 'r_liteprofile'],
  });

  const parsed = new URL(authUrl);
  assert.equal(parsed.origin, 'https://www.linkedin.com');
  assert.equal(parsed.pathname, '/oauth/v2/authorization');
  assert.equal(parsed.searchParams.get('redirect_uri'), redirectUri);
});

test('LinkedIn authorize URL defaults to publishing scope for new configs', async () => {
  const { linkedInAuthorizeUrl } = await import('./linkedin.client.js');
  const authUrl = linkedInAuthorizeUrl('state-value', {
    clientId: 'linkedin-client-id',
    clientSecret: 'linkedin-client-secret',
    redirectUri: 'https://emarketing-backend.infra.obaol.com/social/oauth2-credential/callback',
    scopes: [],
  });

  const parsed = new URL(authUrl);
  assert.equal(parsed.searchParams.get('scope'), 'w_member_social');
});

test('LinkedIn token scopes normalize comma and space separated responses', async () => {
  const { normalizeLinkedInTokenScopes } = await import('./socialAuth.service.js');

  assert.deepEqual(
    normalizeLinkedInTokenScopes('w_member_social r_profile_basicinfo', ['w_member_social']),
    ['w_member_social', 'r_profile_basicinfo']
  );
  assert.deepEqual(
    normalizeLinkedInTokenScopes('w_member_social,r_profile_basicinfo', ['w_member_social']),
    ['w_member_social', 'r_profile_basicinfo']
  );
  assert.deepEqual(
    normalizeLinkedInTokenScopes(undefined, ['w_member_social', 'r_profile_basicinfo']),
    ['w_member_social', 'r_profile_basicinfo']
  );
});

test('LinkedIn diagnostics identify stale connected token scopes', async () => {
  const { linkedInScopeDiagnostics } = await import('../../routes/admin.routes.js');

  const stale = linkedInScopeDiagnostics({
    configuredScopes: ['w_member_social', 'r_profile_basicinfo'],
    connectedScopes: ['r_profile_basicinfo'],
    connectionHasToken: true,
  });
  assert.equal(stale.reconnectRequiredForPostingScope, true);
  assert.deepEqual(stale.configuredScopes, ['w_member_social', 'r_profile_basicinfo']);
  assert.deepEqual(stale.connectedScopes, ['r_profile_basicinfo']);

  const commaStored = linkedInScopeDiagnostics({
    configuredScopes: ['w_member_social', 'r_profile_basicinfo'],
    connectedScopes: ['w_member_social,r_profile_basicinfo'],
    connectionHasToken: true,
  });
  assert.equal(commaStored.reconnectRequiredForPostingScope, false);
  assert.deepEqual(commaStored.connectedScopes, ['w_member_social', 'r_profile_basicinfo']);
});

test('social app upsert payload preserves existing secret when form submits placeholder', async () => {
  const { buildSocialAppUpsertPayload, SOCIAL_APP_SECRET_PLACEHOLDER } = await import('../../routes/admin.routes.js');
  const existingSecretEncrypted = 'already-encrypted-client-secret';
  const payload = buildSocialAppUpsertPayload({
    platform: 'linkedin',
    existingSecretEncrypted,
    extracted: {
      client_id: 'linkedin-client-id',
      secret: SOCIAL_APP_SECRET_PLACEHOLDER,
      redirect_uri: 'https://emarketing-backend.infra.obaol.com/social/oauth2-credential/callback',
      scopes: ['w_member_social', 'r_liteprofile'],
      metadata: {},
    },
  });

  assert.equal(payload.client_secret_encrypted, existingSecretEncrypted);
});

test('social app upsert payload stores configured LinkedIn scopes', async () => {
  const { buildSocialAppUpsertPayload } = await import('../../routes/admin.routes.js');
  const payload = buildSocialAppUpsertPayload({
    platform: 'linkedin',
    extracted: {
      client_id: 'linkedin-client-id',
      secret: 'linkedin-client-secret',
      redirect_uri: 'https://emarketing-backend.infra.obaol.com/social/oauth2-credential/callback',
      scopes: ['w_member_social'],
      metadata: { actor_urn: 'urn:li:person:configured-member-id' },
    },
  });

  assert.deepEqual(payload.scopes, ['w_member_social']);
  assert.equal((payload.metadata as any).actor_urn, 'urn:li:person:configured-member-id');
});

test('social app read fields return LinkedIn scopes and keep client secret masked', async () => {
  const { nonSecretFields, SOCIAL_APP_SECRET_PLACEHOLDER } = await import('../../routes/admin.routes.js');
  const fields = nonSecretFields('linkedin', {
    client_id: 'linkedin-client-id',
    client_secret_encrypted: 'encrypted-secret-value',
    redirect_uri: 'https://emarketing-backend.infra.obaol.com/social/oauth2-credential/callback',
    scopes: ['w_member_social'],
    metadata: { actor_urn: 'urn:li:person:configured-member-id' },
  }, true);

  assert.equal(fields.client_secret, SOCIAL_APP_SECRET_PLACEHOLDER);
  assert.notEqual(fields.client_secret, 'encrypted-secret-value');
  assert.equal(fields.scopes, 'w_member_social');
  assert.equal(fields.actor_urn, 'urn:li:person:configured-member-id');
});

test('LinkedIn actor URN validator accepts URNs and raw member ids, rejects profile URLs', async () => {
  const { validateLinkedInActorUrnInput } = await import('../../routes/admin.routes.js');

  assert.equal(validateLinkedInActorUrnInput('urn:li:person:abc123'), null);
  assert.equal(validateLinkedInActorUrnInput('abc123'), null);
  assert.match(
    validateLinkedInActorUrnInput('https://www.linkedin.com/in/some-profile') ?? '',
    /Do not paste a LinkedIn profile URL/
  );
});

test('LinkedIn redirect diagnostics supports legacy paths but recommends canonical callback', async () => {
  const { linkedInCallbackStatus } = await import('../../routes/admin.routes.js');
  const env = {
    LINKEDIN_PUBLIC_BASE_URL: 'https://emarketing-backend.infra.obaol.com',
  } as NodeJS.ProcessEnv;

  const legacy = linkedInCallbackStatus('https://emarketing-backend.infra.obaol.com/rest/oauth2-credential/callback', env);
  assert.equal(legacy.redirect_uri_supported, true);
  assert.equal(legacy.redirect_uri_recommended, false);
  assert.equal(legacy.redirect_uri_exact, false);
  assert.equal(legacy.canonical_callback_url, 'https://emarketing-backend.infra.obaol.com/social/oauth2-credential/callback');

  const canonical = linkedInCallbackStatus('https://emarketing-backend.infra.obaol.com/social/oauth2-credential/callback', env);
  assert.equal(canonical.redirect_uri_supported, true);
  assert.equal(canonical.redirect_uri_recommended, true);
  assert.equal(canonical.redirect_uri_exact, true);
});

test('social OAuth schema migration is idempotent and creates required tables', () => {
  const sql = readFileSync('sql/20260618_fix_social_app_oauth_schema.sql', 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.social_operator_oauth_apps/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.social_oauth_states/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.social_oauth_connections/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS social_operator_oauth_apps_operator_platform_uidx/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS social_oauth_connections_platform_user_operator_uidx/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.social_connectors/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.social_publish_requests/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.social_publish_jobs/i);
  assert.match(sql, /ALTER TABLE public\.social_oauth_states ADD COLUMN IF NOT EXISTS state_hash text/i);
  assert.match(sql, /ALTER TABLE public\.social_oauth_states ADD COLUMN IF NOT EXISTS operator_id uuid/i);
  assert.match(sql, /ALTER TABLE public\.social_oauth_connections ADD COLUMN IF NOT EXISTS platform_code text/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS metadata jsonb/i);
  assert.match(sql, /social_oauth_states_state_hash_uidx/i);
  assert.match(sql, /social_oauth_connections_status_check/i);
});
