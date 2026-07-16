// >>> ROUNDBOX ADDITION — spend attribution (Node-only; requires Redis).
// Durable queue: every billable event is enqueued to BullMQ so it survives
// delivery failures and restarts. Loaded via dynamic import so the workerd
// bundle never pulls in bullmq/ioredis.
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { loadSpendConfig } from './config';
import { logUsageBackstop } from './backstop';
import type { UsageEvent } from './types';

let queue: Queue | null = null;

function getQueue(): Queue {
  if (queue) return queue;
  const cfg = loadSpendConfig();
  const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });
  queue = new Queue(cfg.queueName, { connection });
  return queue;
}

export async function enqueueUsage(event: UsageEvent): Promise<void> {
  const cfg = loadSpendConfig();
  try {
    await getQueue().add('usage', event, {
      jobId: event.requestId, // dedupe repeated enqueues of the same request
      attempts: cfg.maxAttempts,
      backoff: { type: 'exponential', delay: cfg.backoffMs },
      removeOnComplete: true,
      // Never drop a billable event: exhausted jobs stay in the failed set
      // (dead-letter) for recovery rather than being deleted.
      removeOnFail: false,
    });
  } catch (err) {
    // Redis unavailable at enqueue time — emit the loud backstop so the event
    // is recoverable from logs. Never swallow silently.
    logUsageBackstop(event, 'enqueue-failed', err);
  }
}
