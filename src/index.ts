import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import statsRoutes from './routes/stats.routes';
import adminRoutes from './routes/admin.routes';
import replyRoutes from './routes/reply.routes';
import sequencesRoutes from './routes/sequences.routes';
import agentsRoutes from './routes/agents.routes';
import operatorRoutes from './routes/operator.routes';
import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import crudRoutes from './routes/crud.routes';
import campaignRoutes from './routes/campaign.routes';
import campaignInboxRoutes from './routes/campaign.inboxes.routes';
import validationRoutes from './routes/validation.routes';
import executionRoutes from './routes/execution.routes';
import leadFoldersRoutes from './routes/lead.folders.routes';
import leadsRoutes from './routes/leads.routes';
import webhookRoutes from './routes/webhook.routes';
import newsletterRoutes from './routes/newsletter.routes';
import marketplacesRoutes from './routes/marketplaces.routes';
import socialRoutes from './routes/social.routes';
import socialAuthRoutes from './routes/social.auth.routes';
import blogsRoutes from './routes/blogs.routes';
import communitiesRoutes from './routes/communities.routes';
import inquiriesRoutes from './routes/inquiries.routes';
import quotesRoutes from './routes/quotes.routes';
import { startSequenceRunner } from './worker/sequenceRunner';
import { startAgentMissionRunner } from './worker/agentMissionRunner';
import { startReplyCaptureWorker } from './worker/replyCapture.worker';
import {
  getEmailValidationWorkerHealth,
  startEmailValidationQueueWorker,
} from './worker/email/eligibility.bullmq.worker';
import { supabase } from './supabase';

dotenv.config();

function maskSupabaseProjectRef(rawUrl?: string): string {
  if (!rawUrl) return 'missing';
  try {
    const hostname = new URL(rawUrl).hostname;
    const projectRef = hostname.split('.')[0] ?? '';
    if (!projectRef) return 'unknown';
    if (projectRef.length <= 8) return `${projectRef.slice(0, 3)}***`;
    return `${projectRef.slice(0, 4)}***${projectRef.slice(-4)}`;
  } catch {
    return 'invalid';
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_EXCEPTION]', error);
});

const app = express();
const entrypoint = process.argv[1] ?? 'unknown';
const runtimeMode = entrypoint.includes('/dist/') ? 'compiled-js' : 'typescript-source';
const schemaGuardVersion = 'attach-schema-guard-v1';
const bootFingerprint = {
  startedAt: new Date().toISOString(),
  node: process.version,
  pid: process.pid,
  entrypoint,
  runtimeMode,
  schemaGuardVersion,
  authGuardMode: 'role-hierarchy-v1',
  operatorRouteGuard: "requireAuth('viewer')",
};

console.info('[BACKEND_RUNTIME]', {
  ...bootFingerprint,
  sourceOfTruth: 'ts',
  smtpValidationFlow: 'deterministic-root-cause-v1',
  inboxUniquenessFlow: 'normalize-check-plus-db-unique-v1',
  supabaseProjectRef: maskSupabaseProjectRef(process.env.SUPABASE_URL),
});

console.info('[EMAIL_VALIDATION_RUNTIME]', {
  queueMode: process.env.EMAIL_VALIDATION_QUEUE_MODE ?? 'legacy',
  executionMode: process.env.EMAIL_VALIDATION_QUEUE_MODE === 'bullmq' ? 'bullmq_async' : 'inline_sync',
  redisRequired: process.env.EMAIL_VALIDATION_QUEUE_MODE === 'bullmq',
  redisConfigured: Boolean(process.env.REDIS_URL),
  staleMinutes: Number(process.env.EMAIL_VALIDATION_STALE_MINUTES ?? 10),
  workerHealth: getEmailValidationWorkerHealth(),
});

app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'https://emarketing.obaol.com', 'https://www.emarketing.obaol.com'],
  credentials: true,
}));

app.get('/ping', (_req, res) => {
  res.json({
    ok: true,
    runtimeMode,
    schemaGuardVersion,
    entrypoint,
    startedAt: bootFingerprint.startedAt,
    pid: process.pid,
  });
});

