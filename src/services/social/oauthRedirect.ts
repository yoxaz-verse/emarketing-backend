const PRODUCTION_SOCIAL_OAUTH_REDIRECT = 'https://emarketing.obaol.com/dashboard/social-connectors';
const DEFAULT_LOCAL_DASHBOARD_PORT = '3001';

export type SocialOAuthErrorCode =
  | 'backend_unavailable'
  | 'auth_service_misconfigured'
  | 'auth_service_unavailable'
  | 'social_oauth_schema_missing'
  | 'provider_permission_denied'
  | 'provider_config_error'
  | 'oauth_state_error'
  | 'unknown';

export type SocialOAuthRedirectContext = {
  operatorId?: string | null;
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function localSocialOAuthRedirect(env: NodeJS.ProcessEnv): string {
  const dashboardUrl = String(env.DASHBOARD_URL ?? '').trim();
  if (dashboardUrl) {
    return `${normalizeBaseUrl(dashboardUrl)}/dashboard/social-connectors`;
  }

  const port = String(env.DASHBOARD_PORT ?? DEFAULT_LOCAL_DASHBOARD_PORT).trim() || DEFAULT_LOCAL_DASHBOARD_PORT;
  return `http://localhost:${port}/dashboard/social-connectors`;
}

export function isSocialOAuthRedirectConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(String(env.SOCIAL_OAUTH_SUCCESS_REDIRECT ?? '').trim());
}

export function socialOAuthRedirectBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.SOCIAL_OAUTH_SUCCESS_REDIRECT ?? '').trim();
  if (configured) return normalizeBaseUrl(configured);

  return env.NODE_ENV === 'production'
    ? PRODUCTION_SOCIAL_OAUTH_REDIRECT
    : localSocialOAuthRedirect(env);
}

function appendRedirectParams(
  baseUrl: string,
  params: Record<string, string | null | undefined>,
): string {
  const query: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const normalized = String(value ?? '').trim();
    if (normalized) query.push(`${encodeURIComponent(key)}=${encodeURIComponent(normalized)}`);
  }
  const queryString = query.join('&');
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

export function socialOAuthSuccessUrl(
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
  context?: SocialOAuthRedirectContext,
): string {
  return appendRedirectParams(socialOAuthRedirectBase(env), {
    social_connected: platform,
    operator_id: context?.operatorId,
  });
}

export function classifySocialOAuthError(message: string): SocialOAuthErrorCode {
  const lower = String(message || '').toLowerCase();

  if (
    lower.includes('social_oauth_schema_missing') ||
    (lower.includes('social_oauth_states') &&
      (lower.includes('requested_platform') || lower.includes('schema cache')))
  ) {
    return 'social_oauth_schema_missing';
  }

  if (
    lower.includes('backend unavailable') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('503')
  ) {
    return 'backend_unavailable';
  }

  if (
    lower.includes('unregistered api key') ||
    lower.includes('invalid api key') ||
    lower.includes('supabase rejected') ||
    lower.includes('auth_service_misconfigured')
  ) {
    return 'auth_service_misconfigured';
  }

  if (
    lower.includes('auth_service_unavailable') ||
    lower.includes('supabase auth service') ||
    lower.includes('supabase is unreachable')
  ) {
    return 'auth_service_unavailable';
  }

  if (
    lower.includes('access_denied') ||
    lower.includes('not enough permissions') ||
    lower.includes('missing_scope') ||
    lower.includes('missing permission') ||
    lower.includes('forbidden') ||
    lower.includes('(403)') ||
    lower.includes(' 403')
  ) {
    return 'provider_permission_denied';
  }

  if (
    lower.includes('credentials not configured') ||
    lower.includes('client_id') ||
    lower.includes('client secret') ||
    lower.includes('redirect_uri') ||
    lower.includes('redirect uri') ||
    lower.includes('invalid_client')
  ) {
    return 'provider_config_error';
  }

  if (
    lower.includes('invalid oauth state') ||
    lower.includes('oauth state expired') ||
    lower.includes('missing oauth state') ||
    lower.includes('missing oauth code')
  ) {
    return 'oauth_state_error';
  }

  return 'unknown';
}

export function socialOAuthErrorUrl(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  errorCode?: SocialOAuthErrorCode,
  context?: SocialOAuthRedirectContext,
): string {
  return appendRedirectParams(socialOAuthRedirectBase(env), {
    social_connect_error: message,
    social_connect_error_code: errorCode,
    operator_id: context?.operatorId,
  });
}
