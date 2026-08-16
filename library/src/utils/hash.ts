/**
 * ShadowCast - Cryptographic Hash Utilities (Web Crypto API)
 */

/**
 * Computes SHA-256 hash of an ArrayBuffer as a lowercase hex string.
 */
export async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Fallback FNV-1a / Murmur-like hash if subtle crypto is unavailable
  let h1 = 0xdeadbeef ^ buffer.byteLength;
  let h2 = 0x41c6ce57 ^ buffer.byteLength;
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) {
    const ch = view[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Computes SHA-256 hash of a Blob as a lowercase hex string.
 */
export async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return hashBuffer(buffer);
}

/**
 * Computes SHA-256 hash of a string.
 */
export async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  return hashBuffer(data.buffer as ArrayBuffer);
}
