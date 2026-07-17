// >>> ROUNDBOX ADDITION — unit tests for the diagnostics ring + auth guard.
import { Hono } from 'hono';
import { LogRing, diagRing } from './ring';
import { captureConsole, checkAuth, registerDiag } from './index';
import { scrubArgsForRing } from './redact';
import { loadDiagConfig } from './config';

describe('LogRing', () => {
  it('stores pushed entries in push order and returns them via snapshot()', () => {
    const ring = new LogRing(1024);
    ring.push({ ts: 1, level: 'info', message: 'a' });
    ring.push({ ts: 2, level: 'error', message: 'b' });
    expect(ring.snapshot()).toEqual([
      { ts: 1, level: 'info', message: 'a' },
      { ts: 2, level: 'error', message: 'b' },
    ]);
  });

  it('filters snapshot by level, since, and limit', () => {
    const ring = new LogRing(1024);
    ring.push({ ts: 1, level: 'info', message: 'a' });
    ring.push({ ts: 2, level: 'error', message: 'b' });
    ring.push({ ts: 3, level: 'error', message: 'c' });

    expect(ring.snapshot({ level: 'error' }).map((e) => e.message)).toEqual([
      'b',
      'c',
    ]);
    expect(ring.snapshot({ since: 1 }).map((e) => e.message)).toEqual([
      'b',
      'c',
    ]);
    expect(ring.snapshot({ limit: 1 }).map((e) => e.message)).toEqual(['c']);
  });

  it('evicts the oldest entries once the byte budget is exceeded', () => {
    // approxBytes = message bytes + context bytes + 32 fixed overhead.
    // A 10-char message is ~42 bytes, so a 60-byte budget fits one entry.
    const ring = new LogRing(60);
    ring.push({ ts: 1, level: 'info', message: 'x'.repeat(10) });
    expect(ring.bytes()).toBeLessThanOrEqual(60);

    ring.push({ ts: 2, level: 'info', message: 'y'.repeat(10) });
    expect(ring.bytes()).toBeLessThanOrEqual(60);
    expect(ring.snapshot().map((e) => e.ts)).toEqual([2]); // ts:1 evicted
  });

  it('notifies subscribers on push and supports unsubscribe', () => {
    const ring = new LogRing(1024);
    const seen: string[] = [];
    const unsub = ring.subscribe((e) => seen.push(e.message));
    ring.push({ ts: 1, level: 'info', message: 'a' });
    unsub();
    ring.push({ ts: 2, level: 'info', message: 'b' });
    expect(seen).toEqual(['a']);
  });

  it('never lets a throwing subscriber break push() or other subscribers', () => {
    const ring = new LogRing(1024);
    const seen: string[] = [];
    ring.subscribe(() => {
      throw new Error('boom');
    });
    ring.subscribe((e) => seen.push(e.message));
    expect(() =>
      ring.push({ ts: 1, level: 'info', message: 'a' })
    ).not.toThrow();
    expect(seen).toEqual(['a']);
  });
});

describe('checkAuth', () => {
  it('rejects a missing header or a missing/empty configured token', () => {
    expect(checkAuth(undefined, 'secret')).toBe(false);
    expect(checkAuth(null, 'secret')).toBe(false);
    expect(checkAuth('Bearer secret', '')).toBe(false);
  });

  it('rejects a malformed or mismatched header', () => {
    expect(checkAuth('Bearer wrong', 'secret')).toBe(false);
    expect(checkAuth('secret', 'secret')).toBe(false); // missing "Bearer " prefix
    expect(checkAuth('Bearer', 'secret')).toBe(false);
  });

  it('accepts the exact expected Bearer header', () => {
    expect(checkAuth('Bearer secret', 'secret')).toBe(true);
  });
});

