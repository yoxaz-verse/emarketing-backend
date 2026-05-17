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
  const scope = (config.scopes ?? []).join(' ').trim() || 'w_member_social r_liteprofile';

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    scope,
  });

  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

export async function exchangeLinkedInCode(code: string, config: LinkedInOAuthAppConfig): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}> {
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

export async function fetchLinkedInActorUrn(accessToken: string): Promise<string> {
  const res = await fetch('https://api.linkedin.com/v2/me', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
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
