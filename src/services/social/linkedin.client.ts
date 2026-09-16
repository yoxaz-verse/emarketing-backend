import { decryptSocialSecret } from '../../utils/socialIntegrationEncryption';

export const DEFAULT_LINKEDIN_API_VERSION = '202608';

export function linkedInApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.LINKEDIN_API_VERSION || DEFAULT_LINKEDIN_API_VERSION).trim();
}

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
  status: 'connected' | 'expired' | 'missing_scope' | 'identity_required' | 'disconnected';
  reason?: string;
} {
  if (!conn) return { status: 'disconnected', reason: 'No LinkedIn connection found' };
  if (isExpired(conn.expires_at)) return { status: 'expired', reason: 'LinkedIn token expired' };

  const scopes = new Set((conn.scopes ?? [])
    .flatMap((s) => String(s ?? '').split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean));
  if (!scopes.has('w_member_social')) {
    return { status: 'missing_scope', reason: 'Missing w_member_social scope' };
  }

  if (!String(conn.metadata?.actor_urn ?? '').trim()) {
    const savedReason = String(conn.metadata?.actor_resolution_error ?? '').trim();
    return {
      status: 'identity_required',
      reason: /Enter the LinkedIn Member URN fallback/i.test(savedReason)
        ? 'LinkedIn authorization was saved before detailed identity diagnostics were available. Recheck the saved authorization to identify the issue.'
        : savedReason || 'LinkedIn token is saved, but member identity was not resolved. Recheck the saved authorization to identify the issue.',
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
  const linkedinVersion = linkedInApiVersion();

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
    const versionRejected = res.status === 426 || /NONEXISTENT_VERSION|version.+not active|deprecated.+version/i.test(body);
    const message = versionRejected
      ? `LinkedIn rejected API version ${linkedinVersion}. Configure a supported LINKEDIN_API_VERSION and retry.`
      : `LinkedIn publish failed (${res.status}). Check the connection permissions and retry.`;
    const err = new Error(message);
    (err as any).httpStatus = res.status;
    (err as any).providerCode = versionRejected ? 'LINKEDIN_API_VERSION_REJECTED' : 'LINKEDIN_PUBLISH_FAILED';
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

export function normalizeLinkedInActorUrn(value?: string | null): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^urn:li:person:[A-Za-z0-9_-]+$/.test(raw)) return raw;
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return `urn:li:person:${raw}`;
  return null;
}

type IdentityFailureCode = 'permission' | 'product' | 'missing_identity_scope' | 'version' | 'malformed_response' | 'network';
type IdentityResult = { urn: string | null; failure?: IdentityFailureCode };

function identityFailureMessage(code: IdentityFailureCode): string {
  const actions: Record<IdentityFailureCode, string> = {
    permission: 'LinkedIn denied the member profile lookup. Enable the matching identity/profile product for this app, confirm its granted scope, then reconnect.',
    product: 'LinkedIn denied the member lookup because the app does not have an identity product. Add Verified on LinkedIn to the app, then reconnect.',
    missing_identity_scope: 'The LinkedIn token has no member identity scope. Add r_profile_basicinfo to the app configuration and ensure the app has the matching LinkedIn product, then reconnect.',
    version: 'LinkedIn rejected the identity API version. Update LINKEDIN_IDENTITY_API_VERSION to a supported version, then reconnect.',
    malformed_response: 'LinkedIn returned no valid member ID. Check the app identity product and backend diagnostics before reconnecting.',
    network: 'The backend could not reach LinkedIn for the member lookup. Check connectivity, then retry connecting.',
  };
  return `LinkedIn token is saved, but member identity was not resolved. ${actions[code]}`;
}

function classifyIdentityResponse(res: Response, body: string): IdentityFailureCode {
  if (res.status === 403 && /no valid api product|product (?:not enabled|not assigned|unavailable)/i.test(body)) return 'product';
  if (res.status === 401 || res.status === 403 || res.status === 404) return 'permission';
  if (res.status === 426 || /(?:unsupported|invalid|deprecated).*version|version.*(?:unsupported|invalid|deprecated)/i.test(body)) return 'version';
  if (res.status === 429 || res.status >= 500) return 'network';
  return 'malformed_response';
}

async function fetchLinkedInIdentityMeActorUrn(accessToken: string): Promise<IdentityResult> {
  let res: Response;
  try {
    res = await fetch('https://api.linkedin.com/rest/identityMe', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': process.env.LINKEDIN_IDENTITY_API_VERSION || '202510.03',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });
  } catch {
    return { urn: null, failure: 'network' };
  }
  if (!res.ok) return { urn: null, failure: classifyIdentityResponse(res, await res.text().catch(() => '')) };
  const data = await res.json().catch(() => null);
  const urn = normalizeLinkedInActorUrn(data?.id);
  return urn ? { urn } : { urn: null, failure: 'malformed_response' };
}

async function fetchLinkedInOidcActorUrn(accessToken: string): Promise<IdentityResult> {
  let res: Response;
  try {
    res = await fetch('https://api.linkedin.com/v2/userinfo', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { urn: null, failure: 'network' };
  }
  if (!res.ok) return { urn: null, failure: classifyIdentityResponse(res, await res.text().catch(() => '')) };
  const data = await res.json().catch(() => null);
  const urn = normalizeLinkedInActorUrn(data?.sub);
  return urn ? { urn } : { urn: null, failure: 'malformed_response' };
}

async function fetchLinkedInLegacyActorUrn(accessToken: string): Promise<IdentityResult> {
  const linkedinVersion = linkedInApiVersion();
  let res: Response;
  try {
    res = await fetch('https://api.linkedin.com/v2/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Restli-Protocol-Version': '2.0.0',
        'LinkedIn-Version': linkedinVersion,
      },
    });
  } catch {
    return { urn: null, failure: 'network' };
  }
  if (!res.ok) return { urn: null, failure: classifyIdentityResponse(res, await res.text().catch(() => '')) };
  const data = await res.json().catch(() => null);
  const urn = normalizeLinkedInActorUrn(data?.id);
  return urn ? { urn } : { urn: null, failure: 'malformed_response' };
}

export async function fetchLinkedInActorUrn(
  accessToken: string,
  idToken?: string | null,
  manualActorUrn?: string | null,
  scopes?: string[] | null,
): Promise<string> {
  const result = await tryFetchLinkedInActorUrn(accessToken, idToken, manualActorUrn, scopes);
  if (result.actorUrn) return result.actorUrn;
  throw new Error(result.error);
}

export async function tryFetchLinkedInActorUrn(
  accessToken: string,
  idToken?: string | null,
  manualActorUrn?: string | null,
  scopes?: string[] | null,
): Promise<{
  actorUrn: string | null;
  source: 'manual_config' | 'identity_me' | 'oidc_userinfo' | 'legacy_profile' | 'unresolved';
  error?: string;
  errorCode?: IdentityFailureCode;
}> {
  const fromConfig = normalizeLinkedInActorUrn(manualActorUrn);
  if (fromConfig) return { actorUrn: fromConfig, source: 'manual_config' };
  void idToken; // Do not trust unverified JWT claims as a posting identity.
  const granted = new Set((scopes ?? []).flatMap((scope) => String(scope).split(/[,\s]+/)));
  const missingIdentityScope = scopes != null && !granted.has('r_profile_basicinfo') && !(granted.has('openid') && granted.has('profile'));
  const attempts: { source: 'identity_me' | 'oidc_userinfo' | 'legacy_profile'; run: () => Promise<IdentityResult> }[] = [];
  if (granted.has('r_profile_basicinfo')) attempts.push({ source: 'identity_me', run: () => fetchLinkedInIdentityMeActorUrn(accessToken) });
  if (granted.has('openid') && granted.has('profile')) attempts.push({ source: 'oidc_userinfo', run: () => fetchLinkedInOidcActorUrn(accessToken) });
  // Older configurations may not report token scopes. Preserve the existing lookup path for those connections.
  if (scopes == null) attempts.push({ source: 'oidc_userinfo', run: () => fetchLinkedInOidcActorUrn(accessToken) });
  attempts.push({ source: 'legacy_profile', run: () => fetchLinkedInLegacyActorUrn(accessToken) });

  let primaryFailure: IdentityFailureCode | undefined;
  for (const attempt of attempts) {
    const result = await attempt.run();
    if (result.urn) return { actorUrn: result.urn, source: attempt.source };
    primaryFailure ??= result.failure;
  }
  const errorCode = missingIdentityScope ? 'missing_identity_scope' : primaryFailure ?? 'malformed_response';
  return { actorUrn: null, source: 'unresolved', errorCode, error: identityFailureMessage(errorCode) };
}

export async function buildLinkedInConnectionMetadata(params: {
  accessToken: string;
  idToken?: string | null;
  manualActorUrn?: string | null;
  scopes?: string[] | null;
  refreshTokenExpiresIn?: number | null;
}): Promise<Record<string, unknown>> {
  const actor = await tryFetchLinkedInActorUrn(
    params.accessToken,
    params.idToken,
    params.manualActorUrn,
    params.scopes,
  );
  const metadata: Record<string, unknown> = {
    identity_source: actor.source,
    refresh_token_expires_in: params.refreshTokenExpiresIn ?? null,
  };

  if (actor.actorUrn) {
    metadata.actor_urn = actor.actorUrn;
  } else {
    metadata.actor_resolution_error = actor.error ?? 'Actor/member URN required';
    metadata.actor_resolution_error_code = actor.errorCode;
    metadata.actor_urn_required = true;
  }

  return metadata;
}
