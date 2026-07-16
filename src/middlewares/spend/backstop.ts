// >>> ROUNDBOX ADDITION — spend attribution.
// Structured stdout backstop: a billable event is ALWAYS logged as one JSON
// line (recoverable from Azure Monitor / Log Analytics) even if Redis enqueue
// or webhook delivery fails. Logging never throws.
import type { UsageEvent } from './types';

export function logUsageBackstop(
  event: UsageEvent,
  note: string,
  err?: unknown
): void {
  try {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        log: 'roundbox.spend.usage',
        note,
        event,
        error: err ? String((err as Error)?.message ?? err) : undefined,
      })
    );
  } catch {
    /* never throw from logging */
  }
}
