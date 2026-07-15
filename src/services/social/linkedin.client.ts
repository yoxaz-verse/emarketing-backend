import { decryptSocialSecret } from '../../utils/socialIntegrationEncryption';

type LinkedInConnection = {
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string | null;
  scopes: string[] | null;
  metadata: Record<string, any>;
};

type PublishInput = {
  content: string;
  cta_url?: string;
};

type PublishResult = {
  external_post_id: string;
  external_post_url: string;
};

export type LinkedInOAuthAppConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  metadata?: Record<string, unknown>;
};

export type LinkedInTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  id_token?: string;
  scope?: string;
};

function isExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now() + 60_000;
}

export function checkLinkedInConnectionStatus(conn: LinkedInConnection | null): {
  status: 'connected' | 'expired' | 'missing_scope' | 'disconnected';
  reason?: string;
} {
  if (!conn) return { status: 'disconnected', reason: 'No LinkedIn connection found' };
  if (isExpired(conn.expires_at)) return { status: 'expired', reason: 'LinkedIn token expired' };

  const scopes = new Set((conn.scopes ?? []).map((s) => s.trim()));
  if (!scopes.has('w_member_social')) {
    return { status: 'missing_scope', reason: 'Missing w_member_social scope' };
  }

  if (!String(conn.metadata?.actor_urn ?? '').trim()) {
    return {
      status: 'disconnected',
      reason: 'LinkedIn actor/member URN required. Add Actor / Member URN in Configure, save, then reconnect LinkedIn.',
    };
  }

  return { status: 'connected' };
}

export async function publishLinkedInTextLink(conn: LinkedInConnection, input: PublishInput): Promise<PublishResult> {
  const status = checkLinkedInConnectionStatus(conn);
  if (status.status !== 'connected') {
    throw new Error(status.reason ?? 'LinkedIn connection unavailable');
  }

  const accessToken = decryptSocialSecret(conn.access_token_encrypted);
  const actorUrn = String(conn.metadata?.actor_urn ?? '').trim();
  if (!actorUrn) throw new Error('LinkedIn actor URN missing. Reconnect LinkedIn account.');

  const apiUrl = 'https://api.linkedin.com/rest/posts';
  const linkedinVersion = process.env.LINKEDIN_API_VERSION || '202504';

  const payload: Record<string, any> = {
    author: actorUrn,
    commentary: input.content,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (input.cta_url) {
    payload.content = {
      article: {
        source: input.cta_url,
      },
    };
  }

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': linkedinVersion,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`LinkedIn publish failed (${res.status}): ${body}`);
    (err as any).httpStatus = res.status;
    throw err;
  }

  const restliId = res.headers.get('x-restli-id') || '';
  const externalId = restliId.trim() || `linkedin-post-${Date.now()}`;
  const externalUrl = `https://www.linkedin.com/feed/`;

  return {
    external_post_id: externalId,
    external_post_url: externalUrl,
  };
}

export function linkedInAuthorizeUrl(state: string, config: LinkedInOAuthAppConfig): string {
  const scope = (config.scopes ?? []).join(' ').trim() || 'w_member_social';

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    scope,
  });

  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

export async function exchangeLinkedInCode(code: string, config: LinkedInOAuthAppConfig): Promise<LinkedInTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`LinkedIn token exchange failed (${res.status}): ${raw}`);
  }

  return res.json();
}

function subjectUrnFromJwt(tokenInput?: string | null): string | null {
  const token = String(tokenInput ?? '').trim();
  const payload = token.split('.')[1];
  if (!payload) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const sub = String(parsed?.sub ?? '').trim();
    return sub ? `urn:li:person:${sub}` : null;
  } catch {
    return null;
  }
}

export function normalizeLinkedInActorUrn(value?: string | null): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^urn:li:person:[A-Za-z0-9_-]+$/.test(raw)) return raw;
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return `urn:li:person:${raw}`;
  return null;
}

async function fetchLinkedInOidcActorUrn(accessToken: string): Promise<string | null> {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const sub = String(data?.sub ?? '').trim();
  return sub ? `urn:li:person:${sub}` : null;
}

async function fetchLinkedInLegacyActorUrn(accessToken: string): Promise<string> {
  const linkedinVersion = process.env.LINKEDIN_API_VERSION || '202504';
  const res = await fetch('https://api.linkedin.com/v2/me', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': linkedinVersion,
    },
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`LinkedIn profile fetch failed (${res.status}): ${raw}`);
  }

  const data = await res.json();
  const id = String(data?.id ?? '').trim();
  if (!id) throw new Error('LinkedIn profile id missing');
  return `urn:li:person:${id}`;
}

export async function fetchLinkedInActorUrn(
  accessToken: string,
  idToken?: string | null,
  manualActorUrn?: string | null
): Promise<string> {
  const fromConfig = normalizeLinkedInActorUrn(manualActorUrn);
  if (fromConfig) return fromConfig;

  const fromIdToken = subjectUrnFromJwt(idToken);
  if (fromIdToken) return fromIdToken;

  const fromUserInfo = await fetchLinkedInOidcActorUrn(accessToken);
  if (fromUserInfo) return fromUserInfo;

  const fromAccessToken = subjectUrnFromJwt(accessToken);
  if (fromAccessToken) return fromAccessToken;

  try {
    return await fetchLinkedInLegacyActorUrn(accessToken);
  } catch (err: any) {
    throw new Error(
      `LinkedIn actor URN could not be resolved. Add Actor / Member URN in Configure, save, then reconnect LinkedIn. Technical detail: ${err?.message ?? err}`
    );
  }
}

export async function tryFetchLinkedInActorUrn(
  accessToken: string,
  idToken?: string | null,
  manualActorUrn?: string | null
): Promise<{
  actorUrn: string | null;
  source: 'manual_config' | 'oidc_id_token' | 'oidc_userinfo_or_token' | 'legacy_profile' | 'unresolved';
  error?: string;
}> {
  const fromConfig = normalizeLinkedInActorUrn(manualActorUrn);
  if (fromConfig) return { actorUrn: fromConfig, source: 'manual_config' };

  const fromIdToken = subjectUrnFromJwt(idToken);
  if (fromIdToken) return { actorUrn: fromIdToken, source: 'oidc_id_token' };

  const fromUserInfo = await fetchLinkedInOidcActorUrn(accessToken);
  if (fromUserInfo) return { actorUrn: fromUserInfo, source: 'oidc_userinfo_or_token' };

  const fromAccessToken = subjectUrnFromJwt(accessToken);
  if (fromAccessToken) return { actorUrn: fromAccessToken, source: 'oidc_userinfo_or_token' };

  try {
    return { actorUrn: await fetchLinkedInLegacyActorUrn(accessToken), source: 'legacy_profile' };
  } catch (err: any) {
    return {
      actorUrn: null,
      source: 'unresolved',
      error: `Actor/member URN required. LinkedIn token was saved, but profile lookup was blocked. Add Actor / Member URN in Configure, save, then reconnect LinkedIn. Technical detail: ${err?.message ?? err}`,
    };
  }
}
