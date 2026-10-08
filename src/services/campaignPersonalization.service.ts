import { createHash } from 'node:crypto';
import { supabase } from '../supabase';

export const PERSONALIZATION_LEAD_FIELDS = [
  'email',
  'first_name',
  'last_name',
  'company',
  'job_title',
  'country',
  'phone',
  'linkedin_url',
  'website',
  'company_description',
  'industry',
  'employee_size',
  'source',
  'notes',
] as const;

export type PersonalizationLeadField = typeof PERSONALIZATION_LEAD_FIELDS[number];
export type MergeSourceType = 'lead_field' | 'fixed_text';

export type CampaignMergeMapping = {
  placeholder_key: string;
  placeholder_label: string;
  source_type: MergeSourceType;
  lead_field: PersonalizationLeadField | null;
  fixed_value: string | null;
  required: boolean;
  reviewed_signature?: string | null;
};

export type SequenceStepTemplate = {
  id?: string | null;
  step_number?: number | null;
  subject?: string | null;
  body?: string | null;
};

export type SequencePlaceholder = {
  key: string;
  label: string;
  usages: Array<{ step_number: number; location: 'subject' | 'body' }>;
  suggested_lead_field: PersonalizationLeadField | null;
};

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const ANY_DELIMITER_PATTERN = /\{\{|\}\}/g;
const LEAD_FIELD_SET = new Set<string>(PERSONALIZATION_LEAD_FIELDS);
const FRIENDLY_FIELD_ALIASES: Record<string, PersonalizationLeadField> = {
  email: 'email',
  'email address': 'email',
  'first name': 'first_name',
  firstname: 'first_name',
  'last name': 'last_name',
  lastname: 'last_name',
  company: 'company',
  'company name': 'company',
  'job title': 'job_title',
  title: 'job_title',
  country: 'country',
  phone: 'phone',
  'phone number': 'phone',
  linkedin: 'linkedin_url',
  'linkedin url': 'linkedin_url',
  website: 'website',
  'company description': 'company_description',
  industry: 'industry',
  'employee size': 'employee_size',
  source: 'source',
  notes: 'notes',
};

export function normalizePlaceholderKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

export function suggestLeadField(label: unknown): PersonalizationLeadField | null {
  const key = normalizePlaceholderKey(label);
  return FRIENDLY_FIELD_ALIASES[key] ?? (LEAD_FIELD_SET.has(key.replace(/ /g, '_'))
    ? key.replace(/ /g, '_') as PersonalizationLeadField
    : null);
}

function assertWellFormedTemplate(template: string): void {
  const delimiters = template.match(ANY_DELIMITER_PATTERN) ?? [];
  const matches = Array.from(template.matchAll(PLACEHOLDER_PATTERN));
  if (delimiters.length !== matches.length * 2) {
    throw new Error('Malformed dynamic field syntax. Use complete placeholders such as {{First Name}}.');
  }
  for (const match of matches) {
    if (!normalizePlaceholderKey(match[1])) {
      throw new Error('Dynamic field names cannot be empty.');
    }
  }
}

