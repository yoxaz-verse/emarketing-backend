export type MetaChannel = 'facebook' | 'instagram';

export function isMetaChannel(value: string): value is MetaChannel {
  return value === 'facebook' || value === 'instagram';
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
