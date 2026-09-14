import test from 'node:test';
import assert from 'node:assert/strict';
import { metaChannelPublishingConnection, metaChannelStatus } from './metaChannels.js';
import { instagramMediaError } from './social.service.js';
import { supabase } from '../../supabase.js';
import { disconnectPlatform, getPendingOAuthStateContext } from './socialAuth.service.js';
import { fetchMetaGrantedScopes, publishMetaTarget } from './platformAuth.client.js';
import { encryptSocialSecret } from '../../utils/socialIntegrationEncryption.js';
import { saveMetaAccountSelection } from './socialSetup.service.js';

const connection = {
  access_token_encrypted: 'encrypted-user-token',
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'],
  metadata: {
    selected_page_id: 'legacy-page',
    selected_instagram_account_id: 'legacy-ig',
    selected_facebook_page_id: 'facebook-page',
    selected_instagram_page_id: 'instagram-page',
    selected_instagram_channel_account_id: 'instagram-account',
    pages: [
      { id: 'legacy-page', access_token_encrypted: 'legacy-token' },
      { id: 'facebook-page', access_token_encrypted: 'facebook-token' },
      { id: 'instagram-page', access_token_encrypted: 'instagram-token', instagram_business_account: { id: 'instagram-account' } },
    ],
  },
};

test('Facebook and Instagram readiness use separate selected destinations', () => {
  assert.equal(metaChannelStatus('facebook', connection).status, 'connected');
  assert.equal(metaChannelStatus('instagram', connection).status, 'connected');
  assert.equal(metaChannelStatus('facebook', { ...connection, metadata: { ...connection.metadata, selected_facebook_page_id: '' } }).status, 'identity_required');
  assert.equal(metaChannelStatus('instagram', { ...connection, metadata: { ...connection.metadata, selected_instagram_page_id: '' } }).status, 'identity_required');
  assert.equal(metaChannelStatus('instagram', { ...connection, scopes: ['pages_show_list', 'pages_manage_posts'] }).status, 'missing_scope');
  assert.equal(metaChannelStatus('facebook', { ...connection, scopes: ['pages_show_list', 'pages_manage_posts'] }).status, 'connected');
  assert.equal(metaChannelStatus('facebook', { ...connection, expires_at: new Date(Date.now() - 1000).toISOString() }).status, 'expired');
});

test('publishing projections cannot switch the legacy Meta destination', () => {
  const facebook = metaChannelPublishingConnection('facebook', connection);
  const instagram = metaChannelPublishingConnection('instagram', connection);
  assert.equal(facebook.metadata.selected_page_id, 'facebook-page');
  assert.equal(facebook.metadata.selected_page_access_token_encrypted, 'facebook-token');
  assert.equal(facebook.metadata.selected_instagram_account_id, null);
  assert.equal(instagram.metadata.selected_page_id, 'instagram-page');
  assert.equal(instagram.metadata.selected_page_access_token_encrypted, 'instagram-token');
  assert.equal(instagram.metadata.selected_instagram_account_id, 'instagram-account');
  assert.equal(connection.metadata.selected_page_id, 'legacy-page');
  assert.equal(connection.metadata.selected_instagram_account_id, 'legacy-ig');
});

test('Instagram schedules require a public HTTPS image URL', () => {
  const base = { content: 'Post', hashtags: [], media: [] as string[] };
  assert.match(instagramMediaError(base) ?? '', /requires/);
  assert.match(instagramMediaError({ ...base, media: ['http://example.com/image.jpg'] }) ?? '', /HTTPS/);
  assert.match(instagramMediaError({ ...base, media: ['https://localhost/image.jpg'] }) ?? '', /public/);
  assert.match(instagramMediaError({ ...base, media: ['https://cdn.example.com/video.mp4'] }) ?? '', /image URLs/);
  assert.equal(instagramMediaError({ ...base, media: ['https://cdn.example.com/image.jpg'] }), null);
});

