import crypto from 'crypto';
import { supabase } from '../../supabase';
import { createSocialPublishJobs } from '../social/social.service';
import { SocialPlatformCode } from '../social/types';

type BlogStatus = 'ingested' | 'drafted' | 'pending_review' | 'approved' | 'scheduled' | 'published' | 'rejected';

type CreateBlogInput = {
  title: string;
  body: string;
  source_type?: 'internal' | 'url' | 'rss';
  source_url?: string | null;
  community_ids?: string[];
};

type ImportBlogInput = {
  source_type: 'url' | 'rss';
  source_url: string;
  community_ids?: string[];
};

type DistributeBlogInput = {
  channels: SocialPlatformCode[];
  scheduled_at?: string | null;
  timezone?: string;
  cta_url?: string;
};

type CreateBlogSourceInput = {
  provider_type: 'rss' | 'api';
  publisher_name: string;
  source_name: string;
  feed_url: string;
  region?: string | null;
  categories?: string[];
  trust_score?: number;
  active?: boolean;
  polling_interval_minutes?: number;
};

function toIsoOrNull(value?: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('scheduled_at must be a valid ISO date-time');
  return d.toISOString();
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanCdata(input: string): string {
  return input.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

function parseFirstRssItem(xml: string): { title: string; body: string; link?: string; published_at?: string | null } {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) throw new Error('No RSS <item> found');
  const item = itemMatch[1];
  const title = cleanCdata(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? 'Imported Blog');
  const description = cleanCdata(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '');
  const content = cleanCdata(item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1] ?? description);
  const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim();
  const pubDateRaw = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
  const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;
  return {
    title,
    body: stripHtml(content),
    link,
    published_at: pubDate && !Number.isNaN(pubDate.getTime()) ? pubDate.toISOString() : null,
  };
}

function parseRssItems(xml: string): Array<{ title: string; body: string; link: string; published_at?: string | null; external_id?: string | null }> {
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const out: Array<{ title: string; body: string; link: string; published_at?: string | null; external_id?: string | null }> = [];
  for (const match of xml.matchAll(itemRegex)) {
    const item = match[1] ?? '';
    const title = cleanCdata(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? 'Untitled');
    const description = cleanCdata(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '');
    const content = cleanCdata(item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1] ?? description);
    const body = stripHtml(content).slice(0, 12000);
    const link = cleanCdata(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '');
    if (!link || !body) continue;
    const guid = cleanCdata(item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ?? '');
    const pubDateRaw = cleanCdata(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? '');
    const dt = pubDateRaw ? new Date(pubDateRaw) : null;
    out.push({
      title,
      body,
      link,
      external_id: guid || null,
      published_at: dt && !Number.isNaN(dt.getTime()) ? dt.toISOString() : null,
    });
  }
  return out;
}

