import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { EMAIL_VALIDATION_QUEUE } from '../../queue/emailValidation.queue';
import { processLeadValidation } from './eligibility.processor';
import { logger } from '../../services/logging/logger';
import { markRunOutcome } from '../../services/validation/validation.run.service';

type ValidationJob = {
  id: string;
  email: string;
  retry_count: number | null;
  validation_run_id?: string | null;
};

type FailedJob = {
  id?: string | number;
  data?: ValidationJob;
};

let worker: Worker | null = null;

export function startEmailValidationQueueWorker(): void {
  if (process.env.EMAIL_VALIDATION_QUEUE_MODE !== 'bullmq') return;
  if (worker) return;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.warn('email_validation_queue_disabled', {
      reason: 'missing_redis_url',
    });
    return;
  }

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  worker = new Worker<ValidationJob>(
    EMAIL_VALIDATION_QUEUE,
    async (job) => {
      await processLeadValidation(job.data);
    },
    {
      connection,
      concurrency: Number(process.env.EMAIL_VALIDATION_QUEUE_CONCURRENCY ?? 10),
    }
  );

  worker.on('failed', (job: FailedJob | undefined, error: Error) => {
    logger.error('email_validation_queue_job_failed', {
      jobId: job?.id,
      leadId: job?.data?.id,
      error: error.message,
    });
    if (job?.data?.validation_run_id) {
      void markRunOutcome(job.data.validation_run_id, 'failed');
    }
  });
}
