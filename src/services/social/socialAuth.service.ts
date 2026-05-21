import crypto from 'crypto';
import { supabase } from '../../supabase';
import { decryptSocialSecret, encryptSocialSecret } from '../../utils/socialIntegrationEncryption';
import {
  exchangeLinkedInCode,
  fetchLinkedInActorUrn,
  LinkedInOAuthAppConfig,
  linkedInAuthorizeUrl,
  checkLinkedInConnectionStatus,
} from './linkedin.client';
import {
  checkConnectionStatus,
  exchangeMetaCode,
  exchangeRedditCode,
  fetchMetaIdentity,
  fetchRedditIdentity,
  metaAuthorizeUrl,
  redditAuthorizeUrl,
  validateTelegramBot,
  validateWhatsappAccess,
  type OAuthAppConfig,
} from './platformAuth.client';

const STATE_TTL_MINUTES = 15;

const OAUTH_PLATFORMS = new Set(['linkedin', 'meta', 'reddit']);
const DIRECT_VALIDATE_PLATFORMS = new Set(['telegram', 'whatsapp']);
const PLATFORM_SCOPES: Record<string, string[]> = {
  linkedin: ['w_member_social', 'r_liteprofile'],
  meta: ['pages_manage_posts', 'pages_read_engagement', 'business_management', 'instagram_basic'],
  reddit: ['identity', 'submit'],
  telegram: [],
  whatsapp: [],
};

type ConnectionRow = {
  id: string;
  platform_code: string;
  operator_id: string;
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string | null;
  scopes: string[] | null;
  metadata: Record<string, any>;
  status: 'connected' | 'expired' | 'missing_scope' | 'disconnected';
  last_error: string | null;
};

type OAuthAppRow = {
  operator_id?: string;
  platform_code: string;
  client_id: string;
  client_secret_encrypted: string;
  redirect_uri: string;
  scopes: string[] | null;
  metadata?: Record<string, unknown>;
  active: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function stateDigest(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex');
}

function stateExpiryIso(): string {
  return new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000).toISOString();
}

function normalizeScopes(scopes: string[] | null | undefined, platform: string): string[] {
  const out = (scopes ?? [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return out.length > 0 ? out : (PLATFORM_SCOPES[platform] ?? []);
}

function socialRedirectBase() {
  return process.env.SOCIAL_OAUTH_SUCCESS_REDIRECT || 'http://localhost:3000/dashboard/social-connectors';
}

async function getOperatorOAuthAppRow(platform: string, operatorId?: string | null): Promise<OAuthAppRow | null> {
  if (!operatorId) return null;

  const { data, error } = await supabase
    .from('social_operator_oauth_apps')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('platform_code', platform)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01' || error.code === 'PGRST116') return null;
    throw error;
  }

  return (data as OAuthAppRow | null) ?? null;
}

async function getGlobalOAuthAppRow(platform: string): Promise<OAuthAppRow | null> {
  const { data, error } = await supabase
    .from('social_global_oauth_apps')
    .select('*')
    .eq('platform_code', platform)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01' || error.code === 'PGRST116') return null;
    throw error;
  }

  return (data as OAuthAppRow | null) ?? null;
}

