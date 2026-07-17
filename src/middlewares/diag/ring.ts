// ============================================================================
// >>> ROUNDBOX ADDITION — diagnostics log ring (NOT part of upstream Portkey).
// Byte-bounded FIFO ring buffer, identical in shape/behavior to the gateway's
// LogRingService (apps/gateway/src/modules/diagnostics/log-ring.service.ts)
// so both sides of the diagnostics SSE/JSON bridge agree on wire shape
// (design doc §4.1/4.2). Pure in-memory — lost on restart, no persistence.
// ============================================================================
import { loadDiagConfig } from './config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  context?: string;
  message: string;
}

export interface SnapshotOpts {
  level?: LogLevel;
  limit?: number;
  since?: number;
}

interface RingItem {
  entry: LogEntry;
  approxBytes: number;
}

export class LogRing {
  private readonly items: RingItem[] = [];
  private totalBytes = 0;
  private readonly subscribers = new Set<(e: LogEntry) => void>();

  // maxBytes is a constructor param (not read from env internally) so unit
  // tests can exercise eviction without pushing megabytes of fixtures.
  constructor(private readonly maxBytes: number) {}

  push(e: LogEntry): void {
    const approxBytes = LogRing.approxBytes(e);
    this.items.push({ entry: e, approxBytes });
    this.totalBytes += approxBytes;

    while (this.totalBytes > this.maxBytes && this.items.length > 0) {
      const dropped = this.items.shift();
      if (dropped) this.totalBytes -= dropped.approxBytes;
    }

    for (const cb of this.subscribers) {
      try {
        cb(e);
      } catch {
        // A misbehaving subscriber must never break the hot logging path or
        // take down other subscribers.
      }
    }
  }

  // Filtered snapshot, oldest-first / newest-last (matches push order).
  // `level` is an exact match (no "and above" escalation); `since` is a
  // strict `ts >` filter; `limit` keeps the last N of the already-filtered
  // set.
  snapshot(opts: SnapshotOpts = {}): LogEntry[] {
    let entries = this.items.map((i) => i.entry);

    if (opts.level !== undefined) {
      entries = entries.filter((e) => e.level === opts.level);
    }
    if (opts.since !== undefined) {
      const since = opts.since;
      entries = entries.filter((e) => e.ts > since);
    }
    if (opts.limit !== undefined) {
      entries = opts.limit > 0 ? entries.slice(-opts.limit) : [];
    }

    return entries;
  }

  subscribe(cb: (e: LogEntry) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  bytes(): number {
    return this.totalBytes;
  }

  private static approxBytes(e: LogEntry): number {
    // Rough accounting, not exact wire size: message + context + a fixed
    // per-entry overhead (ts, level, object/array bookkeeping).
    return (
      Buffer.byteLength(e.message) +
      (e.context ? Buffer.byteLength(e.context) : 0) +
      32
    );
  }
}

// Singleton shared by the console-capture shim, the middlewares/log access-
// log hook, and the /internal/logs routes (registerDiag in ./index.ts).
export const diagRing = new LogRing(loadDiagConfig().maxBytes);
