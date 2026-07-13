const PRODUCTION_SOCIAL_OAUTH_REDIRECT = 'https://emarketing.obaol.com/dashboard/social-connectors';
const LOCAL_SOCIAL_OAUTH_REDIRECT = 'http://localhost:3000/dashboard/social-connectors';

export type SocialOAuthErrorCode =
  | 'backend_unavailable'
  | 'provider_permission_denied'
  | 'provider_config_error'
  | 'oauth_state_error'
  | 'unknown';

function normalizeBaseUrl(value: string): string {
  return value.replace(/[?#].*$/, '').replace(/\/+$/, '');
}

export function isSocialOAuthRedirectConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(String(env.SOCIAL_OAUTH_SUCCESS_REDIRECT ?? '').trim());
}

export function socialOAuthRedirectBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.SOCIAL_OAUTH_SUCCESS_REDIRECT ?? '').trim();
  if (configured) return normalizeBaseUrl(configured);

  return env.NODE_ENV === 'production'
    ? PRODUCTION_SOCIAL_OAUTH_REDIRECT
    : LOCAL_SOCIAL_OAUTH_REDIRECT;
}

export function socialOAuthSuccessUrl(platform: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${socialOAuthRedirectBase(env)}?social_connected=${encodeURIComponent(platform)}`;
}

export function classifySocialOAuthError(message: string): SocialOAuthErrorCode {
  const lower = String(message || '').toLowerCase();

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
  errorCode?: SocialOAuthErrorCode
): string {
  const params = [`social_connect_error=${encodeURIComponent(message)}`];
  if (errorCode) params.push(`social_connect_error_code=${encodeURIComponent(errorCode)}`);
  return `${socialOAuthRedirectBase(env)}?${params.join('&')}`;
}
