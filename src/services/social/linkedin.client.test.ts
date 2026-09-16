import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSupportedLinkedInApiVersion, DEFAULT_LINKEDIN_API_VERSION, linkedInApiVersion } from './linkedin.client.js';
import { normalizeProviderError } from './connectors.js';

test('LinkedIn API version defaults to the current supported release and remains configurable', () => {
  assert.equal(DEFAULT_LINKEDIN_API_VERSION, '202608');
  assert.equal(linkedInApiVersion({} as NodeJS.ProcessEnv), '202608');
  assert.equal(linkedInApiVersion({ LINKEDIN_API_VERSION: '202607' } as NodeJS.ProcessEnv), '202607');
});

test('LinkedIn API version validation rejects retired and malformed deployment values', () => {
  assert.equal(assertSupportedLinkedInApiVersion({} as NodeJS.ProcessEnv), '202608');
  assert.throws(() => assertSupportedLinkedInApiVersion({ LINKEDIN_API_VERSION: '202504' } as NodeJS.ProcessEnv), /retired.*202608/i);
  assert.throws(() => assertSupportedLinkedInApiVersion({ LINKEDIN_API_VERSION: '2026.08' } as NodeJS.ProcessEnv), /YYYYMM/);
});

test('LinkedIn HTTP 426 keeps a stable code and never exposes raw provider JSON', () => {
  const error = Object.assign(new Error('{"code":"NONEXISTENT_VERSION","message":"private provider detail"}'), {
    httpStatus: 426,
    providerCode: 'LINKEDIN_API_VERSION_REJECTED',
  });
  const normalized = normalizeProviderError(error);
  assert.equal(normalized.code, 'LINKEDIN_API_VERSION_REJECTED');
  assert.equal(normalized.retryable, false);
  assert.doesNotMatch(normalized.message, /private provider detail|NONEXISTENT_VERSION/);
});

test('LinkedIn publishing uses the supported version and sanitizes version rejection details', async () => {
  const { publishLinkedInTextLink } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SOCIAL_INTEGRATION_ENCRYPTION_KEY;
  process.env.SOCIAL_INTEGRATION_ENCRYPTION_KEY = 'test-social-integration-key-32-bytes';
  const { encryptSocialSecret } = await import('../../utils/socialIntegrationEncryption.js');
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>)?.['LinkedIn-Version'], '202608');
    return new Response('{"code":"NONEXISTENT_VERSION","message":"private provider detail"}', { status: 426 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      publishLinkedInTextLink({
        access_token_encrypted: encryptSocialSecret('token'), refresh_token_encrypted: null, expires_at: null,
        scopes: ['w_member_social'], metadata: { actor_urn: 'urn:li:person:member_1' },
      }, { content: 'test' }),
      (error: any) => error.httpStatus === 426 && /version 202608/.test(error.message) && !/private provider detail/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SOCIAL_INTEGRATION_ENCRYPTION_KEY;
    else process.env.SOCIAL_INTEGRATION_ENCRYPTION_KEY = originalKey;
  }
});

test('LinkedIn actor URN ignores an unverified id_token and uses OIDC userinfo', async () => {
  const { fetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), 'https://api.linkedin.com/v2/userinfo');
    return new Response(JSON.stringify({ sub: 'verified-member-id' }), { status: 200 });
  }) as typeof fetch;

  try {
    const urn = await fetchLinkedInActorUrn('access-token', 'unverified.jwt.value', null, ['openid', 'profile']);
    assert.equal(urn, 'urn:li:person:verified-member-id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn actor URN uses OIDC userinfo before legacy profile endpoint', async () => {
  const { fetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    assert.equal(url, 'https://api.linkedin.com/v2/userinfo');
    return new Response(JSON.stringify({ sub: 'userinfo-member-id' }), { status: 200 });
  }) as typeof fetch;

  try {
    const urn = await fetchLinkedInActorUrn('access-token');
    assert.equal(urn, 'urn:li:person:userinfo-member-id');
    assert.deepEqual(urls, ['https://api.linkedin.com/v2/userinfo']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn actor URN never uses an unverified access token subject', async () => {
  const { tryFetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://api.linkedin.com/v2/userinfo') {
      return new Response(JSON.stringify({ message: 'missing OIDC product' }), { status: 403 });
    }
    assert.equal(url, 'https://api.linkedin.com/v2/me');
    return new Response(JSON.stringify({ message: 'missing legacy profile product' }), { status: 403 });
  }) as typeof fetch;

  try {
    const result = await tryFetchLinkedInActorUrn('header.eyJzdWIiOiJmb3JnZWQifQ.signature');
    assert.equal(result.actorUrn, null);
    assert.deepEqual(urls, ['https://api.linkedin.com/v2/userinfo', 'https://api.linkedin.com/v2/me']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn identityMe uses the centralized version and resolves a member for r_profile_basicinfo', async () => {
  const { buildLinkedInConnectionMetadata, checkLinkedInConnectionStatus } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.LINKEDIN_API_VERSION;
  process.env.LINKEDIN_API_VERSION = '202608';
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    assert.equal(String(input), 'https://api.linkedin.com/rest/identityMe');
    assert.equal((init?.headers as Record<string, string>)?.['LinkedIn-Version'], '202608');
    return new Response(JSON.stringify({ id: 'member_123' }), { status: 200 });
  }) as typeof fetch;

  try {
    const metadata = await buildLinkedInConnectionMetadata({
      accessToken: 'access-token',
      scopes: ['w_member_social,r_profile_basicinfo'],
    });
    assert.equal(metadata.actor_urn, 'urn:li:person:member_123');
    assert.equal(metadata.identity_source, 'identity_me');
    assert.deepEqual(urls, ['https://api.linkedin.com/rest/identityMe']);
    assert.equal(checkLinkedInConnectionStatus({
      access_token_encrypted: 'encrypted-token', refresh_token_encrypted: null,
      expires_at: null, scopes: ['w_member_social', 'r_profile_basicinfo'], metadata,
    }).status, 'connected');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVersion === undefined) delete process.env.LINKEDIN_API_VERSION;
    else process.env.LINKEDIN_API_VERSION = originalVersion;
  }
});