app.use(express.json());
app.use('/validate', validationRoutes);
app.use('/auth', authRoutes);
app.use('/campaigns', campaignRoutes);
app.use('/crud', crudRoutes);
app.use('/users', usersRoutes);
app.use('/execution', executionRoutes);
app.use('/operator', operatorRoutes);
app.use('/lead-folders', leadFoldersRoutes);
app.use('/leads', leadsRoutes);
app.use('/sequences', sequencesRoutes);
app.use('/agents', agentsRoutes);
app.use('/reply', replyRoutes);
app.use('/stats', statsRoutes);
app.use('/admin', adminRoutes);
app.use('/newsletter', newsletterRoutes);
app.use('/marketplaces', marketplacesRoutes);
app.use('/social', socialRoutes);
app.use('/social', socialAuthRoutes);
app.get('/oauth2-credential/callback', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(`/social/oauth2-credential/callback${query}`);
});
app.get('/rest/oauth2-credential/callback', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(`/social/oauth2-credential/callback${query}`);
});
app.use('/blogs', blogsRoutes);
app.use('/communities', communitiesRoutes);
app.use('/inquiries', inquiriesRoutes);
app.use('/quotes', quotesRoutes);
app.use('/', webhookRoutes);

app.get('/ping/routes', (_req, res) => {
  res.json({
    ok: true,
    routes: [
      '/inquiries/sources',
      '/inquiries/fetch-runs',
      '/inquiries/connector-runs',
      '/inquiries/webhook/:sourceCode',
      '/quotes',
    ],
  });
});

const PORT = Number(process.env.PORT) || 3000;

async function assertAttachLeadSchema() {
  const { error } = await supabase
    .from('leads')
    .select('id,email_eligibility,permanently_failed,is_used')
    .limit(1);

  if (!error) return;

  const message = String(error?.message ?? '');
  const code = String(error?.code ?? '');
  throw new Error(
    `Attach schema guard failed: leads table missing required columns (id,email_eligibility,permanently_failed,is_used). code=${code} message=${message}`
  );
}

async function checkSendingLimitsScheduleSchema() {
  const { error } = await supabase
    .from('sending_limits_config')
    .select('schedule_enabled,schedule_timezone,allowed_weekdays,send_window_start,send_window_end')
    .limit(1);

  if (!error) {
    console.info('[SENDING_LIMITS_SCHEMA_CHECK_OK]', {
      table: 'sending_limits_config',
      requiredScheduleColumns: true,
    });
    return;
  }

  const message = String(error?.message ?? '');
  const code = String(error?.code ?? '');
  if (
    message.toLowerCase().includes('column') ||
    message.toLowerCase().includes('does not exist')
  ) {
    console.error('[SENDING_LIMITS_SCHEMA_CHECK_FAILED]', {
      code,
      message,
      fix: 'Apply migration 20260511_add_send_schedule_to_sending_limits_config.sql and restart backend.',
    });
    return;
  }

  console.warn('[SENDING_LIMITS_SCHEMA_CHECK_WARN]', { code, message });
}

async function checkOperatorsSchemaReadiness() {
  const { error, count } = await supabase
    .from('operators')
    .select('id', { count: 'exact', head: true })
    .limit(1);

  if (!error) {
    console.info('[OPERATORS_SCHEMA_CHECK_OK]', {
      table: 'operators',
      reachable: true,
      countEstimate: Number(count ?? 0),
    });
    return;
  }

  const message = String(error?.message ?? '');
  const code = String(error?.code ?? '');
  if (
    code === '42P01' ||
    message.toLowerCase().includes('does not exist') ||
    message.toLowerCase().includes('could not find the table')
  ) {
    console.error('[OPERATORS_SCHEMA_CHECK_FAILED]', {
      code,
      message,
      fix: 'Ensure operators table exists in active database and backend points to correct Supabase project.',
    });
    return;
  }

  console.warn('[OPERATORS_SCHEMA_CHECK_WARN]', { code, message });
}

