/** Minimal JWT signing with WebCrypto, for Apple (ES256) and Google (RS256) server APIs. */

export function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Accepts a PEM with real newlines or with literal "\n" (as pasted from a .env file). */
export function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function signJwt(
  alg: 'ES256' | 'RS256',
  privateKeyPem: string,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const importAlg = alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKeyPem), importAlg, false, ['sign']);
  const signingInput = `${base64UrlEncode(JSON.stringify({ alg, typ: 'JWT', ...header }))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signAlg = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  // WebCrypto ECDSA already returns the raw r||s form that JWS expects.
  const signature = await crypto.subtle.sign(signAlg, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/** Reads a JWS payload without checking its signature. Only use on data fetched from the store over TLS. */
export function decodeJwsPayload<T>(jws: string): T {
  const part = jws.split('.')[1];
  if (!part) throw new Error('Malformed JWS');
  return JSON.parse(base64UrlDecode(part)) as T;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