for (const scenario of [
  { name: 'permission denied', status: 403, body: { message: 'secret provider detail' }, code: 'permission' },
  { name: 'unsupported version', status: 400, body: { message: 'Unsupported LinkedIn version' }, code: 'version' },
  { name: 'missing ID', status: 200, body: { basicInfo: {} }, code: 'malformed_response' },
  { name: 'invalid ID', status: 200, body: { id: 'not a valid/id' }, code: 'malformed_response' },
] as const) {
  test(`LinkedIn identityMe ${scenario.name} stays unresolved with safe diagnostics`, async () => {
    const { buildLinkedInConnectionMetadata, checkLinkedInConnectionStatus } = await import('./linkedin.client.js');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === 'https://api.linkedin.com/rest/identityMe') {
        return new Response(JSON.stringify(scenario.body), { status: scenario.status });
      }
      return new Response(JSON.stringify({ message: 'legacy unavailable' }), { status: 403 });
    }) as typeof fetch;
    try {
      const metadata = await buildLinkedInConnectionMetadata({ accessToken: 'access-token', scopes: ['w_member_social', 'r_profile_basicinfo'] });
      assert.equal(metadata.actor_urn, undefined);
      assert.equal(metadata.actor_resolution_error_code, scenario.code);
      assert.doesNotMatch(String(metadata.actor_resolution_error), /secret provider detail|access-token/);
      assert.equal(checkLinkedInConnectionStatus({
        access_token_encrypted: 'encrypted-token', refresh_token_encrypted: null,
        expires_at: null, scopes: ['w_member_social', 'r_profile_basicinfo'], metadata,
      }).status, 'identity_required');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('LinkedIn identityMe network failure gives retry guidance without claiming readiness', async () => {
  const { buildLinkedInConnectionMetadata } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('private network detail'); }) as typeof fetch;
  try {
    const metadata = await buildLinkedInConnectionMetadata({ accessToken: 'access-token', scopes: ['w_member_social', 'r_profile_basicinfo'] });
    assert.equal(metadata.actor_resolution_error_code, 'network');
    assert.match(String(metadata.actor_resolution_error), /Check connectivity/);
    assert.doesNotMatch(String(metadata.actor_resolution_error), /private network detail/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn reports a missing identity scope without exposing provider details', async () => {
  const { buildLinkedInConnectionMetadata, checkLinkedInConnectionStatus } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('private provider detail', { status: 403 })) as typeof fetch;
  try {
    const metadata = await buildLinkedInConnectionMetadata({ accessToken: 'private-access-token', scopes: ['w_member_social'] });
    assert.equal(metadata.actor_resolution_error_code, 'missing_identity_scope');
    assert.match(String(metadata.actor_resolution_error), /r_profile_basicinfo/);
    assert.doesNotMatch(String(metadata.actor_resolution_error), /private/);
    assert.equal(checkLinkedInConnectionStatus({
      access_token_encrypted: 'encrypted-token', refresh_token_encrypted: null,
      expires_at: null, scopes: ['w_member_social'], metadata,
    }).status, 'identity_required');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn identifies an unavailable app product from a sanitized provider failure', async () => {
  const { buildLinkedInConnectionMetadata } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(
    String(input).endsWith('/identityMe') ? 'No valid API product assigned; private detail' : 'forbidden',
    { status: 403 },
  )) as typeof fetch;
  try {
    const metadata = await buildLinkedInConnectionMetadata({ accessToken: 'private-access-token', scopes: ['w_member_social', 'r_profile_basicinfo'] });
    assert.equal(metadata.actor_resolution_error_code, 'product');
    assert.match(String(metadata.actor_resolution_error), /Verified on LinkedIn/);
    assert.doesNotMatch(String(metadata.actor_resolution_error), /private/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn actor URN uses configured manual actor before legacy profile endpoint', async () => {
  const { fetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://api.linkedin.com/v2/userinfo') {
      return new Response(JSON.stringify({ message: 'missing OIDC product' }), { status: 403 });
    }
    throw new Error('legacy profile endpoint should not be called when manual actor is configured');
  }) as typeof fetch;

  try {
    const urn = await fetchLinkedInActorUrn('access-token', null, 'urn:li:person:configured-member-id');
    assert.equal(urn, 'urn:li:person:configured-member-id');
    assert.deepEqual(urls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn actor URN normalizes configured raw member id', async () => {
  const { fetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ message: 'missing OIDC product' }), { status: 403 });
  }) as typeof fetch;

  try {
    const urn = await fetchLinkedInActorUrn('access-token', null, 'raw-member-id_123');
    assert.equal(urn, 'urn:li:person:raw-member-id_123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn actor URN reports action when profile permissions block all identity paths', async () => {
  const { fetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://api.linkedin.com/v2/userinfo') {
      return new Response(JSON.stringify({ message: 'missing OIDC product' }), { status: 403 });
    }
    return new Response(
      JSON.stringify({ status: 403, serviceErrorCode: 100, code: 'ACCESS_DENIED', message: 'Not enough permissions to access: me.GET.NO_VERSION' }),
      { status: 403 }
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchLinkedInActorUrn('access-token'),
      /Enable the matching identity\/profile product/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn actor URN try helper returns actionable unresolved result instead of throwing', async () => {
  const { tryFetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://api.linkedin.com/v2/userinfo') {
      return new Response(JSON.stringify({ message: 'missing OIDC product' }), { status: 403 });
    }
    return new Response(
      JSON.stringify({ code: 'ACCESS_DENIED', message: 'Not enough permissions to access: me.GET.NO_VERSION' }),
      { status: 403 }
    );
  }) as typeof fetch;

  try {
    const result = await tryFetchLinkedInActorUrn('access-token');
    assert.equal(result.actorUrn, null);
    assert.equal(result.source, 'unresolved');
    assert.equal(result.errorCode, 'permission');
    assert.match(result.error ?? '', /LinkedIn denied the member profile lookup/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn status reports identity required for connected token without actor URN', async () => {
  const { checkLinkedInConnectionStatus } = await import('./linkedin.client.js');
  const status = checkLinkedInConnectionStatus({
    access_token_encrypted: 'encrypted-token',
    refresh_token_encrypted: null,
    expires_at: null,
    scopes: ['w_member_social'],
    metadata: {},
  });

  assert.equal(status.status, 'identity_required');
  assert.match(status.reason ?? '', /member identity was not resolved/i);
});

test('LinkedIn status replaces obsolete manual fallback advice from a saved connection', async () => {
  const { checkLinkedInConnectionStatus } = await import('./linkedin.client.js');
  const status = checkLinkedInConnectionStatus({
    access_token_encrypted: 'encrypted-token', refresh_token_encrypted: null,
    expires_at: null, scopes: ['w_member_social', 'r_profile_basicinfo'],
    metadata: { actor_resolution_error: 'Enter the LinkedIn Member URN fallback, save, then reconnect LinkedIn.' },
  });
  assert.equal(status.status, 'identity_required');
  assert.match(status.reason ?? '', /Recheck the saved authorization/);
  assert.doesNotMatch(status.reason ?? '', /Enter the LinkedIn Member URN/);
});

test('LinkedIn status accepts comma-joined stored token scopes', async () => {
  const { checkLinkedInConnectionStatus } = await import('./linkedin.client.js');
  const status = checkLinkedInConnectionStatus({
    access_token_encrypted: 'encrypted-token',
    refresh_token_encrypted: null,
    expires_at: null,
    scopes: ['w_member_social,r_profile_basicinfo'],
    metadata: { actor_urn: 'urn:li:person:member-id' },
  });

  assert.equal(status.status, 'connected');
});

test('LinkedIn connection metadata stores configured manual actor URN', async () => {
  const { buildLinkedInConnectionMetadata } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('fetch should not be called when manual actor is configured');
  }) as typeof fetch;

  try {
    const metadata = await buildLinkedInConnectionMetadata({
      accessToken: 'access-token',
      manualActorUrn: 'configured-member-id',
      refreshTokenExpiresIn: 1234,
    });

    assert.equal(metadata.actor_urn, 'urn:li:person:configured-member-id');
    assert.equal(metadata.identity_source, 'manual_config');
    assert.equal(metadata.refresh_token_expires_in, 1234);
    assert.equal(metadata.actor_urn_required, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn actor URN falls back to legacy profile endpoint', async () => {
  const { fetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://api.linkedin.com/v2/userinfo') {
      return new Response(JSON.stringify({ message: 'missing OIDC product' }), { status: 403 });
    }
    assert.equal(url, 'https://api.linkedin.com/v2/me');
    return new Response(JSON.stringify({ id: 'legacy-member-id' }), { status: 200 });
  }) as typeof fetch;

  try {
    const urn = await fetchLinkedInActorUrn('access-token');
    assert.equal(urn, 'urn:li:person:legacy-member-id');
    assert.deepEqual(urls, ['https://api.linkedin.com/v2/userinfo', 'https://api.linkedin.com/v2/me']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
