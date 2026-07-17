// >>> ROUNDBOX ADDITION — unit tests for the diagnostics ring + auth guard.
import { Hono } from 'hono';
import { LogRing } from './ring';
import { checkAuth, registerDiag } from './index';

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