export function extractSequencePlaceholders(steps: SequenceStepTemplate[]): SequencePlaceholder[] {
  const found = new Map<string, SequencePlaceholder>();
  const ordered = [...steps].sort((a, b) => Number(a.step_number ?? 0) - Number(b.step_number ?? 0));

  for (const [index, step] of ordered.entries()) {
    const stepNumber = Number(step.step_number ?? index + 1);
    for (const location of ['subject', 'body'] as const) {
      const template = String(step[location] ?? '');
      assertWellFormedTemplate(template);
      for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
        const label = String(match[1]).trim().replace(/\s+/g, ' ');
        const key = normalizePlaceholderKey(label);
        const current = found.get(key) ?? {
          key,
          label,
          usages: [],
          suggested_lead_field: suggestLeadField(label),
        };
        if (!current.usages.some((usage) => usage.step_number === stepNumber && usage.location === location)) {
          current.usages.push({ step_number: stepNumber, location });
        }
        found.set(key, current);
      }
    }
  }

  return Array.from(found.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export function sequencePlaceholderSignature(placeholders: SequencePlaceholder[]): string {
  const stable = placeholders
    .map((placeholder) => ({
      key: placeholder.key,
      usages: [...placeholder.usages].sort((a, b) => a.step_number - b.step_number || a.location.localeCompare(b.location)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function validateMappings(
  placeholders: SequencePlaceholder[],
  mappings: CampaignMergeMapping[]
): string[] {
  const errors: string[] = [];
  const expected = new Set(placeholders.map((placeholder) => placeholder.key));
  const seen = new Set<string>();

  for (const mapping of mappings) {
    const key = normalizePlaceholderKey(mapping.placeholder_key || mapping.placeholder_label);
    if (!expected.has(key)) errors.push(`Unknown dynamic field: ${mapping.placeholder_label || key}.`);
    if (seen.has(key)) errors.push(`Duplicate mapping for {{${mapping.placeholder_label || key}}}.`);
    seen.add(key);
    if (mapping.source_type === 'lead_field') {
      if (!mapping.lead_field || !LEAD_FIELD_SET.has(mapping.lead_field)) {
        errors.push(`{{${mapping.placeholder_label || key}}} must use a supported lead field.`);
      }
    } else if (mapping.source_type === 'fixed_text') {
      if (!String(mapping.fixed_value ?? '').trim()) {
        errors.push(`{{${mapping.placeholder_label || key}}} requires a fixed value.`);
      }
    } else {
      errors.push(`{{${mapping.placeholder_label || key}}} has an unsupported source type.`);
    }
  }

  for (const placeholder of placeholders) {
    if (!seen.has(placeholder.key)) errors.push(`{{${placeholder.label}}} has not been mapped.`);
  }
  return errors;
}

export function resolveMappingValues(
  mappings: CampaignMergeMapping[],
  lead: Record<string, unknown>
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const mapping of mappings) {
    const key = normalizePlaceholderKey(mapping.placeholder_key || mapping.placeholder_label);
    const raw = mapping.source_type === 'lead_field'
      ? lead[mapping.lead_field ?? '']
      : mapping.fixed_value;
    const value = raw == null ? '' : String(raw).trim();
    values[key] = value;
    if (mapping.required !== false && !value) missing.push(mapping.placeholder_label || key);
  }
  return { values, missing };
}

export function renderMergeTemplate(template: unknown, values: Record<string, string>): string {
  const source = String(template ?? '');
  assertWellFormedTemplate(source);
  return source.replace(PLACEHOLDER_PATTERN, (_match, label: string) => {
    const key = normalizePlaceholderKey(label);
    if (!(key in values) || !String(values[key]).trim()) {
      throw new Error(`Unresolved dynamic field: {{${String(label).trim()}}}.`);
    }
    return values[key];
  });
}

export async function loadCampaignMergeMappings(campaignId: string): Promise<CampaignMergeMapping[]> {
  const { data, error } = await supabase
    .from('campaign_merge_mappings')
    .select('placeholder_key,placeholder_label,source_type,lead_field,fixed_value,required,reviewed_signature')
    .eq('campaign_id', campaignId)
    .order('placeholder_key', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CampaignMergeMapping[];
}

export async function getCampaignPersonalizationState(campaignId: string, steps?: SequenceStepTemplate[]) {
  let sequenceSteps = steps;
  if (!sequenceSteps) {
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('sequence_id')
      .eq('id', campaignId)
      .maybeSingle();
    if (campaignError) throw campaignError;
    const sequenceId = String((campaign as any)?.sequence_id ?? '').trim();
    if (!sequenceId) sequenceSteps = [];
    else {
      const { data, error } = await supabase
        .from('sequence_steps')
        .select('id,step_number,subject,body')
        .eq('sequence_id', sequenceId)
        .order('step_number', { ascending: true });
      if (error) throw error;
      sequenceSteps = data ?? [];
    }
  }

  const placeholders = extractSequencePlaceholders(sequenceSteps ?? []);
  const signature = sequencePlaceholderSignature(placeholders);
  const mappings = await loadCampaignMergeMappings(campaignId);
  const errors = validateMappings(placeholders, mappings);
  const reviewedSignature = mappings[0]?.reviewed_signature ?? null;
  const stale = placeholders.length > 0 && (
    reviewedSignature !== signature || mappings.some((mapping) => mapping.reviewed_signature !== signature)
  );

  const { data: campaignLeads, error: leadsError } = await supabase
    .from('campaign_leads')
    .select(`id,lead_id,leads:lead_id(${PERSONALIZATION_LEAD_FIELDS.join(',')})`)
    .eq('campaign_id', campaignId);
  if (leadsError) throw leadsError;

  const missingLeads = (campaignLeads ?? []).flatMap((row: any) => {
    const lead = Array.isArray(row.leads) ? row.leads[0] : row.leads;
    const missing = errors.length === 0 ? resolveMappingValues(mappings, lead ?? {}).missing : [];
    return missing.length ? [{ campaign_lead_id: row.id, lead_id: row.lead_id, email: lead?.email ?? null, missing }] : [];
  });

  return {
    placeholders,
    mappings,
    signature,
    reviewed_signature: reviewedSignature,
    reviewed: placeholders.length === 0 || (!stale && errors.length === 0),
    stale,
    errors,
    allowed_lead_fields: [...PERSONALIZATION_LEAD_FIELDS],
    missing_lead_count: missingLeads.length,
    missing_leads: missingLeads.slice(0, 50),
    sample_lead: campaignLeads?.[0]
      ? (Array.isArray((campaignLeads[0] as any).leads) ? (campaignLeads[0] as any).leads[0] : (campaignLeads[0] as any).leads)
      : null,
  };
}

export async function saveCampaignMergeMappings(campaignId: string, input: unknown) {
  const state = await getCampaignPersonalizationState(campaignId);
  const rawMappings = Array.isArray(input) ? input : [];
  const byPlaceholder = new Map(state.placeholders.map((placeholder) => [placeholder.key, placeholder]));
  const mappings: CampaignMergeMapping[] = rawMappings.map((raw: any) => {
    const key = normalizePlaceholderKey(raw?.placeholder_key ?? raw?.placeholder_label);
    const placeholder = byPlaceholder.get(key);
    return {
      placeholder_key: key,
      placeholder_label: placeholder?.label ?? String(raw?.placeholder_label ?? key).trim(),
      source_type: raw?.source_type,
      lead_field: raw?.source_type === 'lead_field' ? String(raw?.lead_field ?? '') as PersonalizationLeadField : null,
      fixed_value: raw?.source_type === 'fixed_text' ? String(raw?.fixed_value ?? '').trim() : null,
      required: true,
      reviewed_signature: state.signature,
    };
  });
  const errors = validateMappings(state.placeholders, mappings);
  if (errors.length) {
    const error = new Error('Dynamic field mappings are incomplete or invalid.') as Error & { statusCode?: number; code?: string; details?: unknown };
    error.statusCode = 409;
    error.code = 'INVALID_DYNAMIC_FIELD_MAPPINGS';
    error.details = { errors };
    throw error;
  }

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('status')
    .eq('id', campaignId)
    .maybeSingle();
  if (campaignError) throw campaignError;
  if (String((campaign as any)?.status ?? '').toLowerCase() === 'running') {
    const error = new Error('Pause the campaign before changing dynamic field mappings.') as Error & { statusCode?: number };
    error.statusCode = 409;
    throw error;
  }

  if (mappings.length) {
    const { error: upsertError } = await supabase.from('campaign_merge_mappings').upsert(
      mappings.map((mapping) => ({ ...mapping, campaign_id: campaignId, updated_at: new Date().toISOString() })),
      { onConflict: 'campaign_id,placeholder_key' }
    );
    if (upsertError) throw upsertError;

    const activeKeys = new Set(mappings.map((mapping) => mapping.placeholder_key));
    const obsoleteKeys = state.mappings
      .map((mapping) => mapping.placeholder_key)
      .filter((key) => !activeKeys.has(key));
    if (obsoleteKeys.length) {
      const { error: cleanupError } = await supabase
        .from('campaign_merge_mappings')
        .delete()
        .eq('campaign_id', campaignId)
        .in('placeholder_key', obsoleteKeys);
      if (cleanupError) throw cleanupError;
    }
  } else {
    const { error: deleteError } = await supabase.from('campaign_merge_mappings').delete().eq('campaign_id', campaignId);
    if (deleteError) throw deleteError;
  }
  return getCampaignPersonalizationState(campaignId);
}

export async function prepareCampaignPersonalization(campaignId: string) {
  const state = await getCampaignPersonalizationState(campaignId);
  if (state.placeholders.length === 0) return { ...state, eligible_lead_count: null };
  if (!state.reviewed) {
    const error = new Error(state.stale
      ? 'The sequence dynamic fields changed. Review and save the campaign mappings again.'
      : 'Review and complete the campaign dynamic field mappings before starting.') as Error & { statusCode?: number; code?: string; details?: unknown };
    error.statusCode = 409;
    error.code = state.stale ? 'DYNAMIC_FIELD_MAPPINGS_STALE' : 'DYNAMIC_FIELD_MAPPINGS_REQUIRED';
    error.details = state;
    throw error;
  }

  const { data: rows, error: rowsError } = await supabase
    .from('campaign_leads')
    .select(`id,status,status_reason,last_sent_at,current_step,leads:lead_id(${PERSONALIZATION_LEAD_FIELDS.join(',')})`)
    .eq('campaign_id', campaignId);
  if (rowsError) throw rowsError;

  const missingIds: string[] = [];
  const restoredIds: string[] = [];
  let eligibleCount = 0;
  for (const row of rows ?? []) {
    const lead = Array.isArray((row as any).leads) ? (row as any).leads[0] : (row as any).leads;
    const missing = resolveMappingValues(state.mappings, lead ?? {}).missing;
    if (missing.length) missingIds.push(String((row as any).id));
    else {
      eligibleCount += 1;
      if (String((row as any).status_reason ?? '') === 'missing_dynamic_field' && !(row as any).last_sent_at && Number((row as any).current_step ?? 1) <= 1) {
        restoredIds.push(String((row as any).id));
      }
    }
  }

  if (missingIds.length) {
    const { error } = await supabase.from('campaign_leads').update({ status: 'paused', status_reason: 'missing_dynamic_field' }).in('id', missingIds);
    if (error) throw error;
  }
  if (restoredIds.length) {
    const { error } = await supabase.from('campaign_leads').update({ status: 'pending', status_reason: 'dynamic_fields_resolved' }).in('id', restoredIds);
    if (error) throw error;
  }
  if (eligibleCount === 0) {
    const error = new Error('No attached campaign leads have values for all required dynamic fields.') as Error & { statusCode?: number; code?: string; details?: unknown };
    error.statusCode = 409;
    error.code = 'NO_DYNAMIC_FIELD_ELIGIBLE_LEADS';
    error.details = { missing_lead_count: missingIds.length };
    throw error;
  }
  return { ...state, eligible_lead_count: eligibleCount };
}
