import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

async function loadReadinessModule() {
  return import('./social.service.js');
}

function connector(overrides: Record<string, unknown> = {}): any {
  return {
    code: 'linkedin',
    name: 'LinkedIn',
    status: 'api_enabled',
    auth_type: 'oauth2',
    can_schedule: true,
    can_publish: true,
    credentials_active: true,
    deep_link_url: null,
    metadata: {
      app_configured: true,
      oauth_app_configured: true,
      missing_fields: [],
    },
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}): any {
  return {
    platform_code: 'linkedin',
    status: 'connected',
    reason: null,
    scopes: ['w_member_social', 'r_liteprofile'],
    expires_at: null,
    metadata: { actor_urn: 'urn:li:person:test-member-id' },
    ...overrides,
  };
}

test('readiness rejects disconnected target', async () => {
  const { evaluateSocialTargetReadiness } = await loadReadinessModule();
  const result = evaluateSocialTargetReadiness({
    platform: 'linkedin',
    connector: connector(),
    connection: null,
  });

  assert.equal(result?.status, 'disconnected');
  assert.match(result?.reason ?? '', /not connected/i);
});

test('readiness rejects expired target', async () => {
  const { evaluateSocialTargetReadiness } = await loadReadinessModule();
  const result = evaluateSocialTargetReadiness({
    platform: 'linkedin',
    connector: connector(),
    connection: connection({ status: 'expired', reason: 'LinkedIn token expired' }),
  });

  assert.equal(result?.status, 'expired');
  assert.match(result?.reason ?? '', /expired/i);
});

test('readiness rejects missing-scope target', async () => {
  const { evaluateSocialTargetReadiness } = await loadReadinessModule();
  const result = evaluateSocialTargetReadiness({
    platform: 'linkedin',
    connector: connector(),
    connection: connection({ status: 'missing_scope', reason: 'Missing w_member_social scope' }),
  });

  assert.equal(result?.status, 'missing_scope');
  assert.match(result?.reason ?? '', /scope/i);
});

test('readiness rejects unconfigured app credentials', async () => {
  const { evaluateSocialTargetReadiness } = await loadReadinessModule();
  const result = evaluateSocialTargetReadiness({
    platform: 'linkedin',
    connector: connector({
      metadata: {
        app_configured: false,
        oauth_app_configured: false,
        missing_fields: ['client_secret'],
      },
    }),
    connection: connection(),
  });

  assert.equal(result?.status, 'unconfigured');
  assert.deepEqual(result?.missing_fields, ['client_secret']);
});

test('readiness allows connected configured target', async () => {
  const { evaluateSocialTargetReadiness } = await loadReadinessModule();
  const result = evaluateSocialTargetReadiness({
    platform: 'linkedin',
    connector: connector(),
    connection: connection(),
  });

  assert.equal(result, null);
});

test('readiness rejects LinkedIn connection missing actor URN', async () => {
  const { evaluateSocialTargetReadiness } = await loadReadinessModule();
  const result = evaluateSocialTargetReadiness({
    platform: 'linkedin',
    connector: connector(),
    connection: connection({ metadata: {} }),
  });

  assert.equal(result?.status, 'disconnected');
  assert.deepEqual(result?.missing_fields, ['actor_urn']);
  assert.match(result?.reason ?? '', /member identity was not resolved/i);
});

test('readiness rejects Meta connection without selected page', async () => {
  const { evaluateSocialTargetReadiness } = await loadReadinessModule();
  const result = evaluateSocialTargetReadiness({
    platform: 'meta',
    connector: connector({ code: 'meta', name: 'Meta' }),
    connection: {
      platform_code: 'meta',
      status: 'connected',
      reason: null,
      scopes: ['pages_show_list', 'pages_manage_posts'],
      expires_at: null,
      metadata: {},
    },
  });

  assert.equal(result?.status, 'identity_required');
  assert.deepEqual(result?.missing_fields, ['selected_page_id']);
});

test('optimizer produces per-platform overrides and warnings', async () => {
  const { optimizeSocialPostInput, resolvePlatformPostInput } = await import('./connectors.js');
  const optimized = optimizeSocialPostInput({
    content: 'Launch update',
    media: ['http://example.com/image.jpg'],
    cta_url: 'https://obaol.com',
    hashtags: ['Launch', '#Launch', 'B2B Marketing'],
    timezone: 'Asia/Kolkata',
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
  }, ['linkedin', 'meta']);

  assert.equal(optimized.validation_errors.length, 0);
  assert.match(optimized.platform_overrides.linkedin?.content ?? '', /#Launch/);
  assert.match(optimized.platform_overrides.linkedin?.content ?? '', /#B2BMarketing/);
  assert.equal(optimized.platform_overrides.linkedin?.hashtags?.length, 2);
  assert.match(optimized.warnings.linkedin.join(' '), /media URLs are retained/i);

  const linkedinInput = resolvePlatformPostInput('linkedin', optimized.post_input);
  assert.match(linkedinInput.content, /Launch update/);
  assert.deepEqual(linkedinInput.hashtags, ['#Launch', '#B2BMarketing']);
});
