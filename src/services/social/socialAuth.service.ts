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

const STATE_TTL_MINUTES = 15;

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
  operator_id: string;
  platform_code: string;
  client_id: string;
  client_secret_encrypted: string;
  redirect_uri: string;
  scopes: string[] | null;
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

const DEFAULT_LINKEDIN_SCOPES = ['w_member_social', 'r_liteprofile'];

function normalizeScopes(scopes: string[] | null | undefined): string[] {
  const out = (scopes ?? [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return out.length > 0 ? out : DEFAULT_LINKEDIN_SCOPES;
}

export async function hasOperatorOAuthAppConfig(platform: string, operatorId?: string | null): Promise<boolean> {
  if (!operatorId) return false;
  const { count, error } = await supabase
    .from('social_operator_oauth_apps')
    .select('operator_id', { head: true, count: 'exact' })
    .eq('operator_id', operatorId)
    .eq('platform_code', platform)
    .eq('active', true);

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return false;
    throw error;
  }

  return Number(count ?? 0) > 0;
}

async function getOperatorOAuthAppConfig(platform: string, operatorId?: string | null): Promise<LinkedInOAuthAppConfig> {
  if (!operatorId) throw new Error('Operator context is required');

  const { data, error } = await supabase
    .from('social_operator_oauth_apps')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('platform_code', platform)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      throw new Error('LinkedIn app credentials store is not set up. Run social OAuth app migration.');
    }
    throw error;
  }

  if (!data) {
    throw new Error('LinkedIn app credentials not configured for this operator');
  }

  const row = data as OAuthAppRow;
  return {
    clientId: String(row.client_id || '').trim(),
    clientSecret: decryptSocialSecret(String(row.client_secret_encrypted || '').trim()),
    redirectUri: String(row.redirect_uri || '').trim(),
    scopes: normalizeScopes(row.scopes),
  };
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

    return {
      platform_code: row.platform_code,
      status: row.status,
      reason: row.last_error ?? null,
      scopes: row.scopes ?? [],
      expires_at: row.expires_at,
      metadata: row.metadata ?? {},
    };
  });
}

export async function startPlatformConnect(platform: string, userId?: string | null, operatorId?: string | null) {
  if (!userId || !operatorId) throw new Error('User/operator context is required');
  if (platform !== 'linkedin') throw new Error(`Unsupported platform connect flow: ${platform}`);
  const appConfig = await getOperatorOAuthAppConfig(platform, operatorId);

  const stateRaw = crypto.randomBytes(24).toString('hex');
  const stateHash = stateDigest(stateRaw);

  const { error } = await supabase
    .from('social_oauth_states')
    .insert({
      state_hash: stateHash,
      platform_code: platform,
      user_id: userId,
      operator_id: operatorId,
      expires_at: stateExpiryIso(),
      created_at: nowIso(),
    });

  if (error) throw error;
  return linkedInAuthorizeUrl(stateRaw, appConfig);
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
  if (platform !== 'linkedin') throw new Error(`Unsupported callback platform: ${platform}`);
  if (!code) throw new Error('Missing oauth code');
  if (!state) throw new Error('Missing oauth state');

  const stateRow = await consumeOauthState(state, platform);
  const appConfig = await getOperatorOAuthAppConfig(platform, String(stateRow.operator_id));
  const token = await exchangeLinkedInCode(code, appConfig);
  const actorUrn = await fetchLinkedInActorUrn(token.access_token);
  const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();

  const scope = normalizeScopes(appConfig.scopes);

  const row = {
    platform_code: platform,
    user_id: String(stateRow.user_id),
    operator_id: String(stateRow.operator_id),
    access_token_encrypted: encryptSocialSecret(token.access_token),
    refresh_token_encrypted: token.refresh_token ? encryptSocialSecret(token.refresh_token) : null,
    expires_at: expiresAt,
    scopes: scope,
    metadata: {
      actor_urn: actorUrn,
      token_expires_in: token.expires_in,
      refresh_token_expires_in: token.refresh_token_expires_in ?? null,
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
    .eq('code', platform);

  return upsert.data;
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