function extractExcerpt(input: string, limit: number = 220): string {
  const normalized = stripHtml(input);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}...`;
}

function tokenizeLower(input: string): string[] {
  return input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function computeModerationFlags(title: string, body: string): { quality_score: number; duplicate_risk: 'low' | 'medium' | 'high'; blocked_terms: string[] } {
  const blockedVocabulary = ['violence', 'hate', 'porn', 'terror'];
  const haystack = `${title} ${body}`.toLowerCase();
  const blockedTerms = blockedVocabulary.filter((term) => haystack.includes(term));
  const words = tokenizeLower(body);
  const uniqueRatio = words.length > 0 ? new Set(words).size / words.length : 0;
  const qualityScore = Math.max(0.3, Math.min(0.98, Number((0.45 + uniqueRatio * 0.55).toFixed(2))));
  const duplicateRisk: 'low' | 'medium' | 'high' = uniqueRatio > 0.75 ? 'low' : uniqueRatio > 0.55 ? 'medium' : 'high';
  return {
    quality_score: qualityScore,
    duplicate_risk: duplicateRisk,
    blocked_terms: blockedTerms,
  };
}

function buildGeneratedContent(title: string, body: string, sourceUrl: string | null, publisherName: string | null) {
  const excerpt = extractExcerpt(body, 220);
  const firstChunk = extractExcerpt(body, 420);
  const rewrittenBody = [
    `Summary: ${firstChunk}`,
    '',
    `What happened: ${extractExcerpt(body, 170)}`,
    `Why it matters for OBO communities: ${extractExcerpt(body, 170)}`,
    sourceUrl ? `Source: ${sourceUrl}` : null,
    publisherName ? `Publisher: ${publisherName}` : null,
  ].filter(Boolean).join('\n');

  return {
    title: `${title}`,
    excerpt,
    body: rewrittenBody,
    hashtags: ['#Obaol', '#Community', '#News'],
    language: 'en',
    attribution: {
      source_url: sourceUrl,
      publisher_name: publisherName,
    },
  };
}

function normalizeCommunityIds(ids?: string[]): string[] {
  const values = Array.isArray(ids) ? ids : [];
  return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean)));
}

function dedupeHashFor(url: string, title: string): string {
  return crypto.createHash('sha256').update(`${url}|${title.toLowerCase()}`).digest('hex');
}

async function extractFromUrl(url: string): Promise<{ title: string; body: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Unable to fetch URL: ${res.status}`);
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? 'Imported Blog').trim();
  const body = stripHtml(html).slice(0, 4000);
  return { title, body };
}

async function createCommunityPostMappings(blogId: string, communityIds: string[], createdBy?: string | null) {
  if (communityIds.length === 0) return;
  const payload = communityIds.map((communityId) => ({
    community_id: communityId,
    blog_id: blogId,
    status: 'approved',
    source_preference_tags: [communityId],
    created_by: createdBy ?? null,
  }));

  const { error } = await supabase
    .from('community_blog_posts')
    .upsert(payload, { onConflict: 'community_id,blog_id' });

  if (error) throw error;
}

async function addReviewEvent(blogId: string, action: 'approve' | 'reject' | 'edit', actorId?: string | null, notes?: string | null, payload?: Record<string, unknown>) {
  const { error } = await supabase
    .from('blog_review_events')
    .insert({
      blog_id: blogId,
      action,
      actor_id: actorId ?? null,
      notes: notes ?? null,
      payload: payload ?? {},
    });

  if (error) throw error;
}

export async function listBlogs() {
  const { data, error } = await supabase
    .from('blogs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    if (error.code === 'PGRST205') return [];
    throw error;
  }

  return data ?? [];
}

export async function listBlogSources() {
  const { data, error } = await supabase
    .from('blog_sources')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    if (error.code === 'PGRST205') return [];
    throw error;
  }

  return data ?? [];
}

