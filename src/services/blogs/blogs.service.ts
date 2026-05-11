import { supabase } from '../../supabase';
import { createSocialPublishJobs } from '../social/social.service';
import { SocialPlatformCode } from '../social/types';

type CreateBlogInput = {
  title: string;
  body: string;
  source_type?: 'internal' | 'url' | 'rss';
  source_url?: string | null;
};

type ImportBlogInput = {
  source_type: 'url' | 'rss';
  source_url: string;
};

type DistributeBlogInput = {
  channels: SocialPlatformCode[];
  scheduled_at?: string | null;
  timezone?: string;
  cta_url?: string;
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

function parseFirstRssItem(xml: string): { title: string; body: string; link?: string } {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) throw new Error('No RSS <item> found');
  const item = itemMatch[1];
  const title = (item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? 'Imported Blog').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const description = (item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const content = (item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1] ?? description).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim();
  return { title, body: stripHtml(content), link };
}

async function extractFromUrl(url: string): Promise<{ title: string; body: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Unable to fetch URL: ${res.status}`);
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? 'Imported Blog').trim();
  const body = stripHtml(html).slice(0, 4000);
  return { title, body };
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

export async function createBlog(input: CreateBlogInput, userId?: string | null) {
  const title = String(input.title ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (!title) throw new Error('title is required');
  if (!body) throw new Error('body is required');

  const { data, error } = await supabase
    .from('blogs')
    .insert({
      title,
      body,
      source_type: input.source_type ?? 'internal',
      source_url: input.source_url ?? null,
      created_by: userId ?? null,
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
  }, userId);
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

  const scheduledAtIso = toIsoOrNull(input.scheduled_at);
  const hashtags = ['#Blog', '#Obaol', '#Marketing'];
  const cta = input.cta_url || blog.source_url || undefined;

  const social = await createSocialPublishJobs(
    {
      targets: channels,
      post_input: {
        content: `${blog.title}\n\n${String(blog.body ?? '').slice(0, 500)}`,
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

  return {
    distribution,
    social,
  };
}
