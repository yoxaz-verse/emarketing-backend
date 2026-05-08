import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { EMAIL_VALIDATION_QUEUE } from '../../queue/emailValidation.queue';
import { processLeadValidationSafely } from './eligibility.processor';
import { logger } from '../../services/logging/logger';

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
let workerHealth: { started: boolean; reason: string; concurrency: number } = {
  started: false,
  reason: 'not_started',
  concurrency: Number(process.env.EMAIL_VALIDATION_QUEUE_CONCURRENCY ?? 10),
};

export function getEmailValidationWorkerHealth() {
  return workerHealth;
}

export function startEmailValidationQueueWorker(): void {
  if (process.env.EMAIL_VALIDATION_QUEUE_MODE !== 'bullmq') {
    workerHealth = {
      started: false,
      reason: 'mode_not_bullmq',
      concurrency: Number(process.env.EMAIL_VALIDATION_QUEUE_CONCURRENCY ?? 10),
    };
    return;
  }
  if (worker) {
    workerHealth = {
      started: true,
      reason: 'already_started',
      concurrency: Number(process.env.EMAIL_VALIDATION_QUEUE_CONCURRENCY ?? 10),
    };
    return;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    workerHealth = {
      started: false,
      reason: 'missing_redis_url',
      concurrency: Number(process.env.EMAIL_VALIDATION_QUEUE_CONCURRENCY ?? 10),
    };
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
      await processLeadValidationSafely(job.data);
    },
    {
      connection,
      concurrency: Number(process.env.EMAIL_VALIDATION_QUEUE_CONCURRENCY ?? 10),
    }
  );

  workerHealth = {
    started: true,
    reason: 'worker_started',
    concurrency: Number(process.env.EMAIL_VALIDATION_QUEUE_CONCURRENCY ?? 10),
  };

  logger.info('email_validation_queue_worker_started', {
    queue: EMAIL_VALIDATION_QUEUE,
    concurrency: workerHealth.concurrency,
    redisConfigured: Boolean(redisUrl),
  });

  worker.on('failed', (job: FailedJob | undefined, error: Error) => {
    logger.error('email_validation_queue_job_failed', {
      jobId: job?.id,
      leadId: job?.data?.id,
      error: error.message,
    });
  });
}
