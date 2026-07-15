import test from 'node:test';
import assert from 'node:assert/strict';

function makeUnsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

test('LinkedIn actor URN uses OIDC id_token subject without profile fetch', async () => {
  const { fetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error('fetch should not be called when id_token contains sub');
  }) as typeof fetch;

  try {
    const urn = await fetchLinkedInActorUrn('access-token', makeUnsignedJwt({ sub: 'oidc-member-id' }));
    assert.equal(urn, 'urn:li:person:oidc-member-id');
    assert.equal(called, false);
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

test('LinkedIn actor URN uses JWT access token before failing on legacy profile permissions', async () => {
  const { fetchLinkedInActorUrn } = await import('./linkedin.client.js');
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://api.linkedin.com/v2/userinfo') {
      return new Response(JSON.stringify({ message: 'missing OIDC product' }), { status: 403 });
    }
    throw new Error('legacy profile endpoint should not be called when access token contains sub');
  }) as typeof fetch;

  try {
    const urn = await fetchLinkedInActorUrn(makeUnsignedJwt({ sub: 'access-token-member-id' }));
    assert.equal(urn, 'urn:li:person:access-token-member-id');
    assert.deepEqual(urls, ['https://api.linkedin.com/v2/userinfo']);
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
      /Add Actor \/ Member URN in Configure/
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
    assert.match(result.error ?? '', /Actor\/member URN required/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LinkedIn status rejects connected token without actor URN', async () => {
  const { checkLinkedInConnectionStatus } = await import('./linkedin.client.js');
  const status = checkLinkedInConnectionStatus({
    access_token_encrypted: 'encrypted-token',
    refresh_token_encrypted: null,
    expires_at: null,
    scopes: ['w_member_social'],
    metadata: {},
  });

  assert.equal(status.status, 'disconnected');
  assert.match(status.reason ?? '', /actor\/member URN required/i);
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