function toOAuthConfig(row: OAuthAppRow, platform: string): OAuthAppConfig {
  return {
    clientId: String(row.client_id || '').trim(),
    clientSecret: decryptSocialSecret(String(row.client_secret_encrypted || '').trim()),
    redirectUri: String(row.redirect_uri || '').trim(),
    scopes: normalizeScopes(row.scopes, platform),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

async function resolveOAuthAppConfig(platform: string, operatorId?: string | null): Promise<OAuthAppConfig> {
  const operator = await getOperatorOAuthAppRow(platform, operatorId);
  if (operator) return toOAuthConfig(operator, platform);

  const global = await getGlobalOAuthAppRow(platform);
  if (global) return toOAuthConfig(global, platform);

  throw new Error(`${platform} app credentials not configured (operator override or global default)`);
}

export async function hasOAuthAppConfig(platform: string, operatorId?: string | null): Promise<boolean> {
  const op = await getOperatorOAuthAppRow(platform, operatorId);
  if (op) return true;
  const global = await getGlobalOAuthAppRow(platform);
  return Boolean(global);
}

export async function getConnectionStatuses(userId?: string | null, operatorId?: string | null) {
  if (!userId || !operatorId) return [];

  const { data, error } = await supabase
    .from('social_oauth_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('operator_id', operatorId)
    .order('platform_code', { ascending: true });

  if (error) {
    if (error.code === 'PGRST205') return [];
    throw error;
  }

  return (data ?? []).map((row: ConnectionRow) => {
    if (row.platform_code === 'linkedin') {
      const status = checkLinkedInConnectionStatus({
        access_token_encrypted: row.access_token_encrypted,
        refresh_token_encrypted: row.refresh_token_encrypted,
        expires_at: row.expires_at,
        scopes: row.scopes,
        metadata: row.metadata,
      });
      return {
        platform_code: row.platform_code,
        status: status.status,
        reason: status.reason ?? row.last_error ?? null,
        scopes: row.scopes ?? [],
        expires_at: row.expires_at,
        metadata: row.metadata ?? {},
      };
    }

    const status = checkConnectionStatus({
      access_token_encrypted: row.access_token_encrypted,
      expires_at: row.expires_at,
      scopes: row.scopes,
    }, PLATFORM_SCOPES[row.platform_code] ?? []);

    return {
      platform_code: row.platform_code,
      status: status.status,
      reason: status.reason ?? row.last_error ?? null,
      scopes: row.scopes ?? [],
      expires_at: row.expires_at,
      metadata: row.metadata ?? {},
    };
  });
}

async function upsertConnection(params: {
  platform: string;
  userId: string;
  operatorId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresInSeconds?: number | null;
  scopes: string[];
  metadata?: Record<string, unknown>;
}) {
  const expiresAt = params.expiresInSeconds
    ? new Date(Date.now() + Number(params.expiresInSeconds || 3600) * 1000).toISOString()
    : null;

  const row = {
    platform_code: params.platform,
    user_id: params.userId,
    operator_id: params.operatorId,
    access_token_encrypted: encryptSocialSecret(params.accessToken),
    refresh_token_encrypted: params.refreshToken ? encryptSocialSecret(params.refreshToken) : null,
    expires_at: expiresAt,
    scopes: params.scopes,
    metadata: {
      ...(params.metadata ?? {}),
      connected_at: nowIso(),
    },
    status: 'connected',
    last_error: null,
    updated_at: nowIso(),
  };

  const upsert = await supabase
    .from('social_oauth_connections')
    .upsert(row, { onConflict: 'platform_code,user_id,operator_id' })
    .select('*')
    .single();

  if (upsert.error) throw upsert.error;

  await supabase
    .from('social_connectors')
    .update({
      auth_type: 'oauth2',
      credentials_active: true,
      status: 'api_enabled',
      updated_at: nowIso(),
    })
    .eq('code', params.platform);

  return upsert.data;
}

export async function startPlatformConnect(platform: string, userId?: string | null, operatorId?: string | null) {
  if (!userId || !operatorId) throw new Error('User/operator context is required');

  const normalized = String(platform || '').trim().toLowerCase();
  const appConfig = await resolveOAuthAppConfig(normalized, operatorId);

  if (OAUTH_PLATFORMS.has(normalized)) {
    const stateRaw = crypto.randomBytes(24).toString('hex');
    const stateHash = stateDigest(stateRaw);

    const { error } = await supabase
      .from('social_oauth_states')
      .insert({
        state_hash: stateHash,
        platform_code: normalized,
        user_id: userId,
        operator_id: operatorId,
        expires_at: stateExpiryIso(),
        created_at: nowIso(),
      });

    if (error) throw error;

    if (normalized === 'linkedin') {
      return linkedInAuthorizeUrl(stateRaw, appConfig as LinkedInOAuthAppConfig);
    }
    if (normalized === 'meta') {
      return metaAuthorizeUrl(stateRaw, appConfig);
    }
    if (normalized === 'reddit') {
      return redditAuthorizeUrl(stateRaw, appConfig);
    }
  }

  if (DIRECT_VALIDATE_PLATFORMS.has(normalized)) {
    if (normalized === 'telegram') {
      const identity = await validateTelegramBot(
        String((await getOperatorOAuthAppRow(normalized, operatorId) || await getGlobalOAuthAppRow(normalized))?.client_secret_encrypted || ''),
        (await getOperatorOAuthAppRow(normalized, operatorId) || await getGlobalOAuthAppRow(normalized))?.metadata as Record<string, unknown> || {}
      );

      await upsertConnection({
        platform: normalized,
        userId,
        operatorId,
        accessToken: appConfig.clientSecret,
        scopes: [],
        metadata: identity,
      });
    }

    if (normalized === 'whatsapp') {
      const row = await getOperatorOAuthAppRow(normalized, operatorId) || await getGlobalOAuthAppRow(normalized);
      if (!row) throw new Error('WhatsApp app credentials missing');
      const identity = await validateWhatsappAccess(String(row.client_secret_encrypted || ''), (row.metadata ?? {}) as Record<string, unknown>);

      await upsertConnection({
        platform: normalized,
        userId,
        operatorId,
        accessToken: appConfig.clientSecret,
        scopes: [],
        metadata: identity,
      });
    }

    return `${socialRedirectBase()}?social_connected=${encodeURIComponent(normalized)}`;
  }

  throw new Error(`Unsupported platform connect flow: ${normalized}`);
}

async function consumeOauthState(stateRaw: string, platform: string) {
  const stateHash = stateDigest(stateRaw);
  const { data, error } = await supabase
    .from('social_oauth_states')
    .select('*')
    .eq('state_hash', stateHash)
    .eq('platform_code', platform)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  if (!data) throw new Error('Invalid oauth state');

  if (new Date(String(data.expires_at)).getTime() < Date.now()) {
    await supabase.from('social_oauth_states').delete().eq('id', data.id);
    throw new Error('OAuth state expired');
  }

  await supabase.from('social_oauth_states').delete().eq('id', data.id);
  return data;
}

export async function handlePlatformCallback(params: {
  platform: string;
  code?: string;
  state?: string;
}) {
  const { platform, code, state } = params;
  const normalized = String(platform || '').trim().toLowerCase();
  if (!OAUTH_PLATFORMS.has(normalized)) throw new Error(`Unsupported callback platform: ${normalized}`);
  if (!code) throw new Error('Missing oauth code');
  if (!state) throw new Error('Missing oauth state');

  const stateRow = await consumeOauthState(state, normalized);
  const appConfig = await resolveOAuthAppConfig(normalized, String(stateRow.operator_id));

  if (normalized === 'linkedin') {
    const token = await exchangeLinkedInCode(code, appConfig as LinkedInOAuthAppConfig);
    const actorUrn = await fetchLinkedInActorUrn(token.access_token);

    return upsertConnection({
      platform: normalized,
      userId: String(stateRow.user_id),
      operatorId: String(stateRow.operator_id),
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresInSeconds: token.expires_in,
      scopes: normalizeScopes(appConfig.scopes, normalized),
      metadata: {
        actor_urn: actorUrn,
        refresh_token_expires_in: token.refresh_token_expires_in ?? null,
      },
    });
  }

  if (normalized === 'meta') {
    const token = await exchangeMetaCode(code, appConfig);
    const profile = await fetchMetaIdentity(token.access_token);

    return upsertConnection({
      platform: normalized,
      userId: String(stateRow.user_id),
      operatorId: String(stateRow.operator_id),
      accessToken: token.access_token,
      expiresInSeconds: token.expires_in,
      scopes: normalizeScopes(appConfig.scopes, normalized),
      metadata: {
        profile,
      },
    });
  }

  const token = await exchangeRedditCode(code, appConfig);
  const userAgent = String(appConfig.metadata?.user_agent || 'obaol-social-connector/1.0').trim();
  const profile = await fetchRedditIdentity(token.access_token, userAgent);

  return upsertConnection({
    platform: normalized,
    userId: String(stateRow.user_id),
    operatorId: String(stateRow.operator_id),
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresInSeconds: token.expires_in,
    scopes: normalizeScopes((token.scope ? token.scope.split(' ') : appConfig.scopes), normalized),
    metadata: {
      profile,
      user_agent: userAgent,
    },
  });
}

export async function disconnectPlatform(platform: string, userId?: string | null, operatorId?: string | null) {
  if (!userId || !operatorId) throw new Error('User/operator context is required');

  const { error } = await supabase
    .from('social_oauth_connections')
    .delete()
    .eq('platform_code', platform)
    .eq('user_id', userId)
    .eq('operator_id', operatorId);

  if (error) throw error;

  const remaining = await supabase
    .from('social_oauth_connections')
    .select('id', { count: 'exact', head: true })
    .eq('platform_code', platform);

  const stillConnected = Number(remaining.count ?? 0) > 0;
  await supabase
    .from('social_connectors')
    .update({
      credentials_active: stillConnected,
      status: stillConnected ? 'api_enabled' : 'manual_assisted',
      auth_type: stillConnected ? 'oauth2' : 'none',
      updated_at: nowIso(),
    })
    .eq('code', platform);

  return { success: true };
}

export async function getOperatorPlatformConnection(platform: string, userId?: string | null, operatorId?: string | null) {
  if (!userId || !operatorId) return null;

  const { data, error } = await supabase
    .from('social_oauth_connections')
    .select('*')
    .eq('platform_code', platform)
    .eq('user_id', userId)
    .eq('operator_id', operatorId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  return data as ConnectionRow | null;
}

export async function markConnectionFailure(platform: string, userId?: string | null, operatorId?: string | null, message?: string) {
  if (!userId || !operatorId) return;

  await supabase
    .from('social_oauth_connections')
    .update({
      status: 'disconnected',
      last_error: message ?? 'Connection failed',
      updated_at: nowIso(),
    })
    .eq('platform_code', platform)
    .eq('user_id', userId)
    .eq('operator_id', operatorId);
}
