import { decryptSocialSecret } from '../../utils/socialIntegrationEncryption';

export type OAuthAppConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  metadata?: Record<string, unknown>;
};

export type NormalizedStatus = {
  status: 'connected' | 'expired' | 'missing_scope' | 'disconnected';
  reason?: string;
};

type GenericConn = {
  access_token_encrypted: string;
  expires_at: string | null;
  scopes: string[] | null;
};

function isExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now() + 60_000;
}

function normalizeScopeSet(scopes: string[] | null | undefined): Set<string> {
  return new Set((scopes ?? []).map((s) => String(s || '').trim()).filter(Boolean));
}

export function checkConnectionStatus(conn: GenericConn | null, requiredScopes: string[]): NormalizedStatus {
  if (!conn) return { status: 'disconnected', reason: 'No connection found' };
  if (isExpired(conn.expires_at)) return { status: 'expired', reason: 'Token expired' };

  const have = normalizeScopeSet(conn.scopes);
  const missing = requiredScopes.filter((scope) => !have.has(scope));
  if (missing.length > 0) return { status: 'missing_scope', reason: `Missing scopes: ${missing.join(', ')}` };

  return { status: 'connected' };
}

export function metaAuthorizeUrl(state: string, config: OAuthAppConfig): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: (config.scopes ?? []).join(','),
    state,
  });

  return `https://www.facebook.com/v22.0/dialog/oauth?${params.toString()}`;
}

export async function exchangeMetaCode(code: string, config: OAuthAppConfig): Promise<{ access_token: string; expires_in: number }> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
  });

  const res = await fetch(`https://graph.facebook.com/v22.0/oauth/access_token?${params.toString()}`);
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Meta token exchange failed (${res.status}): ${raw}`);
  }

  return res.json();
}

export async function fetchMetaIdentity(accessToken: string): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ fields: 'id,name' });
  const res = await fetch(`https://graph.facebook.com/v22.0/me?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Meta profile fetch failed (${res.status}): ${raw}`);
  }

  return res.json();
}

export async function fetchMetaPublishingAccounts(accessToken: string): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    fields: 'id,name,access_token,instagram_business_account{id,username,name}',
    limit: '25',
  });
  const res = await fetch(`https://graph.facebook.com/v22.0/me/accounts?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Meta account discovery failed (${res.status}): ${raw}`);
  }

  return res.json();
}

function firstMetaPage(metadata: Record<string, any>): Record<string, any> | null {
  const pages = Array.isArray(metadata?.pages) ? metadata.pages : [];
  return pages.find((page) => String(page?.id ?? '').trim()) ?? null;
}

function selectedMetaAccessToken(conn: { access_token_encrypted: string; metadata?: Record<string, any> }): string {
  const encryptedPageToken = String(conn.metadata?.selected_page_access_token_encrypted ?? '').trim();
  if (encryptedPageToken) return decryptSocialSecret(encryptedPageToken);
  return decryptSocialSecret(conn.access_token_encrypted);
}

