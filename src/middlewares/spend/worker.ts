// >>> ROUNDBOX ADDITION — spend attribution (Node-only).
// BullMQ worker that delivers queued UsageEvents to BlackGate's webhook with
// retry + exponential backoff. Failed jobs are retained (removeOnFail:false)
// so nothing billable is ever lost. Started from the Node entrypoint.
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { loadSpendConfig } from './config';
import { deliverUsage } from './deliver';
import { logUsageBackstop } from './backstop';
import type { UsageEvent } from './types';

let worker: Worker | null = null;

export function startSpendWorker(): void {
  const cfg = loadSpendConfig();
  if (!cfg.enabled || worker) return;
  const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });
  worker = new Worker<UsageEvent>(
    cfg.queueName,
    async (job) => deliverUsage(job.data),
    {
      connection,
      // Same hash-tag prefix as the producing Queue (config.queuePrefix) — must
      // match or the worker watches a different key set. Clustered-AMR safe.
      prefix: cfg.queuePrefix,
    }
  );
  worker.on('failed', (job, err) => {
    // Job remains in the failed set (dead-letter) — recoverable, not lost.
    if (job) {
      logUsageBackstop(
        job.data as UsageEvent,
        `deliver-failed-attempt-${job.attemptsMade}`,
        err
      );
    }
  });
  // eslint-disable-next-line no-console
  console.log(`[roundbox] spend worker started (queue=${cfg.queueName})`);
}
