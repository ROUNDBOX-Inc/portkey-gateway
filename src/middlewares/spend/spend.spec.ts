// >>> ROUNDBOX ADDITION — unit tests for the pure spend-attribution helpers.
import { buildUsageEvent, type UsageEventInput } from './index';
import { signPayload } from './sign';

const base: UsageEventInput = {
  status: 200,
  latencyMs: 12,
  nowIso: '2026-07-15T00:00:00.000Z',
  fallbackId: 'fallback-uuid',
};

describe('buildUsageEvent', () => {
  it('attributes identity from x-portkey-metadata and usage from the response', () => {
    const e = buildUsageEvent({
      ...base,
      metadataHeader: JSON.stringify({
        partnerId: 'A',
        clientId: 'C1',
        keyId: 'k1',
        requestId: 'req-1',
      }),
      requestParams: { model: 'llama-3.1-8b', stream: false },
      providerOption: { provider: 'ovhcloud' },
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    expect(e).toMatchObject({
      requestId: 'req-1',
      partnerId: 'A',
      clientId: 'C1',
      keyId: 'k1',
      provider: 'ovhcloud',
      model: 'llama-3.1-8b',
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      streamed: false,
      usageAvailable: true,
    });
  });

  it('falls back to trace header then fallbackId for requestId', () => {
    expect(
      buildUsageEvent({ ...base, metadataHeader: '{}', traceHeader: 'trace-9' })
        .requestId
    ).toBe('trace-9');
    expect(buildUsageEvent({ ...base, metadataHeader: null }).requestId).toBe(
      'fallback-uuid'
    );
  });

  it('ignores usage for streamed responses (streamed:true, null tokens)', () => {
    const e = buildUsageEvent({
      ...base,
      metadataHeader: '{"clientId":"C1"}',
      requestParams: { model: 'm', stream: true },
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
    expect(e.streamed).toBe(true);
    expect(e.promptTokens).toBeNull();
    expect(e.totalTokens).toBeNull();
    expect(e.usageAvailable).toBe(false);
  });

  it('tolerates malformed metadata (never throws)', () => {
    const e = buildUsageEvent({ ...base, metadataHeader: 'not-json' });
    expect(e.partnerId).toBeUndefined();
    expect(e.requestId).toBe('fallback-uuid');
  });
});

describe('signPayload', () => {
  it('produces a stable sha256 HMAC and empty string without a secret', async () => {
    const sig = await signPayload('secret', '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await signPayload('secret', '{"a":1}')).toBe(sig); // deterministic
    expect(await signPayload('', '{"a":1}')).toBe('');
  });
});
