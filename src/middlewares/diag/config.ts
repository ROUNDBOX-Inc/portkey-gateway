// ============================================================================
// >>> ROUNDBOX ADDITION — diagnostics log ring (NOT part of upstream Portkey).
// Kept in its own directory so upstream parity merges stay conflict-free.
// ============================================================================

export interface DiagConfig {
  // Disabled unless RBX_INTERNAL_TOKEN is set — the /internal/logs routes
  // must never be reachable-but-unauthenticated; they 404 when disabled.
  enabled: boolean;
  token: string;
  maxBytes: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

// Reads live from process.env on every call (no caching) so the routes
// reflect the current env immediately and tests can toggle
// RBX_INTERNAL_TOKEN without reloading the module.
export function loadDiagConfig(): DiagConfig {
  const token = process.env.RBX_INTERNAL_TOKEN ?? '';
  return {
    enabled: token.length > 0,
    token,
    maxBytes: Number(
      process.env.RBX_DIAG_MAX_BYTES ?? String(DEFAULT_MAX_BYTES)
    ),
  };
}
