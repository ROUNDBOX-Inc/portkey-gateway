// ============================================================================
// >>> ROUNDBOX ADDITION — spend attribution middleware (NOT upstream Portkey).
//
// Mirrors the upstream logHandler pattern: runs AFTER next(), never blocks the
// hot path. Per completed /v1 request it builds an attributed UsageEvent and
// enqueues it to a durable BullMQ queue (a worker delivers it to BlackGate's
// signed metering webhook with retry/backoff; failed jobs are retained so no
// billable event is lost). Identity rides Portkey's native x-portkey-metadata
// header, so parity merges stay clean. BullMQ (Node-only) is pulled via dynamic
// import so the workerd bundle is unaffected.
// ============================================================================
import { Context } from 'hono';
import { getRuntimeKey } from 'hono/adapter';
import { loadSpendConfig } from './config';
import { logUsageBackstop } from './backstop';
import type { UsageEvent } from './types';

const HEADER_METADATA = 'x-portkey-metadata';
const HEADER_PROVIDER = 'x-portkey-provider';
const HEADER_TRACE = 'x-portkey-trace-id';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface UsageEventInput {
  metadataHeader?: string | null;
  providerHeader?: string | null;
  traceHeader?: string | null;
  requestParams?: Record<string, unknown>;
  providerOption?: Record<string, unknown>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  } | null;
  status: number;
  latencyMs: number;
  nowIso: string;
  fallbackId: string;
}

// Pure builder — unit-testable without a live Hono context.
export function buildUsageEvent(input: UsageEventInput): UsageEvent {
  let metadata: Record<string, string> = {};
  try {
    metadata = JSON.parse(input.metadataHeader ?? '{}');
  } catch {
    metadata = {};
  }
  const streamed =
    input.requestParams?.stream === true ||
    input.requestParams?.stream === 'true';
  const usage = streamed ? null : input.usage ?? null;

  return {
    requestId: metadata.requestId || input.traceHeader || input.fallbackId,
    partnerId: metadata.partnerId,
    clientId: metadata.clientId,
    keyId: metadata.keyId,
    provider:
      input.providerHeader ||
      (input.providerOption?.provider as string | undefined),
    model: input.requestParams?.model as string | undefined,
    promptTokens: num(usage?.prompt_tokens),
    completionTokens: num(usage?.completion_tokens),
    totalTokens: num(usage?.total_tokens),
    streamed,
    status: input.status,
    latencyMs: input.latencyMs,
    ts: input.nowIso,
    usageAvailable: !!usage,
  };
}

async function processSpend(c: Context, start: number): Promise<void> {
  const cfg = loadSpendConfig();
  if (!cfg.enabled) return;
  if (!c.req.url.includes('/v1/')) return;

  const requestOptions = c.get('requestOptions');
  if (!requestOptions?.length) return;

  const requestParams = requestOptions[0]?.requestParams ?? {};
  const streamed =
    requestParams?.stream === true || requestParams?.stream === 'true';

  let usage = null;
  if (!streamed) {
    try {
      usage =
        ((await c.res.clone().json()) as { usage?: unknown })?.usage ?? null;
    } catch {
      // non-JSON / already consumed — leave usage null
    }
  }
  // NOTE(stream usage): streamed responses need the provider's include_usage
  // final chunk; parsing it in-middleware is a follow-up (see README). Until
  // then streamed events carry null tokens + streamed:true and BlackGate
  // reconciles stream usage from the response it already receives.

  const event = buildUsageEvent({
    metadataHeader: c.req.header(HEADER_METADATA),
    providerHeader: c.req.header(HEADER_PROVIDER),
    traceHeader: c.req.header(HEADER_TRACE),
    requestParams,
    providerOption: requestOptions[0]?.providerOptions,
    usage,
    status: c.res.status,
    latencyMs: Date.now() - start,
    nowIso: new Date().toISOString(),
    fallbackId: crypto.randomUUID(),
  });

  if (cfg.logBackstop) logUsageBackstop(event, 'observed');

  // Dynamic import keeps bullmq/ioredis out of the workerd bundle.
  const { enqueueUsage } = await import('./queue');
  await enqueueUsage(event);
}

export const spendAttributionHandler = () => {
  return async (c: Context, next: () => Promise<void>) => {
    const start = Date.now();
    await next();
    const runtime = getRuntimeKey();
    if (runtime === 'workerd') {
      c.executionCtx?.waitUntil(processSpend(c, start).catch(() => {}));
    } else {
      // node / bun / deno
      processSpend(c, start).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[roundbox] spend attribution error', e);
      });
    }
  };
};
