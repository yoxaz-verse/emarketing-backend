import { supabase } from '../../supabase';
import { encryptSocialSecret } from '../../utils/socialIntegrationEncryption';
import { bootstrapSocialPublishingAutomation } from '../agents/agentMissions.service';
import { getConnectionStatuses, startPlatformConnect } from './socialAuth.service';
import { listSocialConnectors } from './social.service';

type SocialPlatform = 'linkedin' | 'meta' | 'reddit' | 'telegram' | 'whatsapp';
type CredentialSource = 'operator' | 'global' | 'env' | 'missing';

const SOCIAL_PLATFORMS: SocialPlatform[] = ['linkedin', 'meta', 'reddit', 'telegram', 'whatsapp'];
const SECRET_PLACEHOLDER = '***';
const DEFAULT_SCOPES: Record<SocialPlatform, string[]> = {
  linkedin: ['w_member_social'],
  meta: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'business_management', 'instagram_basic', 'instagram_content_publish'],
  reddit: ['identity', 'submit'],
  telegram: [],
  whatsapp: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePlatform(input: unknown): SocialPlatform {
  const platform = String(input ?? '').trim().toLowerCase();
  if (!SOCIAL_PLATFORMS.includes(platform as SocialPlatform)) throw new Error('Unsupported platform');
  return platform as SocialPlatform;
}

function requiredFieldsByPlatform(platform: SocialPlatform): string[] {
  if (platform === 'linkedin') return ['client_id', 'client_secret', 'redirect_uri'];
  if (platform === 'meta') return ['app_id', 'app_secret', 'redirect_uri'];
  if (platform === 'reddit') return ['client_id', 'client_secret', 'redirect_uri', 'user_agent'];
  if (platform === 'telegram') return ['bot_token', 'chat_id'];
  return ['phone_number_id', 'business_account_id', 'access_token'];
}

