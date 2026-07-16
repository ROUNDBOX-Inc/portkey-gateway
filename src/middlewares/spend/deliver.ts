// >>> ROUNDBOX ADDITION — spend attribution.
// Delivers one UsageEvent to BlackGate's metering ingest (signed webhook).
// Throwing here makes the BullMQ worker retry the job.
import { loadSpendConfig } from './config';
import { signPayload } from './sign';
import type { UsageEvent } from './types';

export async function deliverUsage(event: UsageEvent): Promise<void> {
  const cfg = loadSpendConfig();
  if (!cfg.webhookUrl) return; // nothing to deliver to (log backstop already emitted)
  const body = JSON.stringify(event);
  const signature = await signPayload(cfg.webhookSecret, body);
  const res = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-roundbox-signature': signature,
      'x-roundbox-event': 'usage',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`spend webhook responded ${res.status}`);
  }
}
