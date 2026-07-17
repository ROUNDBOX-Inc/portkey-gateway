// ============================================================================
// >>> ROUNDBOX ADDITION — credential redaction for the diagnostics ring.
//
// Defense-in-depth: the router handles upstream `Authorization: Bearer <apiKey>`
// and `x-portkey-*` credentials, so a stray `console.*` somewhere could put a
// secret on the wire into the in-memory ring (which platform-admins tail).
// Everything captured by captureConsole() is scrubbed here FIRST so the ring
// can never hold a secret, even if some upstream code logs one. Mirrors the
// intent of sanitizeHeaders/sanitizeRequestOption in src/middlewares/log.
// ============================================================================

// Case-insensitive: exact-match credential header names + any x-portkey-* key.
function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === 'authorization' ||
    k === 'api-key' ||
    k === 'apikey' ||
    k === 'x-api-key' ||
    k.startsWith('x-portkey-')
  );
}

// Recursively redact sensitive keys in a plain object/array, returning a
// redacted copy (never mutates the caller's object). WeakSet guards against
// circular structures. Non-objects pass through untouched.
export function redactValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? '[REDACTED]' : redactValue(v, seen);
  }
  return out;
}

// Mask secret-looking substrings that survive as plain text: `Bearer <token>`
// sequences and standalone `sk-…` / `obg_…`-style tokens. Bearer is masked
// first so a `Bearer sk-...` yields exactly `Bearer [REDACTED]`.
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-]+/gi;
const TOKEN_RE = /\b(?:sk|obg)[-_][A-Za-z0-9._\-]{4,}/gi;

export function maskSecretsInString(s: string): string {
  return s
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(TOKEN_RE, '[REDACTED]');
}

// Stringify one console arg with object-key redaction applied.
function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    const json = JSON.stringify(redactValue(a));
    return json !== undefined ? json : String(a);
  } catch {
    return String(a);
  }
}

// Full scrub pipeline for console-captured args: per-arg object-key redaction,
// join, then a final string-level secret mask over the whole line. This is the
// only path from console.* into the ring, so anything not caught here would be
// the only way a secret could land in the ring.
export function scrubArgsForRing(args: unknown[]): string {
  const joined = args.map(stringifyArg).join(' ');
  return maskSecretsInString(joined);
}
