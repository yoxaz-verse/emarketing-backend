import crypto from 'crypto';
import { supabase } from '../supabase';
import { createSmtpTransport } from './email/smtpTransport';
import { decryptSecret } from '../utils/sendEncryption';

const TOKEN_SECRET = process.env.NEWSLETTER_TOKEN_SECRET || process.env.JWT_SECRET || 'newsletter-secret';
const DEFAULT_CONFIRM_TTL_HOURS = Number(process.env.NEWSLETTER_CONFIRM_TTL_HOURS ?? 72);
const DEFAULT_UNSUB_TTL_HOURS = Number(process.env.NEWSLETTER_UNSUB_TTL_HOURS ?? 24 * 365);
const DEFAULT_PREF_TTL_HOURS = Number(process.env.NEWSLETTER_PREF_TTL_HOURS ?? 24 * 365);

function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}

function hashToken(raw: string): string {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(raw).digest('hex');
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function expiresAt(hours: number): string {
  const date = new Date(Date.now() + hours * 60 * 60 * 1000);
  return date.toISOString();
}

async function issueToken(subscriberId: string, purpose: 'confirm' | 'unsubscribe' | 'preferences', ttlHours: number) {
  const token = randomToken();
  const tokenHash = hashToken(token);

  const { error } = await supabase.from('unsubscribe_tokens').insert({
    subscriber_id: subscriberId,
    purpose,
    token_hash: tokenHash,
    expires_at: expiresAt(ttlHours),
  });

  if (error) throw error;
  return token;
}

async function resolveToken(rawToken: string, purpose: 'confirm' | 'unsubscribe' | 'preferences') {
  const tokenHash = hashToken(rawToken);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('unsubscribe_tokens')
    .select('id,subscriber_id,purpose,expires_at,consumed_at')
    .eq('token_hash', tokenHash)
    .eq('purpose', purpose)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Invalid token');
  if (data.consumed_at) throw new Error('Token already used');
  if (new Date(data.expires_at).getTime() < new Date(nowIso).getTime()) {
    throw new Error('Token expired');
  }

  return data;
}

async function consumeToken(id: string) {
  await supabase
    .from('unsubscribe_tokens')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', id)
    .is('consumed_at', null);
}

export async function subscribeNewsletter(input: {
  email: string;
  first_name?: string;
  last_name?: string;
  consent_source?: string;
  consent_evidence?: string;
  consent_ip?: string;
  categories?: string[];
}) {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error('email is required');

  const { data: existing, error: existingError } = await supabase
    .from('newsletter_subscribers')
    .select('id,status,is_suppressed')
    .eq('email', email)
    .maybeSingle();

  if (existingError) throw existingError;

  let subscriberId = existing?.id as string | undefined;

  if (!subscriberId) {
    const { data, error } = await supabase
      .from('newsletter_subscribers')
      .insert({
        email,
        first_name: input.first_name ?? null,
        last_name: input.last_name ?? null,
        status: 'pending',
        consent_source: input.consent_source ?? 'public_form',
        consent_evidence: input.consent_evidence ?? null,
        consent_ip: input.consent_ip ?? null,
      })
      .select('id')
      .single();

    if (error) throw error;
    subscriberId = data.id;
  } else {
    await supabase
      .from('newsletter_subscribers')
      .update({
        first_name: input.first_name ?? undefined,
        last_name: input.last_name ?? undefined,
        consent_source: input.consent_source ?? undefined,
        consent_evidence: input.consent_evidence ?? undefined,
        consent_ip: input.consent_ip ?? undefined,
        status: existing?.status === 'unsubscribed' ? 'pending' : existing?.status,
        is_suppressed: existing?.status === 'unsubscribed' ? false : existing?.is_suppressed,
      })
      .eq('id', subscriberId);
  }

  if (Array.isArray(input.categories) && input.categories.length > 0) {
    const rows = input.categories
      .map((category) => String(category || '').trim())
      .filter(Boolean)
      .map((category) => ({ subscriber_id: subscriberId, category, is_enabled: true }));

    if (rows.length > 0) {
      const { error } = await supabase
        .from('newsletter_preferences')
        .upsert(rows, { onConflict: 'subscriber_id,category' });
      if (error) throw error;
    }
  }

  if (!subscriberId) throw new Error('Failed to create subscriber');
  const confirmToken = await issueToken(subscriberId, 'confirm', DEFAULT_CONFIRM_TTL_HOURS);
  return {
    success: true,
    subscriber_id: subscriberId,
    confirm_token: confirmToken,
  };
}

export async function confirmNewsletterSubscription(token: string) {
  const resolved = await resolveToken(token, 'confirm');
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('newsletter_subscribers')
    .update({
      status: 'active',
      is_suppressed: false,
      suppress_reason: null,
      opted_in_at: now,
      confirmed_at: now,
    })
    .eq('id', resolved.subscriber_id);

  if (error) throw error;
  await consumeToken(resolved.id);

  const unsubscribeToken = await issueToken(resolved.subscriber_id, 'unsubscribe', DEFAULT_UNSUB_TTL_HOURS);
  const preferencesToken = await issueToken(resolved.subscriber_id, 'preferences', DEFAULT_PREF_TTL_HOURS);

  return {
    success: true,
    subscriber_id: resolved.subscriber_id,
    unsubscribe_token: unsubscribeToken,
    preferences_token: preferencesToken,
  };
}

export async function unsubscribeNewsletter(token: string) {
  const resolved = await resolveToken(token, 'unsubscribe');
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('newsletter_subscribers')
    .update({
      status: 'unsubscribed',
      is_suppressed: true,
      suppress_reason: 'user_unsubscribed',
      unsubscribed_at: now,
    })
    .eq('id', resolved.subscriber_id);

  if (error) throw error;
  await consumeToken(resolved.id);

  await supabase
    .from('newsletter_send_jobs')
    .update({ status: 'suppressed', last_error: 'user_unsubscribed' })
    .eq('subscriber_id', resolved.subscriber_id)
    .in('status', ['queued', 'processing']);

  return { success: true };
}

export async function getPreferencesByToken(token: string) {
  const resolved = await resolveToken(token, 'preferences');

  const [{ data: subscriber, error: subscriberError }, { data: preferences, error: prefError }] = await Promise.all([
    supabase
      .from('newsletter_subscribers')
      .select('id,email,first_name,last_name,status,is_suppressed,suppress_reason')
      .eq('id', resolved.subscriber_id)
      .single(),
    supabase
      .from('newsletter_preferences')
      .select('category,is_enabled')
      .eq('subscriber_id', resolved.subscriber_id),
  ]);

  if (subscriberError) throw subscriberError;
  if (prefError) throw prefError;

  return {
    success: true,
    subscriber,
    preferences: preferences ?? [],
  };
}

export async function updatePreferencesByToken(token: string, categories: { category: string; is_enabled: boolean }[]) {
  const resolved = await resolveToken(token, 'preferences');
  if (!Array.isArray(categories)) throw new Error('categories is required');

  for (const item of categories) {
    const category = String(item?.category ?? '').trim();
    if (!category) continue;

    const { error } = await supabase
      .from('newsletter_preferences')
      .upsert({
        subscriber_id: resolved.subscriber_id,
        category,
        is_enabled: Boolean(item.is_enabled),
      }, { onConflict: 'subscriber_id,category' });

    if (error) throw error;
  }

  return getPreferencesByToken(token);
}

export async function createNewsletterIssue(input: {
  title: string;
  subject: string;
  body_html: string;
  recurring_enabled?: boolean;
  recurring_rrule?: string | null;
  scheduled_at?: string | null;
  audience_filters?: Record<string, any>;
  created_by?: string | null;
}) {
  if (!input.title || !input.subject || !input.body_html) {
    throw new Error('title, subject and body_html are required');
  }

  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  const { data, error } = await supabase
    .from('newsletter_issues')
    .insert({
      title: input.title,
      slug,
      subject: input.subject,
      body_html: input.body_html,
      status: input.scheduled_at ? 'scheduled' : 'draft',
      recurring_enabled: Boolean(input.recurring_enabled),
      recurring_rrule: input.recurring_rrule ?? null,
      scheduled_at: input.scheduled_at ?? null,
      recurring_next_run_at: input.scheduled_at ?? null,
      audience_filters: input.audience_filters ?? {},
      created_by: input.created_by ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return { success: true, issue: data };
}

export async function updateNewsletterIssue(issueId: string, input: Record<string, any>) {
  const payload: Record<string, any> = {};
  for (const key of ['title', 'subject', 'body_html', 'recurring_enabled', 'recurring_rrule', 'scheduled_at', 'audience_filters']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) payload[key] = input[key];
  }

  if (payload.title) {
    payload.slug = String(payload.title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  const { data, error } = await supabase
    .from('newsletter_issues')
    .update(payload)
    .eq('id', issueId)
    .select('*')
    .single();

  if (error) throw error;
  return { success: true, issue: data };
}

function buildFooter(baseUrl: string, unsubscribeToken: string, preferencesToken: string) {
  const unsubUrl = `${baseUrl}/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
  const prefsUrl = `${baseUrl}/newsletter/preferences?token=${encodeURIComponent(preferencesToken)}`;
  return `<hr style="margin-top:24px;margin-bottom:12px"/><p style="font-size:12px;color:#666">You are receiving this newsletter because you opted in. <a href="${unsubUrl}">Unsubscribe</a> or <a href="${prefsUrl}">Manage preferences</a>.</p>`;
}

async function validateIssueCompliance(issueId: string) {
  const { data: issue, error } = await supabase
    .from('newsletter_issues')
    .select('*')
    .eq('id', issueId)
    .single();

  if (error || !issue) throw new Error('Issue not found');
  if (!issue.subject || !issue.body_html) throw new Error('Issue content is incomplete');

  return issue;
}

function parseCategories(filters: any): string[] {
  const categories = Array.isArray(filters?.categories) ? filters.categories : [];
  return categories.map((c: any) => String(c || '').trim()).filter(Boolean);
}

async function listEligibleSubscribers(filters: any) {
  const categories = parseCategories(filters);

  let query = supabase
    .from('newsletter_subscribers')
    .select('id,email,first_name,last_name,status,is_suppressed,suppress_reason')
    .eq('status', 'active')
    .eq('is_suppressed', false);

  const { data: subscribers, error } = await query;
  if (error) throw error;

  const base = subscribers ?? [];
  if (categories.length === 0) return base;

  const { data: prefs, error: prefError } = await supabase
    .from('newsletter_preferences')
    .select('subscriber_id,category,is_enabled')
    .in('subscriber_id', base.map((s: any) => s.id))
    .in('category', categories)
    .eq('is_enabled', true);

  if (prefError) throw prefError;

  const allowedIds = new Set((prefs ?? []).map((p: any) => String(p.subscriber_id)));
  return base.filter((s: any) => allowedIds.has(String(s.id)));
}

export async function queueIssueRecipients(issueId: string) {
  const issue = await validateIssueCompliance(issueId);
  const recipients = await listEligibleSubscribers(issue.audience_filters ?? {});

  if (recipients.length === 0) throw new Error('No eligible subscribers found for this issue');

  const rows = recipients.map((subscriber: any) => ({
    issue_id: issueId,
    subscriber_id: subscriber.id,
    status: 'queued',
    scheduled_for: issue.scheduled_at ?? new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('newsletter_send_jobs')
    .upsert(rows, { onConflict: 'issue_id,subscriber_id', ignoreDuplicates: true });

  if (error) throw error;

  return { success: true, queued: rows.length };
}

export async function publishNewsletterIssue(issueId: string) {
  const issue = await validateIssueCompliance(issueId);

  if (!issue.body_html.includes('unsubscribe') && !issue.body_html.includes('preferences')) {
    // Footer is auto-appended during send; still require minimal body.
    if (!issue.body_html || issue.body_html.trim().length < 20) {
      throw new Error('Issue body is too short or invalid');
    }
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('newsletter_issues')
    .update({
      status: 'published',
      published_at: now,
      scheduled_at: issue.scheduled_at ?? now,
    })
    .eq('id', issueId);

  if (error) throw error;

  const queued = await queueIssueRecipients(issueId);
  return queued;
}

export async function scheduleNewsletterIssue(issueId: string, scheduledAt: string) {
  if (!scheduledAt) throw new Error('scheduled_at is required');

  const issue = await validateIssueCompliance(issueId);
  if (!issue.recurring_enabled && new Date(scheduledAt).getTime() < Date.now()) {
    throw new Error('Scheduled time must be in the future');
  }

  const { error } = await supabase
    .from('newsletter_issues')
    .update({
      status: 'scheduled',
      scheduled_at: scheduledAt,
      recurring_next_run_at: scheduledAt,
    })
    .eq('id', issueId);

  if (error) throw error;

  return { success: true };
}

export async function pauseNewsletterIssue(issueId: string) {
  const { error } = await supabase
    .from('newsletter_issues')
    .update({ status: 'paused', paused_at: new Date().toISOString() })
    .eq('id', issueId);

  if (error) throw error;
  return { success: true };
}

export async function resumeRecurringNewsletterIssue(issueId: string) {
  const { data: issue, error } = await supabase
    .from('newsletter_issues')
    .select('id,recurring_enabled,scheduled_at')
    .eq('id', issueId)
    .single();

  if (error || !issue) throw new Error('Issue not found');
  if (!issue.recurring_enabled) throw new Error('Issue is not recurring');

  const { error: updateError } = await supabase
    .from('newsletter_issues')
    .update({
      status: 'scheduled',
      recurring_next_run_at: issue.scheduled_at ?? new Date().toISOString(),
      paused_at: null,
    })
    .eq('id', issueId);

  if (updateError) throw updateError;
  return { success: true };
}

export async function runNewsletterIssueNow(issueId: string) {
  await scheduleNewsletterIssue(issueId, new Date().toISOString());
  return publishNewsletterIssue(issueId);
}

async function getNewsletterHourlyCap(): Promise<number> {
  const { data, error } = await supabase
    .from('sending_limits_config')
    .select('newsletter_hourly_cap')
    .limit(1)
    .maybeSingle();

  if (error) {
    return 50;
  }

  const cap = Number(data?.newsletter_hourly_cap ?? 50);
  return Number.isFinite(cap) && cap > 0 ? cap : 50;
}

async function countSentInHour(): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('newsletter_send_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'sent')
    .gte('created_at', oneHourAgo);

  if (error) throw error;
  return Number(count ?? 0);
}

async function getSenderInfra() {
  const { data: inbox, error: inboxError } = await supabase
    .from('inboxes')
    .select('id,email_address,smtp_account_id')
    .eq('is_paused', false)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (inboxError || !inbox) throw new Error('No active inbox available for newsletter sending');

  const { data: smtp, error: smtpError } = await supabase
    .from('smtp_accounts')
    .select('provider,host,port,username,password,encryption')
    .eq('id', inbox.smtp_account_id)
    .single();

  if (smtpError || !smtp) throw new Error('SMTP account missing for newsletter send');

  return { inbox, smtp };
}

function computeNextRunFromRRule(rrule: string | null, base: Date): Date | null {
  if (!rrule) return null;
  const normalized = String(rrule).toUpperCase();
  if (normalized.includes('FREQ=WEEKLY')) {
    return new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  if (normalized.includes('FREQ=MONTHLY')) {
    const d = new Date(base);
    d.setMonth(d.getMonth() + 1);
    return d;
  }
  return null;
}

export async function processNewsletterWorker(limit = 100) {
  const hourlyCap = await getNewsletterHourlyCap();
  const sentInHour = await countSentInHour();
  const remaining = Math.max(0, hourlyCap - sentInHour);

  if (remaining <= 0) {
    return { success: true, processed: 0, reason: 'newsletter_hourly_cap_reached', hourlyCap, sentInHour };
  }

  const nowIso = new Date().toISOString();

  const { data: dueRecurring, error: dueRecurringError } = await supabase
    .from('newsletter_issues')
    .select('id, recurring_rrule, recurring_next_run_at')
    .eq('status', 'scheduled')
    .eq('recurring_enabled', true)
    .lte('recurring_next_run_at', nowIso)
    .limit(20);

  if (dueRecurringError) throw dueRecurringError;

  for (const issue of dueRecurring ?? []) {
    await queueIssueRecipients(issue.id);
    const next = computeNextRunFromRRule(issue.recurring_rrule, new Date(nowIso));
    await supabase
      .from('newsletter_issues')
      .update({
        status: 'published',
        published_at: nowIso,
        recurring_next_run_at: next ? next.toISOString() : null,
      })
      .eq('id', issue.id);
  }

  const { data: jobs, error: jobsError } = await supabase
    .from('newsletter_send_jobs')
    .select(`
      id,
      issue_id,
      subscriber_id,
      attempts,
      newsletter_issues:issue_id (id, subject, body_html),
      newsletter_subscribers:subscriber_id (id, email, status, is_suppressed)
    `)
    .eq('status', 'queued')
    .lte('scheduled_for', nowIso)
    .order('created_at', { ascending: true })
    .limit(Math.min(limit, remaining));

  if (jobsError) throw jobsError;
  if (!jobs || jobs.length === 0) return { success: true, processed: 0 };

  const { inbox, smtp } = await getSenderInfra();
  const transporter = createSmtpTransport({
    provider: smtp.provider,
    host: smtp.host,
    port: smtp.port,
    username: smtp.username,
    password: decryptSecret(smtp.password),
    encryption: smtp.encryption,
  });

  let processed = 0;
  let sent = 0;
  let failed = 0;
  let suppressed = 0;

  for (const job of jobs) {
    processed += 1;

    const subscriber: any = (job as any).newsletter_subscribers;
    const issue: any = (job as any).newsletter_issues;

    if (!subscriber || subscriber.status !== 'active' || subscriber.is_suppressed) {
      suppressed += 1;
      await supabase
        .from('newsletter_send_jobs')
        .update({ status: 'suppressed', last_error: 'subscriber_not_eligible' })
        .eq('id', job.id);

      await supabase.from('newsletter_send_logs').insert({
        issue_id: job.issue_id,
        subscriber_id: job.subscriber_id,
        job_id: job.id,
        inbox_id: inbox.id,
        status: 'suppressed',
        error: 'subscriber_not_eligible',
      });
      continue;
    }

    try {
      const unsubscribeToken = await issueToken(subscriber.id, 'unsubscribe', DEFAULT_UNSUB_TTL_HOURS);
      const preferencesToken = await issueToken(subscriber.id, 'preferences', DEFAULT_PREF_TTL_HOURS);
      const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
      const html = `${issue.body_html}${buildFooter(appBaseUrl, unsubscribeToken, preferencesToken)}`;

      await supabase.from('newsletter_send_jobs').update({ status: 'processing' }).eq('id', job.id).eq('status', 'queued');

      const info = await transporter.sendMail({
        from: `"${inbox.email_address}" <${inbox.email_address}>`,
        to: subscriber.email,
        subject: issue.subject,
        html,
      });

      await supabase
        .from('newsletter_send_jobs')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          last_error: null,
          attempts: Number(job.attempts ?? 0) + 1,
        })
        .eq('id', job.id);

      await supabase.from('newsletter_send_logs').insert({
        issue_id: job.issue_id,
        subscriber_id: job.subscriber_id,
        job_id: job.id,
        inbox_id: inbox.id,
        status: 'sent',
        provider_message_id: info.messageId,
      });

      sent += 1;
    } catch (err: any) {
      failed += 1;

      await supabase
        .from('newsletter_send_jobs')
        .update({
          status: Number(job.attempts ?? 0) + 1 >= 3 ? 'failed' : 'queued',
          attempts: Number(job.attempts ?? 0) + 1,
          last_error: String(err?.message ?? 'send_failed'),
        })
        .eq('id', job.id);

      await supabase.from('newsletter_send_logs').insert({
        issue_id: job.issue_id,
        subscriber_id: job.subscriber_id,
        job_id: job.id,
        inbox_id: inbox.id,
        status: 'failed',
        error: String(err?.message ?? 'send_failed'),
      });
    }
  }

  return {
    success: true,
    processed,
    sent,
    failed,
    suppressed,
    hourlyCap,
    sentInHour,
  };
}

export async function promoteLeadToSubscriber(input: {
  lead_id: string;
  consent_evidence: string;
  category?: string;
}) {
  const leadId = String(input.lead_id ?? '').trim();
  const consentEvidence = String(input.consent_evidence ?? '').trim();

  if (!leadId) throw new Error('lead_id is required');
  if (!consentEvidence) throw new Error('consent_evidence is required');

  const { data: lead, error } = await supabase
    .from('leads')
    .select('id,email,first_name,last_name,source')
    .eq('id', leadId)
    .single();

  if (error || !lead) throw new Error('Lead not found');

  const { data: existing, error: existingError } = await supabase
    .from('newsletter_subscribers')
    .select('id')
    .eq('email', normalizeEmail(lead.email))
    .maybeSingle();

  if (existingError) throw existingError;

  let subscriberId = existing?.id;
  const now = new Date().toISOString();

  if (!subscriberId) {
    const { data: created, error: createError } = await supabase
      .from('newsletter_subscribers')
      .insert({
        email: normalizeEmail(lead.email),
        first_name: lead.first_name,
        last_name: lead.last_name,
        status: 'active',
        consent_source: lead.source || 'campaign_manual_promote',
        consent_evidence: consentEvidence,
        source_lead_id: lead.id,
        opted_in_at: now,
        confirmed_at: now,
        is_suppressed: false,
      })
      .select('id')
      .single();

    if (createError) throw createError;
    subscriberId = created.id;
  } else {
    await supabase
      .from('newsletter_subscribers')
      .update({
        status: 'active',
        consent_evidence: consentEvidence,
        source_lead_id: lead.id,
        is_suppressed: false,
        suppress_reason: null,
        opted_in_at: now,
        confirmed_at: now,
      })
      .eq('id', subscriberId);
  }

  if (input.category) {
    await supabase
      .from('newsletter_preferences')
      .upsert({
        subscriber_id: subscriberId,
        category: String(input.category).trim(),
        is_enabled: true,
      }, { onConflict: 'subscriber_id,category' });
  }

  return { success: true, subscriber_id: subscriberId };
}
