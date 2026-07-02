import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';
import {
  confirmNewsletterSubscription,
  createNewsletterIssue,
  getPreferencesByToken,
  pauseNewsletterIssue,
  processNewsletterWorker,
  promoteLeadToSubscriber,
  publishNewsletterIssue,
  resumeRecurringNewsletterIssue,
  runNewsletterIssueNow,
  scheduleNewsletterIssue,
  subscribeNewsletter,
  unsubscribeNewsletter,
  updateNewsletterIssue,
  updatePreferencesByToken,
} from '../services/newsletter.service';

const router = Router();

router.post('/subscribe', async (req, res) => {
  try {
    const result = await subscribeNewsletter({
      email: req.body?.email,
      first_name: req.body?.first_name,
      last_name: req.body?.last_name,
      consent_source: req.body?.consent_source,
      consent_evidence: req.body?.consent_evidence,
      consent_ip: req.ip,
      categories: req.body?.categories,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Subscribe failed' });
  }
});

router.post('/confirm', async (req, res) => {
  try {
    const token = String(req.body?.token ?? '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });
    const result = await confirmNewsletterSubscription(token);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Confirmation failed' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const token = String(req.body?.token ?? '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });
    const result = await unsubscribeNewsletter(token);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Unsubscribe failed' });
  }
});

router.get('/preferences/:token', async (req, res) => {
  try {
    const token = String(req.params.token ?? '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });
    const result = await getPreferencesByToken(token);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to load preferences' });
  }
});

router.put('/preferences/:token', async (req, res) => {
  try {
    const token = String(req.params.token ?? '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });
    const result = await updatePreferencesByToken(token, req.body?.categories ?? []);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to update preferences' });
  }
});

router.use(requireAuth('viewer'));
router.use(requireWriteRole);

router.post('/issues', async (req, res) => {
  try {
    const result = await createNewsletterIssue({
      title: req.body?.title,
      subject: req.body?.subject,
      body_html: req.body?.body_html,
      recurring_enabled: req.body?.recurring_enabled,
      recurring_rrule: req.body?.recurring_rrule,
      scheduled_at: req.body?.scheduled_at,
      audience_filters: req.body?.audience_filters,
      created_by: req.auth?.user_id ?? null,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to create issue' });
  }
});

router.put('/issues/:id', async (req, res) => {
  try {
    const result = await updateNewsletterIssue(req.params.id, req.body ?? {});
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to update issue' });
  }
});

router.post('/issues/:id/publish', async (req, res) => {
  try {
    const result = await publishNewsletterIssue(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to publish issue' });
  }
});

router.post('/issues/:id/schedule', async (req, res) => {
  try {
    const result = await scheduleNewsletterIssue(req.params.id, req.body?.scheduled_at);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to schedule issue' });
  }
});

router.post('/issues/:id/pause', async (req, res) => {
  try {
    const result = await pauseNewsletterIssue(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to pause issue' });
  }
});

router.post('/issues/:id/resume', async (req, res) => {
  try {
    const result = await resumeRecurringNewsletterIssue(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to resume issue' });
  }
});

router.post('/issues/:id/run-now', async (req, res) => {
  try {
    const result = await runNewsletterIssueNow(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to run issue now' });
  }
});

router.post('/subscribers/promote-lead', async (req, res) => {
  try {
    const result = await promoteLeadToSubscriber({
      lead_id: req.body?.lead_id,
      consent_evidence: req.body?.consent_evidence,
      category: req.body?.category,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to promote lead' });
  }
});

router.post('/worker/process', async (req, res) => {
  try {
    const limit = Number(req.body?.limit ?? 100);
    const result = await processNewsletterWorker(limit);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Worker failed' });
  }
});

export default router;
