import test from 'node:test';
import assert from 'node:assert/strict';

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
      scopes: ['w_member_social', 'r_liteprofile'],
      metadata: {},
    },
  });

  assert.deepEqual(payload.scopes, ['w_member_social', 'r_liteprofile']);
});

test('social app read fields return LinkedIn scopes and keep client secret masked', async () => {
  const { nonSecretFields, SOCIAL_APP_SECRET_PLACEHOLDER } = await import('../../routes/admin.routes.js');
  const fields = nonSecretFields('linkedin', {
    client_id: 'linkedin-client-id',
    client_secret_encrypted: 'encrypted-secret-value',
    redirect_uri: 'https://emarketing-backend.infra.obaol.com/social/oauth2-credential/callback',
    scopes: ['w_member_social', 'r_liteprofile'],
    metadata: {},
  }, true);

  assert.equal(fields.client_secret, SOCIAL_APP_SECRET_PLACEHOLDER);
  assert.notEqual(fields.client_secret, 'encrypted-secret-value');
  assert.equal(fields.scopes, 'w_member_social,r_liteprofile');
});
