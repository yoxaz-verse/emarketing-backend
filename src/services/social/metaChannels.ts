export type MetaChannel = 'facebook' | 'instagram';

type MetaPublishingPage = {
  id?: string | null;
  name?: string | null;
  access_token_encrypted?: string | null;
  instagram_business_account?: { id?: string | null; username?: string | null; name?: string | null } | null;
};

export function isMetaChannel(value: string): value is MetaChannel {
  return value === 'facebook' || value === 'instagram';
}

function pageById(pages: MetaPublishingPage[], value: unknown): MetaPublishingPage | null {
  const id = String(value ?? '').trim();
  return id ? pages.find((page) => String(page?.id ?? '').trim() === id) ?? null : null;
}

export function mergeMetaConnectionMetadata(params: {
  previous?: Record<string, any> | null;
  pages: MetaPublishingPage[];
  requestedPlatform?: string | null;
  profile?: Record<string, unknown> | null;
  discoveryError?: string | null;
}): Record<string, any> {
  const previous = params.previous ?? {};
  const discoveredPages = params.pages.filter((page) => String(page?.id ?? '').trim());
  const previousPages = Array.isArray(previous.pages) ? previous.pages as MetaPublishingPage[] : [];
  const pages = params.discoveryError && discoveredPages.length === 0 ? previousPages : discoveredPages;
  const requestedPlatform = String(params.requestedPlatform ?? '').toLowerCase();
  const facebookPages = pages.filter((page) => Boolean(page.access_token_encrypted));
  const instagramPages = facebookPages.filter((page) => Boolean(String(page.instagram_business_account?.id ?? '').trim()));

  const previousFacebook = pageById(facebookPages, previous.selected_facebook_page_id);
  const previousInstagram = pageById(instagramPages, previous.selected_instagram_page_id);
  const nextFacebook = previousFacebook ?? (requestedPlatform === 'facebook' && facebookPages.length === 1 ? facebookPages[0] : null);
  const nextInstagram = previousInstagram ?? (requestedPlatform === 'instagram' && instagramPages.length === 1 ? instagramPages[0] : null);
  const instagramAccount = nextInstagram?.instagram_business_account ?? null;

  const metadata: Record<string, any> = {
    ...previous,
    profile: params.profile ?? previous.profile ?? null,
    pages,
    account_discovery_error: params.discoveryError ?? null,
  };

  if (nextFacebook) metadata.selected_facebook_page_id = String(nextFacebook.id);
  else delete metadata.selected_facebook_page_id;

  if (nextInstagram && instagramAccount?.id) {
    metadata.selected_instagram_page_id = String(nextInstagram.id);
    metadata.selected_instagram_channel_account_id = String(instagramAccount.id);
    metadata.selected_instagram_channel_username = instagramAccount.username ?? instagramAccount.name ?? null;
  } else {
    delete metadata.selected_instagram_page_id;
    delete metadata.selected_instagram_channel_account_id;
    delete metadata.selected_instagram_channel_username;
  }

  // Keep the legacy destination valid for old scheduled Meta jobs without using
  // it to decide the independent Facebook and Instagram channel destinations.
  const legacyPage = pageById(pages, previous.selected_page_id) ?? nextFacebook ?? nextInstagram;
  if (legacyPage) {
    metadata.selected_page_id = String(legacyPage.id);
    metadata.selected_page_name = legacyPage.name ?? null;
    metadata.selected_page_access_token_encrypted = legacyPage.access_token_encrypted ?? null;
    metadata.selected_instagram_account_id = legacyPage.instagram_business_account?.id ?? null;
    metadata.selected_instagram_username = legacyPage.instagram_business_account?.username
      ?? legacyPage.instagram_business_account?.name
      ?? null;
  } else {
    delete metadata.selected_page_id;
    delete metadata.selected_page_name;
    delete metadata.selected_page_access_token_encrypted;
    delete metadata.selected_instagram_account_id;
    delete metadata.selected_instagram_username;
  }

  return metadata;
}

export function metaChannelStatus(channel: MetaChannel, connection: {
  expires_at?: string | null;
  scopes?: string[] | null;
  metadata?: Record<string, any> | null;
}): { status: 'connected' | 'expired' | 'missing_scope' | 'identity_required'; reason: string | null } {
  if (connection.expires_at && new Date(connection.expires_at).getTime() <= Date.now() + 60_000) {
    return { status: 'expired', reason: 'Meta authorization expired. Reconnect to continue publishing.' };
  }
  const scopes = new Set((connection.scopes ?? []).flatMap((scope) => String(scope).split(/[,\s]+/)));
  const required = channel === 'facebook'
    ? ['pages_show_list', 'pages_manage_posts']
    : ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'];
  const missing = required.filter((scope) => !scopes.has(scope));
  if (missing.length) return { status: 'missing_scope', reason: `Missing Meta permissions: ${missing.join(', ')}. Reconnect after enabling them.` };

  const metadata = connection.metadata ?? {};
  const pages = Array.isArray(metadata.pages) ? metadata.pages : [];
  const pageId = String(channel === 'facebook' ? metadata.selected_facebook_page_id ?? '' : metadata.selected_instagram_page_id ?? '').trim();
  const page = pages.find((item: any) => String(item?.id) === pageId);
  if (!pageId || !page?.access_token_encrypted) {
    return { status: 'identity_required', reason: channel === 'facebook'
      ? 'Choose a Facebook Page from the authorized account.'
      : 'Choose a linked Instagram professional account from the authorized Pages.' };
  }
  if (channel === 'instagram' && String(page.instagram_business_account?.id ?? '') !== String(metadata.selected_instagram_channel_account_id ?? '')) {
    return { status: 'identity_required', reason: 'The selected Instagram professional account is no longer linked to its Facebook Page.' };
  }
  return { status: 'connected', reason: null };
}

export function metaChannelPublishingConnection(channel: MetaChannel, connection: any): any {
  const metadata = connection.metadata ?? {};
  const pageId = String(channel === 'facebook' ? metadata.selected_facebook_page_id ?? '' : metadata.selected_instagram_page_id ?? '');
  const pages = Array.isArray(metadata.pages) ? metadata.pages : [];
  const page = pages.find((item: any) => String(item?.id) === pageId);
  return {
    ...connection,
    metadata: {
      ...metadata,
      selected_page_id: pageId,
      selected_page_access_token_encrypted: page?.access_token_encrypted ?? null,
      selected_instagram_account_id: channel === 'instagram' ? metadata.selected_instagram_channel_account_id : null,
    },
  };
}
