// >>> ROUNDBOX ADDITION — spend attribution.
// HMAC-SHA256 request signing via Web Crypto (portable across Node 18+ and
// workerd). BlackGate's metering ingest verifies this signature.
export async function signPayload(
  secret: string,
  body: string
): Promise<string> {
  if (!secret) return '';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body)
  );
  return (
    'sha256=' +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}
