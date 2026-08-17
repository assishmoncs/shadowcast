/**
 * ShadowCast - LRU Cache Eviction Policy
 */

import {
  CacheEntryMetadata,
  DEFAULT_CACHE_TTL,
  DEFAULT_MAX_CACHE_SIZE,
  DEFAULT_MAX_ENTRIES,
} from './types.js';

export class LRUPolicy {
  constructor(
    public readonly maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE,
    public readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    public readonly ttlMs: number = DEFAULT_CACHE_TTL
  ) {}

  /**
   * Identifies candidate URLs to evict based on TTL expiry and LRU order.
   */
  findEvictionCandidates(
    entries: CacheEntryMetadata[],
    incomingSizeBytes: number = 0
  ): string[] {
    const now = Date.now();
    const toEvict: string[] = [];
    let currentTotalSize = entries.reduce((acc, e) => acc + e.size, 0);
    let currentCount = entries.length;

    // 1. Evict expired entries first
    for (const entry of entries) {
      if (this.ttlMs > 0 && now - entry.storedAt > this.ttlMs) {
        toEvict.push(entry.url);
        currentTotalSize -= entry.size;
        currentCount--;
      }
    }

    // Filter remaining active entries sorted by least recently accessed
    const remaining = entries
      .filter((e) => !toEvict.includes(e.url))
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    // 2. Evict least-recently-used until within size and entry bounds
    for (const entry of remaining) {
      const willExceedSize = currentTotalSize + incomingSizeBytes > this.maxSizeBytes;
      const willExceedCount = currentCount + 1 > this.maxEntries;

      if (willExceedSize || willExceedCount) {
        toEvict.push(entry.url);
        currentTotalSize -= entry.size;
        currentCount--;
      } else {
        break;
      }
    }

    return toEvict;
  }
}
