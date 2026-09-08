export function messageId(value: unknown): string | null {
  const id = String(value ?? '').trim().replace(/^<|>$/g, '');
  return id && !/[\s<>\r\n]/.test(id) ? id : null;
}
export function replySubject(value: string): string {
  const clean = value.replace(/[\r\n]/g, ' ').trim();
  return /^re:/i.test(clean) ? clean : `Re: ${clean || 'Your message'}`;
}
export function sendFailureStatus(error: { code?: string; responseCode?: number }): 'failed' | 'uncertain' {
  // A negative SMTP reply or a failure before SMTP submission is definitive.
  return Number(error.responseCode) >= 400 || ['EAUTH','EDNS','ECONNECTION','EENVELOPE'].includes(error.code ?? '') ? 'failed' : 'uncertain';
}
export function scopeForEvent(row: Record<string, any>): { module: string; scope_table: string | null; scope_id: string | null; source: string; href: string } {
  const entity = String(row.entity ?? '').toLowerCase();
  const campaign = row.meta?.campaign_id || (['campaign','campaigns'].includes(entity) ? row.entity_id : null);
  if (campaign) return { module: 'marketing', scope_table: 'campaigns', scope_id: String(campaign), source: 'campaign', href: `/dashboard/campaign/${encodeURIComponent(campaign)}` };
  const mappings: Record<string, [string,string,string,string]> = {
    lead: ['marketing','leads','campaign','/dashboard/leads'], leads: ['marketing','leads','campaign','/dashboard/leads'],
    inbox: ['marketing','inboxes','campaign','/dashboard/inboxes'], inboxes: ['marketing','inboxes','campaign','/dashboard/inboxes'],
    agent_tasks: ['openflow_ai','agent_tasks','agent','/dashboard/agent-integrations'],
    social_publish_jobs: ['social_media','social_publish_jobs','social','/dashboard/social-scheduling'],
  };
  const m = mappings[entity];
  return m ? {module:m[0],scope_table:m[1],scope_id:row.entity_id || null,source:m[2],href:m[3]} : {module:'admin',scope_table:null,scope_id:null,source:'system',href:'/dashboard'};
}
