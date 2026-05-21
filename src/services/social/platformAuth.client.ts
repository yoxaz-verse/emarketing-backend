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

export async function validateTelegramBot(secretEncrypted: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
  const botToken = decryptSocialSecret(secretEncrypted);
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

export async function validateWhatsappAccess(secretEncrypted: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
  const accessToken = decryptSocialSecret(secretEncrypted);
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