async function checkSocialAppsSchemaReadiness() {
  const logSocialSchemaCheck = (
    label: string,
    table: string,
    columns: string[],
    error: any,
    extra: Record<string, unknown> = {}
  ) => {
    if (!error) {
      console.info(`[${label}_OK]`, {
        table,
        requiredColumns: columns,
        ...extra,
      });
      return;
    }

    const message = String(error?.message ?? '');
    const code = String(error?.code ?? '');
    if (
      code === '42P01' ||
      code === '42703' ||
      message.toLowerCase().includes('does not exist') ||
      message.toLowerCase().includes('schema cache')
    ) {
      console.error(`[${label}_FAILED]`, {
        table,
        code,
        message,
        fix: 'Apply social app OAuth schema migration 20260618_fix_social_app_oauth_schema.sql and restart backend.',
      });
      return;
    }

    console.warn(`[${label}_WARN]`, { table, code, message });
  };

  const operatorColumns = ['operator_id', 'platform_code', 'client_secret_encrypted', 'metadata'];
  const operatorCheck = await supabase
    .from('social_operator_oauth_apps')
    .select('operator_id,platform_code,client_id,client_secret_encrypted,redirect_uri,scopes,metadata,active')
    .limit(1);
  logSocialSchemaCheck(
    'SOCIAL_APPS_SCHEMA_CHECK',
    'social_operator_oauth_apps',
    operatorColumns,
    operatorCheck.error,
    { endpoints: ['/admin/social-apps/:platform', '/admin/social-apps'] }
  );

  const globalCheck = await supabase
    .from('social_global_oauth_apps')
    .select('platform_code,client_id,client_secret_encrypted,redirect_uri,scopes,metadata,active')
    .limit(1);
  logSocialSchemaCheck(
    'SOCIAL_GLOBAL_APPS_SCHEMA_CHECK',
    'social_global_oauth_apps',
    ['platform_code', 'client_secret_encrypted', 'metadata'],
    globalCheck.error
  );

  const stateCheck = await supabase
    .from('social_oauth_states')
    .select('state_hash,platform_code,user_id,operator_id,expires_at')
    .limit(1);
  logSocialSchemaCheck(
    'SOCIAL_OAUTH_STATES_SCHEMA_CHECK',
    'social_oauth_states',
    ['state_hash', 'platform_code', 'user_id', 'operator_id', 'expires_at'],
    stateCheck.error
  );

  const connCheck = await supabase
    .from('social_oauth_connections')
    .select('platform_code,user_id,operator_id,access_token_encrypted,refresh_token_encrypted,expires_at,scopes,metadata,status,last_error')
    .limit(1);
  logSocialSchemaCheck(
    'SOCIAL_OAUTH_CONNECTIONS_SCHEMA_CHECK',
    'social_oauth_connections',
    ['platform_code', 'user_id', 'operator_id', 'access_token_encrypted', 'scopes', 'metadata'],
    connCheck.error
  );
}

async function checkInquirySchemaReadiness() {
  const tables = ['inquiry_sources', 'inquiry_fetch_runs', 'buyer_inquiries', 'inquiry_quotes'];
  for (const table of tables) {
    const { error } = await supabase.from(table).select('*').limit(1);
    if (!error) continue;

    const message = String(error?.message ?? '');
    const code = String(error?.code ?? '');
    if (
      code === '42P01' ||
      code === 'PGRST205' ||
      message.toLowerCase().includes('schema cache') ||
      message.toLowerCase().includes('does not exist')
    ) {
      console.error('[INQUIRY_SCHEMA_CHECK_FAILED]', {
        table,
        code,
        message,
        fix: 'Apply inquiry migrations (create inquiry pipeline + expand inquiry sources and quotes), then restart backend.',
      });
      return;
    }
    console.warn('[INQUIRY_SCHEMA_CHECK_WARN]', { table, code, message });
  }

  console.info('[INQUIRY_SCHEMA_CHECK_OK]', {
    tables,
    endpoints: ['/inquiries/fetch-runs', '/inquiries/sources', '/quotes'],
  });
}

