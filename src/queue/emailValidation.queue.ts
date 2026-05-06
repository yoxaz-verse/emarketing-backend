import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const EMAIL_VALIDATION_QUEUE = 'email-validation';

let queue: Queue | null = null;

export function getEmailValidationQueue(): Queue {
  if (queue) return queue;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for BullMQ mode');
  }

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  queue = new Queue(EMAIL_VALIDATION_QUEUE, { connection });
  return queue;
}
