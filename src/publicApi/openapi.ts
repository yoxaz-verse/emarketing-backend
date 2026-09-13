import { API_SCOPES } from './common';

const error = { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } }, request_id: { type: 'string' } } };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const str = { type: 'string' };
const id = { name: 'id', in: 'path', required: true, schema: str };
const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
];
const body = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const response = (schema: unknown) => ({ description: 'Success', content: { 'application/json': { schema } } });
const operation = (summary: string, scope: string, schema: unknown, options: { params?: unknown[]; request?: unknown; idempotent?: boolean; status?: string } = {}) => ({
  summary,
  tags: [scope.split(':')[0]],
  'x-required-scope': scope,
  security: [{ ApiKey: [] }],
  ...(options.params ? { parameters: options.params } : {}),
  ...(options.request ? { requestBody: body(options.request) } : {}),
  ...(options.idempotent ? { parameters: [...(options.params ?? []), { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', minLength: 8, maxLength: 128 }, description: 'Optional retry-safe request key.' }] } : {}),
  responses: { [options.status ?? '200']: response(schema), default: response(error) },
});
const lead = object({ id: str, email: str, first_name: str, last_name: str, company: str, lead_status: str, created_at: str });
const campaign = object({ id: str, name: str, sequence_id: str, status: str, sender_display_name: str, created_at: str });
const sequence = object({ id: str, name: str, is_active: { type: 'boolean' }, created_at: str });
const list = (item: unknown) => object({ page: { type: 'integer' }, page_size: { type: 'integer' }, total: { type: 'integer' }, data: { type: 'array', items: item } });
const leadInput = object({ email: { type: 'string', format: 'email' }, first_name: str, last_name: str, company: str, country: str, job_title: str, phone: str, linkedin_url: str, website: str, industry: str, source: str, notes: str, lead_status: str }, ['email']);
const leadUpdate = object(leadInput.properties);
const campaignInput = object({ name: str, sequence_id: str, sender_display_name: str }, ['name', 'sequence_id']);

export const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'OBAOL Integration API', version: '1.0.0', description: 'Operator-scoped REST API. Never expose API keys in browser source or public repositories.' },
  servers: [{ url: `${(process.env.PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '')}/v1` || '/v1' }],
  components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } }, schemas: { Error: error } },
  'x-scopes': API_SCOPES,
  paths: {
    '/auth/check': { get: { summary: 'Verify a key and inspect effective scopes', tags: ['auth'], security: [{ ApiKey: [] }], responses: { '200': response(object({ key_id: str, operator_id: str, scopes: { type: 'array', items: str } })), default: response(error) } } },
    '/leads': {
      get: operation('List leads', 'leads:read', list(lead), { params: pageParams }),
      post: operation('Create a lead', 'leads:write', lead, { request: leadInput, idempotent: true, status: '201' }),
    },
    '/leads/{id}': {
      get: operation('Read a lead', 'leads:read', lead, { params: [id] }),
      patch: operation('Update a lead', 'leads:write', lead, { params: [id], request: leadUpdate }),
      delete: operation('Delete a lead', 'leads:write', object({ success: { type: 'boolean' } }), { params: [id] }),
    },
    '/campaigns': {
      get: operation('List campaigns', 'campaigns:read', list(campaign), { params: pageParams }),
      post: operation('Create a campaign', 'campaigns:write', campaign, { request: campaignInput, idempotent: true, status: '201' }),
    },
    '/campaigns/{id}': {
      get: operation('Read a campaign', 'campaigns:read', campaign, { params: [id] }),
      patch: operation('Update a campaign', 'campaigns:write', campaign, { params: [id], request: object(campaignInput.properties) }),
    },
    '/campaigns/{id}/leads': { post: operation('Assign leads to a campaign', 'campaigns:write', object({ requested: { type: 'integer' }, inserted: { type: 'integer' } }), { params: [id], request: object({ lead_ids: { type: 'array', items: str } }, ['lead_ids']), idempotent: true }) },
    '/campaigns/{id}/start': { post: operation('Start a campaign', 'campaigns:control', object({ status: str }), { params: [id], idempotent: true }) },
    '/campaigns/{id}/pause': { post: operation('Pause a campaign', 'campaigns:control', object({ status: str }), { params: [id], idempotent: true }) },
    '/campaigns/{id}/status': { get: operation('Read campaign status', 'campaigns:read', object({ id: str, status: str }), { params: [id] }) },
    '/campaigns/{id}/report': { get: operation('Read campaign lead counts', 'reports:read', object({ campaign_id: str, total_leads: { type: 'integer' }, by_status: { type: 'object' } }), { params: [id] }) },
    '/sequences': { get: operation('List sequences used by this operator', 'sequences:read', list(sequence), { params: pageParams }) },
    '/sequences/{id}': { get: operation('Read a sequence used by this operator', 'sequences:read', sequence, { params: [id] }) },
    '/reports/overview': { get: operation('Read operator overview counts', 'reports:read', object({ leads: { type: 'integer' }, campaigns: { type: 'integer' }, campaign_leads: { type: 'integer' } })) },
  },
} as const;
