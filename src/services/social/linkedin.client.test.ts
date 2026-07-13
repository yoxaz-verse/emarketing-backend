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