test('Meta permissions use only scopes actually granted by Facebook Login', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), 'https://graph.facebook.com/v22.0/me/permissions');
    return new Response(JSON.stringify({ data: [
      { permission: 'pages_show_list', status: 'granted' },
      { permission: 'instagram_content_publish', status: 'declined' },
    ] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await fetchMetaGrantedScopes('token'), ['pages_show_list']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Meta OAuth state remembers which channel started the one-click flow', async () => {
  const originalFrom = supabase.from;
  (supabase as any).from = (table: string) => {
    assert.equal(table, 'social_oauth_states');
    const query: any = {
      select() { return query; },
      eq() { return query; },
      maybeSingle() { return Promise.resolve({ data: {
        platform_code: 'meta', requested_platform: 'instagram', user_id: 'user-1', operator_id: 'operator-1',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }, error: null }); },
    };
    return query;
  };
  try {
    const context = await getPendingOAuthStateContext({ platform: 'meta', state: 'test-state' });
    assert.equal(context?.requestedPlatform, 'instagram');
  } finally {
    (supabase as any).from = originalFrom;
  }
});

test('disconnecting Facebook retains Instagram authorization until the last channel disconnects', async () => {
  const originalFrom = supabase.from;
  let saved: any = { id: 'connection-1', user_id: 'user-1', operator_id: 'operator-1', platform_code: 'meta',
    metadata: { selected_facebook_page_id: 'page-1', selected_instagram_page_id: 'page-2', selected_instagram_channel_account_id: 'ig-2' } };
  let deletes = 0;
  (supabase as any).from = (table: string) => {
    const query: any = {
      select() { return query; },
      eq() { return query; },
      update(value: any) { if (table === 'social_oauth_connections') saved = { ...saved, ...value }; return query; },
      delete() { deletes += 1; saved = null; return query; },
      maybeSingle() { return Promise.resolve({ data: saved, error: null }); },
      then(resolve: (value: any) => void) {
        return resolve(table === 'social_oauth_connections' && saved === null ? { error: null, count: 0 } : { error: null, count: 1 });
      },
    };
    return query;
  };
  try {
    await disconnectPlatform('facebook', 'user-1', 'operator-1');
    assert.equal(saved.metadata.selected_facebook_page_id, undefined);
    assert.equal(saved.metadata.selected_instagram_page_id, 'page-2');
    assert.equal(deletes, 0);
    await disconnectPlatform('instagram', 'user-1', 'operator-1');
    assert.equal(saved, null);
    assert.equal(deletes, 1);
  } finally {
    (supabase as any).from = originalFrom;
  }
});

test('new Facebook and Instagram jobs call only their chosen publishing endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return new Response(JSON.stringify({ id: `result-${urls.length}` }), { status: 200 });
  }) as typeof fetch;
  const tokenized = {
    ...connection,
    metadata: { ...connection.metadata, pages: connection.metadata.pages.map((page) => ({ ...page, access_token_encrypted: encryptSocialSecret(page.access_token_encrypted) })) },
  };
  try {
    await publishMetaTarget('facebook', metaChannelPublishingConnection('facebook', tokenized), { content: 'Facebook', media: [] });
    assert.deepEqual(urls, ['https://graph.facebook.com/v22.0/facebook-page/feed']);
    urls.length = 0;
    await publishMetaTarget('instagram', metaChannelPublishingConnection('instagram', tokenized), { content: 'Instagram', media: ['https://cdn.example.com/image.jpg'] });
    assert.deepEqual(urls, [
      'https://graph.facebook.com/v22.0/instagram-account/media',
      'https://graph.facebook.com/v22.0/instagram-account/media_publish',
    ]);
    urls.length = 0;
    await publishMetaTarget('meta', { ...tokenized, metadata: { ...tokenized.metadata, selected_page_access_token_encrypted: encryptSocialSecret('legacy-token') } }, { content: 'Legacy', media: ['https://cdn.example.com/image.jpg'] });
    assert.equal(urls.length, 3);
    assert.equal(urls[2], 'https://graph.facebook.com/v22.0/legacy-page/photos');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('operators select Facebook and linked Instagram destinations independently', async () => {
  const originalFrom = supabase.from;
  let row: any = { id: 'connection-1', platform_code: 'meta', user_id: 'user-1', operator_id: 'operator-1',
    metadata: { selected_page_id: 'legacy-page', pages: [
      { id: 'page-1', name: 'Facebook only', access_token_encrypted: 'token-1' },
      { id: 'page-2', name: 'Instagram Page', access_token_encrypted: 'token-2', instagram_business_account: { id: 'ig-2', username: 'brand' } },
    ] } };
  (supabase as any).from = () => {
    const query: any = {
      select() { return query; },
      eq() { return query; },
      update(value: any) { row = { ...row, ...value }; return query; },
      maybeSingle() { return Promise.resolve({ data: row, error: null }); },
      single() { return Promise.resolve({ data: row, error: null }); },
    };
    return query;
  };
  try {
    await saveMetaAccountSelection({ channel: 'facebook', userId: 'user-1', operatorId: 'operator-1', pageId: 'page-1' });
    assert.equal(row.metadata.selected_facebook_page_id, 'page-1');
    await assert.rejects(() => saveMetaAccountSelection({ channel: 'instagram', userId: 'user-1', operatorId: 'operator-1', pageId: 'page-1' }), /linked to an Instagram professional account/);
    await saveMetaAccountSelection({ channel: 'instagram', userId: 'user-1', operatorId: 'operator-1', pageId: 'page-2', instagramAccountId: 'ig-2' });
    assert.equal(row.metadata.selected_instagram_page_id, 'page-2');
    assert.equal(row.metadata.selected_instagram_channel_account_id, 'ig-2');
    assert.equal(row.metadata.selected_page_id, 'legacy-page');
  } finally {
    (supabase as any).from = originalFrom;
  }
});