describe('GET /internal/logs and /internal/logs/stream', () => {
  const ORIGINAL_TOKEN = process.env.RBX_INTERNAL_TOKEN;

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.RBX_INTERNAL_TOKEN;
    else process.env.RBX_INTERNAL_TOKEN = ORIGINAL_TOKEN;
  });

  function buildApp(): Hono {
    const app = new Hono();
    registerDiag(app);
    return app;
  }

  it('404s when RBX_INTERNAL_TOKEN is unset (disabled, never open)', async () => {
    delete process.env.RBX_INTERNAL_TOKEN;
    const app = buildApp();

    expect((await app.request('/internal/logs')).status).toBe(404);
    expect((await app.request('/internal/logs/stream')).status).toBe(404);
  });

  it('401s without a valid Bearer token', async () => {
    process.env.RBX_INTERNAL_TOKEN = 'topsecret';
    const app = buildApp();

    expect((await app.request('/internal/logs')).status).toBe(401);
    expect(
      (
        await app.request('/internal/logs', {
          headers: { authorization: 'Bearer nope' },
        })
      ).status
    ).toBe(401);
    expect((await app.request('/internal/logs/stream')).status).toBe(401);
  });

  it('200s with the correct Bearer token and returns a logs snapshot', async () => {
    process.env.RBX_INTERNAL_TOKEN = 'topsecret';
    const app = buildApp();

    const res = await app.request('/internal/logs', {
      headers: { authorization: 'Bearer topsecret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[] };
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it('applies query filters (level/limit/since) to the snapshot route', async () => {
    process.env.RBX_INTERNAL_TOKEN = 'topsecret';
    const app = buildApp();

    const res = await app.request('/internal/logs?level=error&limit=5', {
      headers: { authorization: 'Bearer topsecret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: Array<{ level: string }> };
    expect(body.logs.every((e) => e.level === 'error')).toBe(true);
  });
});

describe('credential redaction (scrubArgsForRing)', () => {
  it('redacts sensitive object keys (authorization) recursively', () => {
    const out = scrubArgsForRing([
      'fail',
      { headers: { authorization: 'Bearer sk-secret123' } },
    ]);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-secret123');
  });

  it('redacts api-key / apikey / x-api-key / x-portkey-* keys (case-insensitive)', () => {
    const out = scrubArgsForRing([
      {
        'API-Key': 'sk-abc',
        apiKey: 'sk-def',
        'X-Api-Key': 'sk-ghi',
        'x-portkey-provider': 'openai',
        'X-Portkey-Api-Key': 'sk-jkl',
      },
    ]);
    expect(out).not.toContain('sk-abc');
    expect(out).not.toContain('sk-def');
    expect(out).not.toContain('sk-ghi');
    expect(out).not.toContain('sk-jkl');
    // A non-sensitive x-portkey-* value is still redacted (prefix rule).
    expect(out).not.toContain('openai');
  });

  it('masks Bearer <token> substrings in a plain string arg', () => {
    const out = scrubArgsForRing(['auth header was Bearer sk-secret123 today']);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('sk-secret123');
  });

  it('masks standalone sk-/obg- tokens in a plain string arg', () => {
    const out = scrubArgsForRing(['key sk-liveABCDEF and obg_prodXYZ123']);
    expect(out).not.toContain('sk-liveABCDEF');
    expect(out).not.toContain('obg_prodXYZ123');
    expect(out).toContain('[REDACTED]');
  });
});

describe('captureConsole → ring redaction (end to end)', () => {
  it('never lets a secret reach the ring via console capture', () => {
    captureConsole(); // idempotent; patches console.* to also feed diagRing
    const before = diagRing.snapshot().length;

    console.error('fail', {
      headers: { authorization: 'Bearer sk-secret123' },
    });

    const added = diagRing.snapshot().slice(before);
    const combined = added.map((e) => e.message).join('\n');
    expect(combined).toContain('[REDACTED]');
    expect(combined).not.toContain('sk-secret123');
  });
});

describe('loadDiagConfig maxBytes NaN guard', () => {
  const ORIGINAL = process.env.RBX_DIAG_MAX_BYTES;
  const DEFAULT = 10 * 1024 * 1024;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.RBX_DIAG_MAX_BYTES;
    else process.env.RBX_DIAG_MAX_BYTES = ORIGINAL;
  });

  it('falls back to the 10MB default on a non-numeric value', () => {
    process.env.RBX_DIAG_MAX_BYTES = 'not-a-number';
    expect(loadDiagConfig().maxBytes).toBe(DEFAULT);
  });

  it('falls back to the default on zero/negative/empty', () => {
    process.env.RBX_DIAG_MAX_BYTES = '0';
    expect(loadDiagConfig().maxBytes).toBe(DEFAULT);
    process.env.RBX_DIAG_MAX_BYTES = '-5';
    expect(loadDiagConfig().maxBytes).toBe(DEFAULT);
    process.env.RBX_DIAG_MAX_BYTES = '';
    expect(loadDiagConfig().maxBytes).toBe(DEFAULT);
  });

  it('honors a valid positive value', () => {
    process.env.RBX_DIAG_MAX_BYTES = '2048';
    expect(loadDiagConfig().maxBytes).toBe(2048);
  });
});
