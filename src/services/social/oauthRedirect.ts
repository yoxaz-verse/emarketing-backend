const PRODUCTION_SOCIAL_OAUTH_REDIRECT = 'https://emarketing.obaol.com/dashboard/social-connectors';
const LOCAL_SOCIAL_OAUTH_REDIRECT = 'http://localhost:3000/dashboard/social-connectors';

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

export function socialOAuthErrorUrl(message: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${socialOAuthRedirectBase(env)}?social_connect_error=${encodeURIComponent(message)}`;
}
