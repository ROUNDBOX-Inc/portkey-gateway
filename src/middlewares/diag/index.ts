// ============================================================================
// >>> ROUNDBOX ADDITION — diagnostics live-log viewer (NOT part of upstream
// Portkey). Kept in its own directory so upstream parity merges stay
// conflict-free (mirrors src/middlewares/spend). Design doc §4.2.
//
// Two capture paths feed the shared ring (src/middlewares/diag/ring.ts):
//   1. captureConsole() — wraps console.log/info/warn/error so every call
//      also lands in the ring; original console behavior is preserved.
//   2. logToRing() — an explicit hook. middlewares/log's processLog() calls
//      it so the existing /v1 access-log records also show up in
//      Diagnostics (see the small ROUNDBOX ADDITION block there).
//
// registerDiag(app) mounts GET /internal/logs and /internal/logs/stream,
// Bearer-guarded by RBX_INTERNAL_TOKEN (timing-safe compare). The routes
// 404 — never merely unauthenticated — when the token env is unset, so
// mounting them unconditionally (outside the dev/headless gate) is safe in
// every environment. startDiag() wires console capture at boot and is
// called from the Node entrypoint (start-server.ts) alongside
// startSpendWorker(); the routes themselves live here in index.ts/registerDiag
// so both the node and workerd builds that import src/index.ts get them.
// ============================================================================
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { timingSafeEqual } from 'node:crypto';
import { loadDiagConfig } from './config';
import { diagRing, type LogEntry, type LogLevel } from './ring';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function isLogLevel(v: string | undefined): v is LogLevel {
  return !!v && (LEVELS as readonly string[]).includes(v);
}

// Explicit hook for other modules (e.g. middlewares/log's access-log
// processing) to feed the ring without going through console capture.
// Never throws — a logging hook must never disrupt its caller.
export function logToRing(record: LogEntry): void {
  try {
    diagRing.push(record);
  } catch {
    // swallow — diagnostics capture is best-effort only.
  }
}

let consoleCaptured = false;
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        const json = JSON.stringify(a);
        return json !== undefined ? json : String(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function wrap(
  level: LogLevel,
  original: (...args: unknown[]) => void
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    original(...args);
    logToRing({
      ts: Date.now(),
      level,
      context: 'console',
      message: stringifyArgs(args),
    });
  };
}

// Wraps console.log/info/warn/error so every call also lands in the ring,
// preserving the original console behavior (stdout/stderr, formatting).
// Idempotent — safe to call more than once.
export function captureConsole(): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  console.log = wrap('info', originalConsole.log);
  console.info = wrap('info', originalConsole.info);
  console.warn = wrap('warn', originalConsole.warn);
  console.error = wrap('error', originalConsole.error);
}

// Boot entrypoint — called from start-server.ts alongside startSpendWorker().
export function startDiag(): void {
  captureConsole();
}

// Timing-safe Bearer-token compare. Returns false (never throws) on a
// missing header/token or a length mismatch — timingSafeEqual requires
// equal-length buffers, and a length check leaks only the length of the
// expected constant string, not any secret-dependent information.
export function checkAuth(
  authHeader: string | null | undefined,
  token: string
): boolean {
  if (!token || !authHeader) return false;
  const expected = `Bearer ${token}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseQueryOpts(c: Context): SnapshotOptsFromQuery {
  const levelParam = c.req.query('level');
  const limitParam = c.req.query('limit');
  const sinceParam = c.req.query('since');

  const opts: SnapshotOptsFromQuery = {};
  if (isLogLevel(levelParam)) opts.level = levelParam;
  if (limitParam !== undefined) {
    const n = Number(limitParam);
    if (Number.isFinite(n)) opts.limit = n;
  }
  if (sinceParam !== undefined) {
    const n = Number(sinceParam);
    if (Number.isFinite(n)) opts.since = n;
  }
  return opts;
}

interface SnapshotOptsFromQuery {
  level?: LogLevel;
  limit?: number;
  since?: number;
}

function guard(c: Context): { ok: true } | { ok: false; res: Response } {
  const cfg = loadDiagConfig();
  if (!cfg.enabled) {
    return { ok: false, res: c.json({ message: 'Not Found', ok: false }, 404) };
  }
  if (!checkAuth(c.req.header('authorization'), cfg.token)) {
    return {
      ok: false,
      res: c.json({ message: 'Unauthorized', ok: false }, 401),
    };
  }
  return { ok: true };
}

// Mounts the production-safe diagnostics routes. Called unconditionally from
// src/index.ts app setup (NOT gated behind the dev/headless block) — the
// routes self-disable (404) when RBX_INTERNAL_TOKEN is unset.
export function registerDiag(app: Hono): void {
  app.get('/internal/logs', (c) => {
    const g = guard(c);
    if (!g.ok) return g.res;
    return c.json({ logs: diagRing.snapshot(parseQueryOpts(c)) });
  });

  app.get('/internal/logs/stream', (c) => {
    const g = guard(c);
    if (!g.ok) return g.res;

    c.header('Cache-Control', 'no-cache');
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      let closed = false;
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        unsubscribe();
        c.req.raw.signal.removeEventListener('abort', cleanup);
      };

      const unsubscribe = diagRing.subscribe((entry) => {
        if (closed) return;
        stream
          .writeSSE({ event: 'log', data: JSON.stringify(entry) })
          .catch(cleanup);
      });

      c.req.raw.signal.addEventListener('abort', cleanup);

      heartbeatInterval = setInterval(() => {
        if (c.req.raw.signal.aborted) {
          cleanup();
          return;
        }
        stream.writeSSE({ event: 'heartbeat', data: 'pulse' }).catch(cleanup);
      }, 10000);

      try {
        await stream.writeSSE({ event: 'connected', data: 'ok' });
        await new Promise<void>((resolve) => {
          if (c.req.raw.signal.aborted) {
            resolve();
            return;
          }
          c.req.raw.signal.addEventListener('abort', () => resolve());
        });
      } finally {
        cleanup();
      }
    });
  });
}