async function checkReplyTrackingSchemaReadiness() {
  const checks: Array<{
    table: string;
    columns: string[];
    fix: string;
  }> = [
    {
      table: 'reply_ingest_events',
      columns: ['dedupe_key', 'matched', 'from_email', 'inbox_email', 'message_id', 'message', 'received_at', 'lead_id'],
      fix: 'Apply Backend/sql/20260522_reply_open_tracking_recovery.sql and restart backend.',
    },
    {
      table: 'email_tracking_events',
      columns: ['dedupe_key', 'event_type', 'provider_message_id', 'campaign_id', 'campaign_lead_id', 'lead_id', 'event_at', 'matched', 'raw_payload'],
      fix: 'Apply Backend/sql/20260522_reply_open_tracking_recovery.sql and restart backend.',
    },
    {
      table: 'email_logs',
      columns: ['provider_name', 'provider_message_id', 'campaign_id', 'campaign_lead_id', 'to_email'],
      fix: 'Apply Backend/sql/20260522_reply_open_tracking_recovery.sql and restart backend.',
    },
    {
      table: 'leads',
      columns: ['interest_status', 'interest_note', 'interest_reviewed_at', 'interest_reviewed_by'],
      fix: 'Apply Backend/sql/20260522_reply_open_tracking_recovery.sql and restart backend.',
    },
  ];

  for (const check of checks) {
    const { error } = await supabase.from(check.table).select(check.columns.join(',')).limit(1);
    if (!error) continue;

    const message = String(error?.message ?? '');
    const code = String(error?.code ?? '');
    if (
      code === '42P01' ||
      code === '42703' ||
      code === 'PGRST205' ||
      message.toLowerCase().includes('does not exist') ||
      message.toLowerCase().includes('schema cache')
    ) {
      console.error('[REPLY_TRACKING_SCHEMA_CHECK_FAILED]', {
        table: check.table,
        requiredColumns: check.columns,
        code,
        message,
        fix: check.fix,
      });
      return;
    }
    console.warn('[REPLY_TRACKING_SCHEMA_CHECK_WARN]', {
      table: check.table,
      requiredColumns: check.columns,
      code,
      message,
    });
  }

  console.info('[REPLY_TRACKING_SCHEMA_CHECK_OK]', {
    tables: checks.map((c) => c.table),
    endpoints: ['/operator/replies', '/execution/system/reply-capture-health', '/campaigns/:id/reply-open-analytics'],
  });
}

async function boot() {
  await assertAttachLeadSchema();
  await checkSendingLimitsScheduleSchema();
  await checkOperatorsSchemaReadiness();
  await checkSocialAppsSchemaReadiness();
  await checkInquirySchemaReadiness();
  await checkReplyTrackingSchemaReadiness();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.info('[BACKEND_BOOT_OK]', {
      port: PORT,
      bindHost: '0.0.0.0',
      expectedApiBase: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'unset',
      runtimeMode,
      entrypoint,
      schemaGuardVersion,
    });
    console.info('[INQUIRY_ROUTE_HEALTH]', {
      fetchRunsEndpoint: '/inquiries/fetch-runs',
      sourcesEndpoint: '/inquiries/sources',
      connectorRunsEndpoint: '/inquiries/connector-runs',
      quotesEndpoint: '/quotes',
      note: 'If UI shows Cannot POST /inquiries/fetch-runs, verify this process is the active runtime and restarted after deploy.',
    });
    console.info('[SOCIAL_APPS_ROUTE_HEALTH]', {
      getCanonical: '/admin/social-apps/:platform?operator_id=...',
      putCanonical: '/admin/social-apps/:platform',
      getCompatAlias: '/admin/social-apps?platform=...&operator_id=...',
      putCompatAlias: '/admin/social-apps with body.platform',
    });
  });
}

void boot().catch((error) => {
  console.error('[BACKEND_BOOT_FATAL]', error);
  process.exit(1);
});

try {
  startSequenceRunner();
} catch (error) {
  console.error('[SEQUENCE_RUNNER_BOOT_ERROR]', error);
}

try {
  startAgentMissionRunner();
} catch (error) {
  console.error('[AGENT_MISSION_RUNNER_BOOT_ERROR]', error);
}

try {
  startReplyCaptureWorker();
} catch (error) {
  console.error('[REPLY_CAPTURE_WORKER_BOOT_ERROR]', error);
}

try {
  startEmailValidationQueueWorker();
  console.info('[EMAIL_VALIDATION_WORKER_BOOT]', {
    queueMode: process.env.EMAIL_VALIDATION_QUEUE_MODE ?? 'legacy',
    redisConfigured: Boolean(process.env.REDIS_URL),
    workerHealth: getEmailValidationWorkerHealth(),
  });
} catch (error) {
  console.error('[EMAIL_VALIDATION_WORKER_BOOT_ERROR]', error);
}
