import crypto from 'crypto';

export type RecipientMailboxProvider = 'microsoft' | 'google' | 'yahoo_aol' | 'generic';

export type ProviderSafeAuthSnapshot = {
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  dmarcPolicy: string | null;
};

export type DeliverabilityPolicyInput = {
  recipientEmail: string;
  firstTouch: boolean;
  senderDisplayName?: string | null;
  subject: string;
  body: string;
  providerSafeAuth: ProviderSafeAuthSnapshot;
};

export type DeliverabilityPolicy = {
  provider: RecipientMailboxProvider;
  providerSensitive: boolean;
  minimalTracking: boolean;
  useMultipartPlainText: boolean;
  effectiveSenderDisplayName: string;
  sanitizedSubject: string;
  sanitizedBody: string;
  trackingDowngraded: boolean;
  blockReason: 'auth_not_provider_safe' | null;
};

const MICROSOFT_DOMAIN_REGEX = /(?:^|\.)(outlook\.com|hotmail\.com|live\.com|msn\.com)$/i;
const GOOGLE_DOMAIN_REGEX = /(?:^|\.)(gmail\.com|googlemail\.com)$/i;
const YAHOO_AOL_DOMAIN_REGEX = /(?:^|\.)(yahoo\.com|ymail\.com|rocketmail\.com|aol\.com)$/i;
const PERSONAL_SIGNOFF_REGEX = /\b(regards,\s*(jacob|joshua)|joshua|jacob alwin joy|jacob supreme|jacob)\b/i;
const TEAM_IDENTITY_REGEX = /\b(team|obaol)\b/i;

function extractDomain(emailRaw: string): string {
  const normalized = String(emailRaw ?? '').trim().toLowerCase();
  return normalized.includes('@') ? normalized.split('@').pop() ?? '' : '';
}

function collapseWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toneDownSubject(value: string): string {
  return collapseWhitespace(
    value
      .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '')
      .replace(/\b(urgent request|last chance|time is running out|act now)\b/gi, 'Update')
      .replace(/!{2,}/g, '!')
      .replace(/\?{2,}/g, '?')
      .replace(/\s*[-|]\s*(sale|promo|offer)\b/gi, '')
  ) || 'Update from OBAOL';
}

function toneDownBody(value: string): string {
  const normalized = value
    .replace(PERSONAL_SIGNOFF_REGEX, 'OBAOL Team')
    .replace(/[!]{2,}/g, '!')
    .replace(/[?]{2,}/g, '?');
  return collapseWhitespace(normalized) || 'Hello,\n\nSharing an update from OBAOL.\n\nOBAOL Team';
}

export function classifyRecipientProvider(recipientEmail: string): RecipientMailboxProvider {
  const domain = extractDomain(recipientEmail);
  if (MICROSOFT_DOMAIN_REGEX.test(domain)) return 'microsoft';
  if (GOOGLE_DOMAIN_REGEX.test(domain)) return 'google';
  if (YAHOO_AOL_DOMAIN_REGEX.test(domain)) return 'yahoo_aol';
  return 'generic';
}

export function hasEnforcedDmarcPolicy(policyRaw: string | null | undefined): boolean {
  const policy = String(policyRaw ?? '').trim().toLowerCase();
  return policy === 'quarantine' || policy === 'reject';
}

export function isProviderSafeAuthReady(snapshot: ProviderSafeAuthSnapshot): boolean {
  return Boolean(snapshot.spfVerified)
    && Boolean(snapshot.dkimVerified)
    && Boolean(snapshot.dmarcVerified)
    && hasEnforcedDmarcPolicy(snapshot.dmarcPolicy);
}

export function buildCampaignMessageId(input: {
  campaignLeadId: string;
  inboxEmail: string;
  sentAtIso: string;
}): string {
  const domain = extractDomain(input.inboxEmail) || 'obaol.local';
  const digest = crypto
    .createHash('sha256')
    .update(`${input.campaignLeadId}|${input.inboxEmail}|${input.sentAtIso}`)
    .digest('hex')
    .slice(0, 16);
  const seed = `${String(input.campaignLeadId).replace(/[^a-z0-9]/gi, '').toLowerCase()}.${digest}`;
  return `<${seed}@${domain}>`;
}

export function buildCampaignUnsubscribeToken(
  payload: {
    campaign_id: string;
    campaign_lead_id: string;
    lead_id: string;
    email: string;
    exp: number;
  },
  secret: string
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function parseCampaignUnsubscribeToken(
  token: string,
  secret: string
): {
  campaign_id: string;
  campaign_lead_id: string;
  lead_id: string;
  email: string;
  exp: number;
} {
  const [body, sig] = String(token ?? '').trim().split('.');
  if (!body || !sig) throw new Error('Invalid unsubscribe token');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig !== expected) throw new Error('Invalid unsubscribe token');
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid unsubscribe token');
  if (Number(parsed.exp ?? 0) < Math.floor(Date.now() / 1000)) throw new Error('Unsubscribe token expired');
  return {
    campaign_id: String((parsed as any).campaign_id ?? '').trim(),
    campaign_lead_id: String((parsed as any).campaign_lead_id ?? '').trim(),
    lead_id: String((parsed as any).lead_id ?? '').trim(),
    email: String((parsed as any).email ?? '').trim().toLowerCase(),
    exp: Number((parsed as any).exp ?? 0),
  };
}

export function buildListUnsubscribeHeaders(unsubscribeUrl: string, inboxEmail: string): Record<string, string> {
  const mailto = `mailto:${String(inboxEmail ?? '').trim()}?subject=unsubscribe`;
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>, <${mailto}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'X-Auto-Response-Suppress': 'OOF, AutoReply',
    Precedence: 'bulk',
  };
}

export function buildCampaignUnsubscribeFooter(unsubscribeUrl: string): { html: string; text: string } {
  return {
    html: `<hr style="margin-top:24px;margin-bottom:12px"/><p style="font-size:12px;color:#666">If you would prefer not to receive future emails from us, you can <a href="${unsubscribeUrl}">unsubscribe here</a>.</p>`,
    text: `\n\n---\nIf you would prefer not to receive future emails from us, unsubscribe here: ${unsubscribeUrl}`,
  };
}

export function resolveDeliverabilityPolicy(input: DeliverabilityPolicyInput): DeliverabilityPolicy {
  const provider = classifyRecipientProvider(input.recipientEmail);
  const providerSensitive = provider !== 'generic';
  const providerSafeAuthReady = isProviderSafeAuthReady(input.providerSafeAuth);
  const strictPlainMode = input.firstTouch && (provider === 'microsoft' || provider === 'yahoo_aol');
  const minimalTracking = providerSensitive;
  const senderDisplayNameRaw = String(input.senderDisplayName ?? '').trim();
  const effectiveSenderDisplayName = providerSensitive && !TEAM_IDENTITY_REGEX.test(senderDisplayNameRaw)
    ? 'OBAOL Team'
    : (senderDisplayNameRaw || 'OBAOL Team');

  return {
    provider,
    providerSensitive,
    minimalTracking,
    useMultipartPlainText: strictPlainMode || providerSensitive,
    effectiveSenderDisplayName,
    sanitizedSubject: toneDownSubject(input.subject),
    sanitizedBody: toneDownBody(input.body),
    trackingDowngraded: minimalTracking,
    blockReason: providerSensitive && !providerSafeAuthReady ? 'auth_not_provider_safe' : null,
  };
}