function normalizeScopes(input: unknown, platform: SocialPlatform): string[] {
  const scopes = Array.isArray(input)
    ? input
    : String(input ?? '').split(/[,\s]+/);
  const normalized = scopes.map((scope) => String(scope ?? '').trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : DEFAULT_SCOPES[platform];
}

function extractConfig(platform: SocialPlatform, input: Record<string, unknown>) {
  const trim = (value: unknown) => String(value ?? '').trim();

  if (platform === 'linkedin') {
    return {
      client_id: trim(input.client_id),
      secret: trim(input.client_secret),
      redirect_uri: trim(input.redirect_uri),
      scopes: normalizeScopes(input.scopes, platform),
      metadata: trim(input.actor_urn) ? { actor_urn: trim(input.actor_urn) } : {},
      check: {
        client_id: trim(input.client_id),
        client_secret: trim(input.client_secret),
        redirect_uri: trim(input.redirect_uri),
      },
    };
  }

  if (platform === 'meta') {
    return {
      client_id: trim(input.app_id),
      secret: trim(input.app_secret),
      redirect_uri: trim(input.redirect_uri),
      scopes: DEFAULT_SCOPES.meta,
      metadata: {
        page_access_token: trim(input.page_access_token),
        business_account_id: trim(input.business_account_id),
      },
      check: {
        app_id: trim(input.app_id),
        app_secret: trim(input.app_secret),
        redirect_uri: trim(input.redirect_uri),
      },
    };
  }

  if (platform === 'reddit') {
    return {
      client_id: trim(input.client_id),
      secret: trim(input.client_secret),
      redirect_uri: trim(input.redirect_uri),
      scopes: DEFAULT_SCOPES.reddit,
      metadata: { user_agent: trim(input.user_agent) },
      check: {
        client_id: trim(input.client_id),
        client_secret: trim(input.client_secret),
        redirect_uri: trim(input.redirect_uri),
        user_agent: trim(input.user_agent),
      },
    };
  }

  if (platform === 'telegram') {
    return {
      client_id: '',
      secret: trim(input.bot_token),
      redirect_uri: '',
      scopes: [],
      metadata: { chat_id: trim(input.chat_id) },
      check: {
        bot_token: trim(input.bot_token),
        chat_id: trim(input.chat_id),
      },
    };
  }

  return {
    client_id: trim(input.phone_number_id),
    secret: trim(input.access_token),
    redirect_uri: '',
    scopes: [],
    metadata: {
      business_account_id: trim(input.business_account_id),
      phone_number_id: trim(input.phone_number_id),
    },
    check: {
      phone_number_id: trim(input.phone_number_id),
      business_account_id: trim(input.business_account_id),
      access_token: trim(input.access_token),
    },
  };
}

async function getOperatorCredentialRow(platform: SocialPlatform, operatorId: string) {
  const { data, error } = await supabase
    .from('social_operator_oauth_apps')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('platform_code', platform)
    .eq('active', true)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  return data as any | null;
}

function hasSavedSecret(row: any): boolean {
  return Boolean(String(row?.client_secret_encrypted ?? '').trim());
}

function missingRequired(platform: SocialPlatform, source: Record<string, string>): string[] {
  return requiredFieldsByPlatform(platform).filter((key) => !String(source[key] ?? '').trim());
}

function safeFields(platform: SocialPlatform, row: any | null): Record<string, string> {
  if (!row) return {};
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const secret = hasSavedSecret(row) ? SECRET_PLACEHOLDER : '';

  if (platform === 'linkedin') {
    return {
      client_id: String(row.client_id ?? ''),
      client_secret: secret,
      redirect_uri: String(row.redirect_uri ?? ''),
      scopes: Array.isArray(row.scopes) ? row.scopes.join(',') : '',
      actor_urn: String(metadata.actor_urn ?? ''),
    };
  }
  if (platform === 'meta') {
    return {
      app_id: String(row.client_id ?? ''),
      app_secret: secret,
      redirect_uri: String(row.redirect_uri ?? ''),
      page_access_token: metadata.page_access_token ? SECRET_PLACEHOLDER : '',
      business_account_id: String(metadata.business_account_id ?? ''),
    };
  }
  if (platform === 'reddit') {
    return {
      client_id: String(row.client_id ?? ''),
      client_secret: secret,
      redirect_uri: String(row.redirect_uri ?? ''),
      user_agent: String(metadata.user_agent ?? ''),
    };
  }
  if (platform === 'telegram') {
    return {
      bot_token: secret,
      chat_id: String(metadata.chat_id ?? ''),
    };
  }
  return {
    phone_number_id: String(metadata.phone_number_id ?? row.client_id ?? ''),
    business_account_id: String(metadata.business_account_id ?? ''),
    access_token: secret,
  };
}

function credentialCheckMap(platform: SocialPlatform, row: any | null): Record<string, string> {
  const fields = safeFields(platform, row);
  if (platform === 'linkedin') return fields;
  if (platform === 'meta') return fields;
  if (platform === 'reddit') return fields;
  if (platform === 'telegram') return fields;
  return fields;
}

function metaAccountSelection(connection: any | null) {
  const metadata = connection?.metadata && typeof connection.metadata === 'object' ? connection.metadata : {};
  const pages = Array.isArray(metadata.pages) ? metadata.pages : [];
  return {
    pages: pages.map((page: any) => ({
      id: String(page?.id ?? ''),
      name: String(page?.name ?? ''),
      instagram_business_account: page?.instagram_business_account ?? null,
    })).filter((page: any) => page.id),
    selected_page_id: String(metadata.selected_page_id ?? ''),
    selected_page_name: String(metadata.selected_page_name ?? ''),
    selected_instagram_account_id: String(metadata.selected_instagram_account_id ?? ''),
    selected_instagram_username: String(metadata.selected_instagram_username ?? ''),
    discovery_error: metadata.account_discovery_error ?? null,
  };
}

function envCredentialRow(platform: SocialPlatform) {
  if (platform !== 'linkedin') return null;

  const clientId = String(process.env.LINKEDIN_CLIENT_ID ?? '').trim();
  const clientSecret = String(process.env.LINKEDIN_CLIENT_SECRET ?? '').trim();
  const redirectUri = String(process.env.LINKEDIN_REDIRECT_URI ?? '').trim();
  if (!clientId || !clientSecret || !redirectUri) return null;

  return {
    platform_code: platform,
    client_id: clientId,
    client_secret_encrypted: 'env-configured',
    redirect_uri: redirectUri,
    scopes: normalizeScopes(process.env.LINKEDIN_SCOPES, platform),
    metadata: {},
    active: true,
  };
}

function resolveEffectiveCredential(params: {
  platform: SocialPlatform;
  operatorRow?: any | null;
  globalRow?: any | null;
}): { row: any | null; source: CredentialSource } {
  if (params.operatorRow) return { row: params.operatorRow, source: 'operator' };
  if (params.globalRow) return { row: params.globalRow, source: 'global' };

  const envRow = envCredentialRow(params.platform);
  if (envRow) return { row: envRow, source: 'env' };

  return { row: null, source: 'missing' };
}

export function summarizePlatformCredential(params: {
  platform: SocialPlatform;
  operatorRow?: any | null;
  globalRow?: any | null;
}) {
  const { row, source } = resolveEffectiveCredential(params);
  const fields = safeFields(params.platform, row);
  const missing = missingRequired(params.platform, credentialCheckMap(params.platform, row));
  const configured = Boolean(row) && missing.length === 0;

  return {
    row,
    source: configured ? source : 'missing',
    fields,
    missing: configured ? [] : missing,
    configured,
    oneClickAvailable: params.platform === 'linkedin' && configured,
  };
}

export async function saveOperatorSocialCredentials(params: {
  platform: unknown;
  operatorId?: string | null;
  input: Record<string, unknown>;
}) {
  const platform = normalizePlatform(params.platform);
  const operatorId = String(params.operatorId ?? '').trim();
  if (!operatorId) throw new Error('operator_id is required');

  const existing = await getOperatorCredentialRow(platform, operatorId);
  const extracted = extractConfig(platform, params.input ?? {});
  const existingSecret = String(existing?.client_secret_encrypted ?? '').trim();
  const secretIsPlaceholder = String(extracted.secret ?? '').trim() === SECRET_PLACEHOLDER;

  const check: Record<string, string> = {};
  for (const [key, value] of Object.entries(extracted.check)) {
    if (typeof value === 'string') check[key] = value;
  }
  const secretField = platform === 'linkedin' || platform === 'reddit' ? 'client_secret'
    : platform === 'meta' ? 'app_secret'
      : platform === 'telegram' ? 'bot_token'
        : 'access_token';
  if (secretIsPlaceholder && existingSecret) check[secretField] = existingSecret;

  const missing = missingRequired(platform, check);
  if (missing.length > 0) throw new Error(`Missing required fields: ${missing.join(', ')}`);

  const metadata = { ...(extracted.metadata ?? {}) };
  if (
    platform === 'meta' &&
    String((metadata as any).page_access_token ?? '').trim() === SECRET_PLACEHOLDER &&
    existing?.metadata &&
    typeof existing.metadata === 'object'
  ) {
    (metadata as any).page_access_token = String(existing.metadata.page_access_token ?? '');
  }

  const payload = {
    platform_code: platform,
    operator_id: operatorId,
    client_id: extracted.client_id || null,
    client_secret_encrypted: secretIsPlaceholder && existingSecret
      ? existingSecret
      : encryptSocialSecret(String(extracted.secret ?? '').trim()),
    redirect_uri: extracted.redirect_uri || null,
    scopes: extracted.scopes,
    metadata,
    active: true,
    updated_at: nowIso(),
  };

  const { error } = await supabase
    .from('social_operator_oauth_apps')
    .upsert(payload, { onConflict: 'operator_id,platform_code' });
  if (error) throw error;

  return {
    success: true,
    platform_code: platform,
    operator_id: operatorId,
    configured: true,
    required_missing: [],
  };
}

export async function getSocialSetupStatus(userId?: string | null, operatorId?: string | null) {
  if (!userId || !operatorId) {
    return {
      operator_id: operatorId ?? null,
      ready: false,
      next_action: 'select_operator',
      automation: { enabled: false, agent_id: null, mission_id: null },
      platforms: [],
    };
  }

  const [connectors, connections, operatorCredentialRows, globalCredentialRows, missions] = await Promise.all([
    listSocialConnectors(userId, operatorId),
    getConnectionStatuses(userId, operatorId),
    supabase
      .from('social_operator_oauth_apps')
      .select('*')
      .eq('operator_id', operatorId)
      .eq('active', true),
    supabase
      .from('social_global_oauth_apps')
      .select('*')
      .eq('active', true),
    supabase
      .from('agent_missions')
      .select('id,agent_id,role_key,task_type,active,operator_id,metadata')
      .eq('operator_id', operatorId)
      .eq('role_key', 'social_post_creator')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (operatorCredentialRows.error && operatorCredentialRows.error.code !== 'PGRST205' && operatorCredentialRows.error.code !== '42P01') throw operatorCredentialRows.error;
  if (globalCredentialRows.error && globalCredentialRows.error.code !== 'PGRST205' && globalCredentialRows.error.code !== '42P01') throw globalCredentialRows.error;
  if (missions.error && missions.error.code !== 'PGRST116' && missions.error.code !== 'PGRST205' && missions.error.code !== '42P01') throw missions.error;

  const operatorCredentialByPlatform = new Map<string, any>();
  for (const row of operatorCredentialRows.data ?? []) {
    operatorCredentialByPlatform.set(String((row as any).platform_code ?? '').toLowerCase(), row);
  }
  const globalCredentialByPlatform = new Map<string, any>();
  for (const row of globalCredentialRows.data ?? []) {
    globalCredentialByPlatform.set(String((row as any).platform_code ?? '').toLowerCase(), row);
  }
  const connectionByPlatform = new Map<string, any>();
  for (const connection of connections as any[]) {
    connectionByPlatform.set(String(connection.platform_code ?? '').toLowerCase(), connection);
  }
  const connectorByPlatform = new Map<string, any>();
  for (const connector of connectors as any[]) {
    connectorByPlatform.set(String(connector.code ?? '').toLowerCase(), connector);
  }

  const platforms = SOCIAL_PLATFORMS.map((platform) => {
    const credentialSummary = summarizePlatformCredential({
      platform,
      operatorRow: operatorCredentialByPlatform.get(platform) ?? null,
      globalRow: globalCredentialByPlatform.get(platform) ?? null,
    });
    const credential = credentialSummary.row;
    const connection = connectionByPlatform.get(platform) ?? null;
    const connector = connectorByPlatform.get(platform) ?? null;
    const credentialConfigured = credentialSummary.configured;
    const connected = connection?.status === 'connected';
    const accountSelection = platform === 'meta' ? metaAccountSelection(connection) : null;
    const needsAccountSelection = platform === 'meta' && connected && !String(accountSelection?.selected_page_id ?? '').trim();

    return {
      platform_code: platform,
      label: connector?.name ?? platform,
      credential_configured: credentialConfigured,
      credential_missing_fields: credentialSummary.missing,
      credential_source: credentialSummary.source,
      one_click_available: credentialSummary.oneClickAvailable,
      credential_fields: credentialSummary.fields,
      connection_status: connection?.status ?? 'disconnected',
      connection_reason: connection?.reason ?? null,
      connected,
      can_schedule: Boolean(connector?.can_schedule),
      can_publish: Boolean(connector?.can_publish),
      account_selection: accountSelection,
      setup_ready: credentialConfigured && connected && !needsAccountSelection,
      next_action: !credentialConfigured
        ? 'configure_credentials'
        : !connected
          ? 'connect_account'
          : needsAccountSelection
            ? 'select_account'
            : 'ready',
    };
  });

  const connectedPlatforms = platforms.filter((platform) => platform.setup_ready);
  const mission = missions.data as any | null;
  const automationEnabled = Boolean(mission?.id && mission?.active);
  const oneClickConnectable = platforms.find((platform) => platform.one_click_available && !platform.connected);
  const anyConnectable = platforms.find((platform) => platform.credential_configured && !platform.connected);
  const anyUnconfigured = platforms.some((platform) => !platform.credential_configured);

  return {
    operator_id: operatorId,
    ready: connectedPlatforms.length > 0 && automationEnabled,
    next_action: connectedPlatforms.length > 0
      ? automationEnabled
        ? 'ready'
        : 'enable_automation'
      : oneClickConnectable || anyConnectable
        ? 'connect_account'
        : anyUnconfigured
          ? 'configure_credentials'
          : 'connect_account',
    automation: {
      enabled: automationEnabled,
      agent_id: mission?.agent_id ?? null,
      mission_id: mission?.id ?? null,
    },
    platforms,
  };
}

export async function startSocialSetupConnect(params: {
  platform: unknown;
  userId?: string | null;
  operatorId?: string | null;
}) {
  const platform = normalizePlatform(params.platform);
  const operatorId = String(params.operatorId ?? '').trim();
  if (!operatorId) throw new Error('operator_id is required');

  const [operatorCredential, globalCredentialResult] = await Promise.all([
    getOperatorCredentialRow(platform, operatorId),
    supabase
      .from('social_global_oauth_apps')
      .select('*')
      .eq('platform_code', platform)
      .eq('active', true)
      .maybeSingle(),
  ]);
  if (globalCredentialResult.error && globalCredentialResult.error.code !== 'PGRST116') throw globalCredentialResult.error;

  const credentialSummary = summarizePlatformCredential({
    platform,
    operatorRow: operatorCredential,
    globalRow: globalCredentialResult.data ?? null,
  });
  if (!credentialSummary.configured) {
    const err: any = new Error(
      platform === 'linkedin'
        ? 'LinkedIn is not ready for one-click connect. Configure the global OBAOL LinkedIn app credentials first.'
        : `${platform} credentials are required before connect`
    );
    err.statusCode = 400;
    err.details = { missing_fields: credentialSummary.missing.length > 0 ? credentialSummary.missing : requiredFieldsByPlatform(platform) };
    throw err;
  }

  const redirectUrl = await startPlatformConnect(platform, params.userId, operatorId);
  return {
    platform_code: platform,
    operator_id: operatorId,
    credential_source: credentialSummary.source,
    redirect_url: redirectUrl,
  };
}

export async function saveMetaAccountSelection(params: {
  userId?: string | null;
  operatorId?: string | null;
  pageId?: string | null;
  instagramAccountId?: string | null;
}) {
  const userId = String(params.userId ?? '').trim();
  const operatorId = String(params.operatorId ?? '').trim();
  const pageId = String(params.pageId ?? '').trim();
  const instagramAccountId = String(params.instagramAccountId ?? '').trim();
  if (!userId || !operatorId) throw new Error('User/operator context is required');
  if (!pageId) throw new Error('selected_page_id is required');

  const { data, error } = await supabase
    .from('social_oauth_connections')
    .select('*')
    .eq('platform_code', 'meta')
    .eq('user_id', userId)
    .eq('operator_id', operatorId)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) throw new Error('Meta connection not found');

  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const pages = Array.isArray(metadata.pages) ? metadata.pages : [];
  const selectedPage = pages.find((page: any) => String(page?.id ?? '').trim() === pageId);
  if (!selectedPage) throw new Error('Selected Meta page was not discovered for this connection');

  const instagram = selectedPage.instagram_business_account;
  const selectedInstagram = instagramAccountId
    ? String(instagram?.id ?? '').trim() === instagramAccountId ? instagram : null
    : instagram ?? null;
  if (instagramAccountId && !selectedInstagram) throw new Error('Selected Instagram account is not linked to the selected Meta page');

  const nextMetadata = {
    ...metadata,
    selected_page_id: pageId,
    selected_page_name: selectedPage.name ?? null,
    selected_instagram_account_id: selectedInstagram?.id ?? null,
    selected_instagram_username: selectedInstagram?.username ?? selectedInstagram?.name ?? null,
    selected_page_access_token_encrypted: selectedPage.access_token_encrypted ??
      (String(metadata.selected_page_id ?? '').trim() === pageId ? metadata.selected_page_access_token_encrypted : null),
  };

  const update = await supabase
    .from('social_oauth_connections')
    .update({
      metadata: nextMetadata,
      status: 'connected',
      last_error: null,
      updated_at: nowIso(),
    })
    .eq('id', data.id)
    .select('*')
    .single();
  if (update.error) throw update.error;

  return {
    success: true,
    platform_code: 'meta',
    account_selection: metaAccountSelection(update.data),
  };
}

export async function enableSocialAutomation(params: {
  userId?: string | null;
  operatorId?: string | null;
  timezone?: string | null;
}) {
  const operatorId = String(params.operatorId ?? '').trim();
  if (!operatorId) throw new Error('operator_id is required');
  const data = await bootstrapSocialPublishingAutomation({
    userId: params.userId,
    operatorId,
  }, {
    timezone: String(params.timezone ?? '').trim() || 'Asia/Kolkata',
  });
  return { success: true, ...data };
}
