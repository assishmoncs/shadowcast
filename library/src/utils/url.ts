/**
 * ShadowCast - URL and Asset Utilities
 */

/**
 * Derives a deterministic, collision-resistant asset ID from a URL using full-string hashing.
 */
export function getAssetId(url: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < url.length; i++) {
    const ch = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const hash32_1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hash32_2 = (h2 >>> 0).toString(16).padStart(8, '0');

  return `${hash32_1}${hash32_2}`;
}
