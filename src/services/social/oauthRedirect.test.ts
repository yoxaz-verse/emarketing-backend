import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSocialOAuthRedirectConfigured,
  socialOAuthErrorUrl,
  socialOAuthRedirectBase,
  socialOAuthSuccessUrl,
} from './oauthRedirect.js';

test('social OAuth redirect uses configured value exactly after normalization', () => {
  const env = {
    SOCIAL_OAUTH_SUCCESS_REDIRECT: 'https://app.example.com/dashboard/social-connectors/',
    NODE_ENV: 'production',
  } as NodeJS.ProcessEnv;

  assert.equal(isSocialOAuthRedirectConfigured(env), true);
  assert.equal(socialOAuthRedirectBase(env), 'https://app.example.com/dashboard/social-connectors');
});

test('social OAuth redirect production fallback never points to localhost', () => {
  const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  const base = socialOAuthRedirectBase(env);

  assert.equal(base, 'https://emarketing.obaol.com/dashboard/social-connectors');
  assert.equal(base.includes('localhost'), false);
});

test('social OAuth redirect allows localhost fallback outside production', () => {
  const env = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

  assert.equal(isSocialOAuthRedirectConfigured(env), false);
  assert.equal(socialOAuthRedirectBase(env), 'http://localhost:3000/dashboard/social-connectors');
});

test('social OAuth success and error URLs preserve existing query parameters', () => {
  const env = {
    SOCIAL_OAUTH_SUCCESS_REDIRECT: 'https://emarketing.obaol.com/dashboard/social-connectors',
  } as NodeJS.ProcessEnv;

  assert.equal(
    socialOAuthSuccessUrl('linkedin', env),
    'https://emarketing.obaol.com/dashboard/social-connectors?social_connected=linkedin'
  );
  assert.equal(
    socialOAuthErrorUrl('LinkedIn profile fetch failed', env),
    'https://emarketing.obaol.com/dashboard/social-connectors?social_connect_error=LinkedIn%20profile%20fetch%20failed'
  );
});
