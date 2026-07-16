// ============================================================================
// >>> ROUNDBOX ADDITION — spend attribution (NOT part of upstream Portkey).
// Kept in its own directory so upstream parity merges stay conflict-free.
// ============================================================================

export interface SpendConfig {
  enabled: boolean;
  redisUrl: string;
  webhookUrl: string;
  webhookSecret: string;
  queueName: string;
  maxAttempts: number;
  backoffMs: number;
  logBackstop: boolean;
}

// Spend attribution turns ON when a webhook URL is set, or explicitly via
// RBX_SPEND_ENABLED=true. Off by default so upstream/dev behavior is unchanged.
export function loadSpendConfig(): SpendConfig {
  const webhookUrl = process.env.RBX_SPEND_WEBHOOK_URL ?? '';
  const enabledFlag = process.env.RBX_SPEND_ENABLED;
  const enabled = enabledFlag ? enabledFlag === 'true' : webhookUrl.length > 0;
  return {
    enabled,
    redisUrl:
      process.env.RBX_SPEND_REDIS_URL ??
      process.env.REDIS_URL ??
      'redis://localhost:6379',
    webhookUrl,
    webhookSecret: process.env.RBX_SPEND_WEBHOOK_SECRET ?? '',
    queueName: process.env.RBX_SPEND_QUEUE ?? 'roundbox-spend',
    maxAttempts: Number(process.env.RBX_SPEND_MAX_ATTEMPTS ?? '25'),
    backoffMs: Number(process.env.RBX_SPEND_BACKOFF_MS ?? '5000'),
    logBackstop: (process.env.RBX_SPEND_LOG ?? 'true') === 'true',
  };
}
