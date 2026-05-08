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
import { startSequenceRunner } from './worker/sequenceRunner';

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
const bootFingerprint = {
  startedAt: new Date().toISOString(),
  node: process.version,
  pid: process.pid,
  entrypoint,
  runtimeMode,
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
  executionMode: 'inline_sync',
  redisRequired: false,
  staleMinutes: Number(process.env.EMAIL_VALIDATION_STALE_MINUTES ?? 10),
});

app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));

app.get('/ping', (_req, res) => {
  res.json({ ok: true });
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
app.use('/sequences', sequencesRoutes);
app.use('/agents', agentsRoutes);
app.use('/reply', replyRoutes);
app.use('/stats', statsRoutes);
app.use('/admin', adminRoutes);

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.info('[BACKEND_BOOT_OK]', {
    port: PORT,
    runtimeMode,
    entrypoint,
  });
});

try {
  startSequenceRunner();
} catch (error) {
  console.error('[SEQUENCE_RUNNER_BOOT_ERROR]', error);
}