export async function publishMetaFacebookPagePost(
  conn: { access_token_encrypted: string; metadata?: Record<string, any> },
  input: { content: string; media?: string[]; cta_url?: string }
): Promise<{ external_post_id: string; external_post_url: string }> {
  const metadata = conn.metadata ?? {};
  const page = firstMetaPage(metadata);
  const pageId = String(metadata.selected_page_id ?? page?.id ?? '').trim();
  if (!pageId) throw new Error('Meta page is not selected for this connection. Reconnect Meta and choose a page.');

  const accessToken = selectedMetaAccessToken(conn);
  const media = Array.isArray(input.media) ? input.media.filter(Boolean) : [];
  const message = [input.content, input.cta_url].map((v) => String(v ?? '').trim()).filter(Boolean).join('\n\n');
  const path = media.length > 0 ? `${pageId}/photos` : `${pageId}/feed`;
  const body = new URLSearchParams(media.length > 0
    ? { url: media[0], caption: message, access_token: accessToken }
    : { message, access_token: accessToken });

  const res = await fetch(`https://graph.facebook.com/v22.0/${path}`, {
    method: 'POST',
    body,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    const err = new Error(`Meta Facebook publish failed (${res.status}): ${raw}`);
    (err as any).httpStatus = res.status;
    throw err;
  }

  const json = await res.json();
  const id = String(json?.post_id ?? json?.id ?? '').trim();
  return {
    external_post_id: id || `meta-page-post-${Date.now()}`,
    external_post_url: `https://www.facebook.com/${pageId}`,
  };
}

export async function publishMetaInstagramPost(
  conn: { access_token_encrypted: string; metadata?: Record<string, any> },
  input: { content: string; media?: string[] }
): Promise<{ external_post_id: string; external_post_url: string }> {
  const metadata = conn.metadata ?? {};
  const page = firstMetaPage(metadata);
  const instagramId = String(metadata.selected_instagram_account_id ?? page?.instagram_business_account?.id ?? '').trim();
  if (!instagramId) throw new Error('Instagram professional account is not linked to the selected Meta page.');

  const media = Array.isArray(input.media) ? input.media.filter(Boolean) : [];
  if (media.length === 0) throw new Error('Instagram publishing requires at least one public image or video URL.');

  const accessToken = selectedMetaAccessToken(conn);
  const createBody = new URLSearchParams({
    image_url: media[0],
    caption: input.content,
    access_token: accessToken,
  });
  const create = await fetch(`https://graph.facebook.com/v22.0/${instagramId}/media`, {
    method: 'POST',
    body: createBody,
  });
  if (!create.ok) {
    const raw = await create.text().catch(() => '');
    const err = new Error(`Instagram media container creation failed (${create.status}): ${raw}`);
    (err as any).httpStatus = create.status;
    throw err;
  }
  const container = await create.json();
  const creationId = String(container?.id ?? '').trim();
  if (!creationId) throw new Error('Instagram media container response did not include an id.');

  const publishBody = new URLSearchParams({
    creation_id: creationId,
    access_token: accessToken,
  });
  const publish = await fetch(`https://graph.facebook.com/v22.0/${instagramId}/media_publish`, {
    method: 'POST',
    body: publishBody,
  });
  if (!publish.ok) {
    const raw = await publish.text().catch(() => '');
    const err = new Error(`Instagram publish failed (${publish.status}): ${raw}`);
    (err as any).httpStatus = publish.status;
    throw err;
  }
  const json = await publish.json();
  const id = String(json?.id ?? '').trim();
  return {
    external_post_id: id || creationId,
    external_post_url: `https://www.instagram.com/`,
  };
}

export function redditAuthorizeUrl(state: string, config: OAuthAppConfig): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    state,
    redirect_uri: config.redirectUri,
    duration: 'permanent',
    scope: (config.scopes ?? []).join(' '),
  });

  return `https://www.reddit.com/api/v1/authorize?${params.toString()}`;
}

export async function exchangeRedditCode(code: string, config: OAuthAppConfig): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const userAgent = String(config.metadata?.user_agent || 'obaol-social-connector/1.0').trim();

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Reddit token exchange failed (${res.status}): ${raw}`);
  }

  return res.json();
}

export async function fetchRedditIdentity(accessToken: string, userAgent: string): Promise<Record<string, unknown>> {
  const res = await fetch('https://oauth.reddit.com/api/v1/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': userAgent,
    },
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Reddit profile fetch failed (${res.status}): ${raw}`);
  }

  return res.json();
}

export async function validateTelegramBot(botToken: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
  const chatId = String(metadata?.chat_id ?? '').trim();
  if (!chatId) throw new Error('Telegram chat_id missing');

  const getMe = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  if (!getMe.ok) {
    const raw = await getMe.text().catch(() => '');
    throw new Error(`Telegram bot validation failed (${getMe.status}): ${raw}`);
  }

  const getMeJson = await getMe.json();
  if (!getMeJson?.ok) throw new Error('Telegram bot validation failed: invalid bot response');

  return {
    bot_username: getMeJson?.result?.username ?? null,
    chat_id: chatId,
  };
}

export async function validateWhatsappAccess(accessToken: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
  const businessAccountId = String(metadata?.business_account_id ?? '').trim();
  const phoneNumberId = String(metadata?.phone_number_id ?? '').trim();

  if (!businessAccountId || !phoneNumberId) {
    throw new Error('WhatsApp business_account_id and phone_number_id are required');
  }

  const res = await fetch(`https://graph.facebook.com/v22.0/${businessAccountId}?fields=id,name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`WhatsApp token validation failed (${res.status}): ${raw}`);
  }

  const json = await res.json();
  return {
    business_account_id: businessAccountId,
    business_name: json?.name ?? null,
    phone_number_id: phoneNumberId,
  };
}