export async function createBlogSource(input: CreateBlogSourceInput, userId?: string | null) {
  const providerType = input.provider_type;
  const publisherName = String(input.publisher_name ?? '').trim();
  const sourceName = String(input.source_name ?? '').trim();
  const feedUrl = String(input.feed_url ?? '').trim();
  if (!providerType || !['rss', 'api'].includes(providerType)) throw new Error('provider_type must be rss or api');
  if (!publisherName) throw new Error('publisher_name is required');
  if (!sourceName) throw new Error('source_name is required');
  if (!feedUrl) throw new Error('feed_url is required');

  const categories = Array.isArray(input.categories)
    ? Array.from(new Set(input.categories.map((v) => String(v || '').trim()).filter(Boolean)))
    : [];

  const trustScore = Number(input.trust_score ?? 0.6);
  const pollingInterval = Number(input.polling_interval_minutes ?? 60);

  const { data, error } = await supabase
    .from('blog_sources')
    .upsert({
      provider_type: providerType,
      publisher_name: publisherName,
      source_name: sourceName,
      feed_url: feedUrl,
      region: input.region ?? null,
      categories,
      trust_score: Number.isFinite(trustScore) ? trustScore : 0.6,
      active: input.active ?? true,
      polling_interval_minutes: Number.isFinite(pollingInterval) ? pollingInterval : 60,
      created_by: userId ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'feed_url' })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function createBlog(input: CreateBlogInput, userId?: string | null) {
  const title = String(input.title ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (!title) throw new Error('title is required');
  if (!body) throw new Error('body is required');

  const sourceType = input.source_type ?? 'internal';
  const sourceUrl = input.source_url ?? null;
  const moderationFlags = computeModerationFlags(title, body);
  const generatedContent = buildGeneratedContent(title, body, sourceUrl, null);
  const communityIds = normalizeCommunityIds(input.community_ids);

  const { data, error } = await supabase
    .from('blogs')
    .insert({
      title,
      body,
      source_type: sourceType,
      source_url: sourceUrl,
      created_by: userId ?? null,
      status: 'pending_review',
      community_ids: communityIds,
      source_snapshot: {
        source_type: sourceType,
        source_url: sourceUrl,
      },
      generated_content: generatedContent,
      moderation_flags: moderationFlags,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function importBlog(input: ImportBlogInput, userId?: string | null) {
  const sourceUrl = String(input.source_url ?? '').trim();
  if (!sourceUrl) throw new Error('source_url is required');

  if (input.source_type === 'url') {
    const extracted = await extractFromUrl(sourceUrl);
    return createBlog({
      title: extracted.title,
      body: extracted.body,
      source_type: 'url',
      source_url: sourceUrl,
      community_ids: input.community_ids,
    }, userId);
  }

  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Unable to fetch RSS feed: ${res.status}`);
  const xml = await res.text();
  const parsed = parseFirstRssItem(xml);

  return createBlog({
    title: parsed.title,
    body: parsed.body,
    source_type: 'rss',
    source_url: parsed.link ?? sourceUrl,
    community_ids: input.community_ids,
  }, userId);
}

export async function runRssIngestion(userId?: string | null) {
  const { data: sources, error: sourceError } = await supabase
    .from('blog_sources')
    .select('*')
    .eq('active', true)
    .eq('provider_type', 'rss')
    .order('created_at', { ascending: true });

  if (sourceError) throw sourceError;

  const ingestedBlogs: any[] = [];
  const rejectedItems: Array<{ source_id: string; reason: string; url: string | null }> = [];

  for (const source of sources ?? []) {
    try {
      const res = await fetch(String(source.feed_url));
      if (!res.ok) {
        rejectedItems.push({ source_id: source.id, reason: `rss_fetch_${res.status}`, url: source.feed_url });
        continue;
      }

      const xml = await res.text();
      const items = parseRssItems(xml).slice(0, 8);

      for (const item of items) {
        const hash = dedupeHashFor(item.link, item.title);
        const { data: existingItem } = await supabase
          .from('blog_ingestion_items')
          .select('id')
          .eq('dedupe_hash', hash)
          .maybeSingle();

        if (existingItem) continue;

        const moderationFlags = computeModerationFlags(item.title, item.body);

        const { error: ingestError } = await supabase
          .from('blog_ingestion_items')
          .insert({
            source_id: source.id,
            canonical_url: item.link,
            dedupe_hash: hash,
            external_id: item.external_id ?? null,
            title: item.title,
            snippet: extractExcerpt(item.body, 280),
            content_text: item.body,
            published_at: item.published_at ?? null,
            language: 'en',
            source_snapshot: {
              provider_type: source.provider_type,
              publisher_name: source.publisher_name,
              source_name: source.source_name,
              source_url: item.link,
              feed_url: source.feed_url,
            },
            moderation_flags: moderationFlags,
            ingestion_status: 'ingested',
          });

        if (ingestError) {
          rejectedItems.push({ source_id: source.id, reason: ingestError.message, url: item.link });
          continue;
        }

        const generatedContent = buildGeneratedContent(item.title, item.body, item.link, source.publisher_name);
        const blog = await createBlog({
          title: generatedContent.title,
          body: generatedContent.body,
          source_type: 'rss',
          source_url: item.link,
          community_ids: Array.isArray(source.categories) ? source.categories.map((v: string) => String(v || '').trim()).filter(Boolean) : [],
        }, userId);

        const { error: blogPatchError } = await supabase
          .from('blogs')
          .update({
            status: 'pending_review',
            source_snapshot: {
              provider_type: source.provider_type,
              publisher_name: source.publisher_name,
              source_name: source.source_name,
              source_url: item.link,
              feed_url: source.feed_url,
              published_at: item.published_at ?? null,
            },
            generated_content: generatedContent,
            moderation_flags: moderationFlags,
            updated_at: new Date().toISOString(),
          })
          .eq('id', blog.id);

        if (blogPatchError) throw blogPatchError;

        const { error: itemStatusError } = await supabase
          .from('blog_ingestion_items')
          .update({ ingestion_status: 'pending_review', updated_at: new Date().toISOString() })
          .eq('dedupe_hash', hash);

        if (itemStatusError) throw itemStatusError;

        ingestedBlogs.push(blog);
      }
    } catch (err: any) {
      rejectedItems.push({ source_id: source.id, reason: err?.message ?? 'unknown_error', url: source.feed_url });
    }
  }

  return {
    processed_sources: (sources ?? []).length,
    ingested_count: ingestedBlogs.length,
    ingested: ingestedBlogs,
    rejected_items: rejectedItems,
  };
}

export async function listReviewQueue() {
  const { data, error } = await supabase
    .from('blogs')
    .select('*')
    .in('status', ['pending_review', 'drafted', 'ingested'])
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function approveBlog(blogId: string, input: { notes?: string | null; community_ids?: string[] }, userId?: string | null) {
  const communityIds = normalizeCommunityIds(input.community_ids);

  const { data: blog, error: blogError } = await supabase
    .from('blogs')
    .select('*')
    .eq('id', blogId)
    .single();

  if (blogError || !blog) throw new Error('Blog not found');
  if (blog.status === 'rejected') throw new Error('Rejected blog cannot be approved directly');

  const mergedCommunities = Array.from(new Set([...(blog.community_ids ?? []), ...communityIds]));

  const { data: updated, error: updateError } = await supabase
    .from('blogs')
    .update({
      status: 'approved',
      approved_by: userId ?? null,
      approved_at: new Date().toISOString(),
      community_ids: mergedCommunities,
      updated_at: new Date().toISOString(),
    })
    .eq('id', blogId)
    .select('*')
    .single();

  if (updateError) throw updateError;

  await addReviewEvent(blogId, 'approve', userId, input.notes ?? null, {
    community_ids: mergedCommunities,
  });

  await createCommunityPostMappings(blogId, mergedCommunities, userId);

  return updated;
}

export async function rejectBlog(blogId: string, input: { notes?: string | null }, userId?: string | null) {
  const { data: updated, error } = await supabase
    .from('blogs')
    .update({
      status: 'rejected',
      updated_at: new Date().toISOString(),
    })
    .eq('id', blogId)
    .select('*')
    .single();

  if (error) throw error;

  await addReviewEvent(blogId, 'reject', userId, input.notes ?? null);

  return updated;
}

export async function listCommunityBlogFeed(communityId: string, limit: number = 25) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));

  const { data, error } = await supabase
    .from('community_blog_posts')
    .select(`
      id,
      community_id,
      status,
      published_at,
      created_at,
      blogs:blog_id (
        id,
        title,
        body,
        source_type,
        source_url,
        status,
        generated_content,
        source_snapshot,
        moderation_flags,
        approved_at,
        created_at
      )
    `)
    .eq('community_id', communityId)
    .in('status', ['approved', 'published'])
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    id: row.id,
    community_id: row.community_id,
    status: row.status,
    published_at: row.published_at,
    created_at: row.created_at,
    blog: row.blogs,
  }));
}

export async function distributeBlog(blogId: string, input: DistributeBlogInput, userId?: string | null, operatorId?: string | null) {
  const channels = Array.from(new Set((input.channels ?? []).map((c) => String(c).trim().toLowerCase()).filter(Boolean))) as SocialPlatformCode[];
  if (channels.length === 0) throw new Error('At least one channel is required');

  const { data: blog, error: blogError } = await supabase
    .from('blogs')
    .select('*')
    .eq('id', blogId)
    .single();

  if (blogError || !blog) throw new Error('Blog not found');
  if (blog.status !== 'approved') throw new Error('Only approved blogs can be distributed');

  const scheduledAtIso = toIsoOrNull(input.scheduled_at);
  const hashtags = Array.isArray(blog.generated_content?.hashtags) ? blog.generated_content.hashtags : ['#Blog', '#Obaol', '#Marketing'];
  const cta = input.cta_url || blog.source_url || undefined;
  const summary = String(blog.generated_content?.excerpt ?? blog.body ?? '').slice(0, 420);

  const social = await createSocialPublishJobs(
    {
      targets: channels,
      post_input: {
        content: `${blog.title}\n\n${summary}`,
        media: [],
        cta_url: cta,
        hashtags,
        timezone: input.timezone || 'Asia/Kolkata',
        scheduled_at: scheduledAtIso,
      },
    },
    userId,
    operatorId
  );

  const status: BlogStatus = scheduledAtIso ? 'scheduled' : 'published';

  const { data: distribution, error: distributionError } = await supabase
    .from('blog_distribution_jobs')
    .insert({
      blog_id: blog.id,
      channels,
      scheduled_at: scheduledAtIso,
      timezone: input.timezone || 'Asia/Kolkata',
      social_request_id: social.request_id,
      status: 'queued',
      created_by: userId ?? null,
      operator_id: operatorId ?? null,
    })
    .select('*')
    .single();

  if (distributionError) throw distributionError;

  const { error: blogStatusError } = await supabase
    .from('blogs')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', blog.id);

  if (blogStatusError) throw blogStatusError;

  if (Array.isArray(blog.community_ids) && blog.community_ids.length > 0) {
    const postStatus = scheduledAtIso ? 'approved' : 'published';
    const publishedAt = scheduledAtIso || new Date().toISOString();
    const { error: communityPostError } = await supabase
      .from('community_blog_posts')
      .update({
        status: postStatus,
        published_at: publishedAt,
        updated_at: new Date().toISOString(),
      })
      .eq('blog_id', blog.id);

    if (communityPostError) throw communityPostError;
  }

  return {
    distribution,
    social,
  };
}

type BlogPlatformCode = 'medium';
type BlogPlatformStatus = 'manual_assisted';
type BlogPlatformAuthType = 'none';
type BlogPlatformJobPhase = 'DRAFT_CREATE' | 'VALIDATE' | 'APPROVAL_PENDING' | 'PUBLISH';
type BlogPlatformJobStatus =
  | 'draft_created'
  | 'validated'
  | 'approval_pending'
  | 'manual_action_required'
  | 'published'
  | 'failed';

type BlogPlatformConnector = {
  code: BlogPlatformCode;
  name: string;
  status: BlogPlatformStatus;
  auth_type: BlogPlatformAuthType;
  can_schedule: boolean;
  can_publish: boolean;
  credentials_active: boolean;
  deep_link_url: string | null;
  metadata: Record<string, unknown>;
};

type CreatePlatformPublishInput = {
  targets: BlogPlatformCode[];
  scheduled_at?: string | null;
  timezone?: string;
  social_channels?: SocialPlatformCode[];
  cta_url?: string;
};

type RetryPlatformJobInput = {
  notes?: string | null;
};

function platformEvent(phase: BlogPlatformJobPhase, status: BlogPlatformJobStatus, message: string, errorCode?: string) {
  return { at: new Date().toISOString(), phase, status, message, error_code: errorCode };
}

function platformErrorCode(message: string): string {
  if (message.includes('required')) return 'VALIDATION_REQUIRED_FIELD';
  if (message.includes('must be')) return 'VALIDATION_INVALID_VALUE';
  return 'VALIDATION_ERROR';
}

function platformFallbackIdempotency(blogId: string, input: CreatePlatformPublishInput, userId?: string | null) {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ blogId, input, userId: userId ?? null }))
    .digest('hex');
  return `blog-platform-${digest}`;
}

async function getPlatformConnectors(codes: string[]): Promise<Map<string, BlogPlatformConnector>> {
  const { data, error } = await supabase
    .from('blog_platform_connectors')
    .select('*')
    .in('code', codes);
  if (error) throw error;
  const map = new Map<string, BlogPlatformConnector>();
  for (const row of data ?? []) map.set(row.code, row as BlogPlatformConnector);
  return map;
}

async function createOrGetPlatformRequest(
  blogId: string,
  input: CreatePlatformPublishInput,
  socialRequestId?: string | null,
  userId?: string | null,
  operatorId?: string | null
) {
  const idempotencyKey = platformFallbackIdempotency(blogId, input, userId);
  const existing = await supabase
    .from('blog_platform_publish_requests')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existing.error && existing.error.code !== 'PGRST116') throw existing.error;
  if (existing.data) return existing.data;

  const { data, error } = await supabase
    .from('blog_platform_publish_requests')
    .insert({
      idempotency_key: idempotencyKey,
      blog_id: blogId,
      scheduled_at: toIsoOrNull(input.scheduled_at),
      timezone: input.timezone || 'Asia/Kolkata',
      targets: input.targets,
      social_request_id: socialRequestId ?? null,
      created_by: userId ?? null,
      operator_id: operatorId ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function listBlogPlatformConnectors() {
  const { data, error } = await supabase
    .from('blog_platform_connectors')
    .select('*')
    .order('name', { ascending: true });
  if (error) {
    if (error.code === 'PGRST205') return [];
    throw error;
  }
  return data ?? [];
}

export async function createBlogPlatformPublishJobs(blogId: string, input: CreatePlatformPublishInput, userId?: string | null, operatorId?: string | null) {
  const targets = Array.from(new Set((input.targets ?? []).map((v) => String(v).trim().toLowerCase()).filter(Boolean))) as BlogPlatformCode[];
  if (targets.length === 0) throw new Error('At least one blog destination is required');

  const { data: blog, error: blogError } = await supabase
    .from('blogs')
    .select('*')
    .eq('id', blogId)
    .single();
  if (blogError || !blog) throw new Error('Blog not found');
  if (blog.status !== 'approved') throw new Error('Only approved blogs can be scheduled/published');

  let social: any = null;
  if (Array.isArray(input.social_channels) && input.social_channels.length > 0) {
    social = await distributeBlog(
      blogId,
      {
        channels: input.social_channels,
        scheduled_at: input.scheduled_at,
        timezone: input.timezone,
        cta_url: input.cta_url,
      },
      userId,
      operatorId
    );
  }

  const request = await createOrGetPlatformRequest(
    blogId,
    input,
    social?.social?.request_id ?? null,
    userId,
    operatorId
  );

  const existingJobs = await supabase
    .from('blog_platform_publish_jobs')
    .select('*')
    .eq('request_id', request.id)
    .order('created_at', { ascending: true });
  if (!existingJobs.error && (existingJobs.data?.length ?? 0) > 0) {
    return {
      request_id: request.id,
      idempotency_key: request.idempotency_key,
      social,
      jobs: existingJobs.data,
    };
  }

  const connectorMap = await getPlatformConnectors(targets);
  const missing = targets.filter((t) => !connectorMap.has(t));
  if (missing.length > 0) throw new Error(`Unknown blog platform(s): ${missing.join(', ')}`);

  const scheduledAt = toIsoOrNull(input.scheduled_at);
  const generated = (blog.generated_content ?? {}) as Record<string, any>;
  const postInput = {
    title: String(generated.title ?? blog.title),
    body: String(generated.body ?? blog.body),
    excerpt: String(generated.excerpt ?? ''),
    tags: Array.isArray(generated.hashtags) ? generated.hashtags : ['#Obaol', '#Blog'],
    cta_url: input.cta_url || blog.source_url || null,
    canonical_url: blog.source_url || null,
    timezone: input.timezone || 'Asia/Kolkata',
    scheduled_at: scheduledAt,
  };

  const jobs: any[] = [];
  for (const target of targets) {
    const connector = connectorMap.get(target)!;
    const timeline = [
      platformEvent('DRAFT_CREATE', 'draft_created', 'Draft payload created for blog platform'),
      platformEvent('VALIDATE', 'validated', 'Blog payload validated'),
      platformEvent('APPROVAL_PENDING', 'approval_pending', 'Queued for manual publish execution'),
      platformEvent('PUBLISH', 'manual_action_required', 'Manual-assisted publish task generated'),
    ];
    const manualTask = {
      instruction: 'Open Medium new story, paste content, add tags, and publish/schedule.',
      deep_link_url: connector.deep_link_url,
      payload: postInput,
    };
    const { data, error } = await supabase
      .from('blog_platform_publish_jobs')
      .insert({
        request_id: request.id,
        platform_code: target,
        status: 'manual_action_required',
        phase: 'PUBLISH',
        post_input: postInput,
        scheduled_at: scheduledAt,
        timeline,
        manual_task: manualTask,
        attempts: 1,
        created_by: userId ?? null,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();
    if (error) throw error;
    jobs.push(data);
  }

  const nextBlogStatus: BlogStatus = scheduledAt ? 'scheduled' : 'published';
  const { error: statusError } = await supabase
    .from('blogs')
    .update({ status: nextBlogStatus, updated_at: new Date().toISOString() })
    .eq('id', blog.id);
  if (statusError) throw statusError;

  return {
    request_id: request.id,
    idempotency_key: request.idempotency_key,
    social,
    jobs,
  };
}

export async function listBlogPublishJobs(blogId: string) {
  const { data: requests, error: requestError } = await supabase
    .from('blog_platform_publish_requests')
    .select('id')
    .eq('blog_id', blogId)
    .order('created_at', { ascending: false });
  if (requestError) throw requestError;
  const requestIds = (requests ?? []).map((r: any) => r.id);
  if (requestIds.length === 0) return [];
  const { data, error } = await supabase
    .from('blog_platform_publish_jobs')
    .select('*')
    .in('request_id', requestIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function retryBlogPublishJob(jobId: string, _input: RetryPlatformJobInput, userId?: string | null) {
  const { data: job, error } = await supabase
    .from('blog_platform_publish_jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (error || !job) throw new Error('Publish job not found');

  const timeline = Array.isArray(job.timeline) ? [...job.timeline] : [];
  timeline.push(platformEvent('DRAFT_CREATE', 'draft_created', 'Retry initiated from panel'));
  timeline.push(platformEvent('VALIDATE', 'validated', 'Payload re-validated'));
  timeline.push(platformEvent('APPROVAL_PENDING', 'approval_pending', 'Retry queued for manual execution'));
  timeline.push(platformEvent('PUBLISH', 'manual_action_required', 'Manual-assisted publish task regenerated'));

  const { data: patched, error: patchError } = await supabase
    .from('blog_platform_publish_jobs')
    .update({
      attempts: Number(job.attempts ?? 0) + 1,
      status: 'manual_action_required',
      phase: 'PUBLISH',
      error_code: null,
      error_message: null,
      validation_errors: null,
      timeline,
      updated_at: new Date().toISOString(),
      created_by: userId ?? job.created_by ?? null,
    })
    .eq('id', jobId)
    .select('*')
    .single();
  if (patchError) {
    throw new Error(platformErrorCode(patchError.message || 'Retry failed'));
  }
  return patched;
}
