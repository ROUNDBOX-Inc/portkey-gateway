// >>> ROUNDBOX ADDITION — spend attribution.
// One billable usage event, attributed to an end-customer tenant. BlackGate's
// dual-ledger is authoritative; it dedupes on `requestId` (idempotency key).
export interface UsageEvent {
  requestId: string;
  partnerId?: string;
  clientId?: string; // the end-customer tenant (X-Tenant-Id in BlackGate)
  keyId?: string;
  provider?: string;
  model?: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  streamed: boolean;
  status: number;
  latencyMs: number;
  ts: string; // ISO-8601
  usageAvailable: boolean;
}
