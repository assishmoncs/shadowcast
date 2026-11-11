/**
 * ShadowCast - URL and Asset Utilities
 */

/**
 * Normalizes an asset URL by trimming whitespace and stripping hash fragments (#...)
 * which do not affect HTTP resource payloads.
 */
export function normalizeAssetUrl(url: string): string {
  const trimmed = (url || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Relative path or non-standard URL: strip # fragment manually
    const hashIndex = trimmed.indexOf('#');
    return hashIndex !== -1 ? trimmed.slice(0, hashIndex) : trimmed;
  }
}

/**
 * Derives a deterministic, collision-resistant 16-char hex asset ID from a URL.
 */
export function getAssetId(url: string): string {
  const normalized = normalizeAssetUrl(url);
  let h1 = 0xdeadbeef ^ normalized.length;
  let h2 = 0x41c6ce57 ^ normalized.length;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const hash32_1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hash32_2 = (h2 >>> 0).toString(16).padStart(8, '0');

  return `${hash32_1}${hash32_2}`;
}

/**
 * Generates an RFC-4122 v4 UUID safely across secure/insecure browser contexts and Node.js.
 */
export function generateUUID(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID();
    } catch {
      // Fallback if randomUUID throws in insecure context
    }
  }

  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
