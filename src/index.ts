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
import { startSequenceRunner } from './worker/sequenceRunner';

dotenv.config();

const app = express();

app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));
app.get('/ping', (_req, res) => {
  console.log('✅ PING HIT');
  res.json({ ok: true });
});

app.use((req, res, next) => {
  console.log('🔥 INCOMING:', req.method, req.url);
  next();
});


app.use(express.json());
app.use('/validate', validationRoutes)
app.use('/auth', authRoutes);
app.use('/campaigns', campaignRoutes);
app.use('/crud', crudRoutes);
app.use('/users', usersRoutes);
app.use('/execution', executionRoutes);
app.use('/operator', operatorRoutes);
app.use('/sequences', sequencesRoutes);
app.use('/agents', agentsRoutes);
app.use('/reply', replyRoutes);
app.use('/stats', statsRoutes);
app.use('/admin', adminRoutes);
const PORT = Number(process.env.PORT) || 3000;

console.log('🔥 INDEX.TS LOADED');

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

startSequenceRunner();
