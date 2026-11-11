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
  public readonly maxSizeBytes: number;
  public readonly maxEntries: number;
  public readonly ttlMs: number;

  constructor(
    maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE,
    maxEntries: number = DEFAULT_MAX_ENTRIES,
    ttlMs: number = DEFAULT_CACHE_TTL
  ) {
    this.maxSizeBytes = Number.isNaN(maxSizeBytes) ? DEFAULT_MAX_CACHE_SIZE : Math.max(0, Math.floor(maxSizeBytes));
    this.maxEntries = Number.isNaN(maxEntries) ? DEFAULT_MAX_ENTRIES : Math.max(0, Math.floor(maxEntries));
    this.ttlMs = Number.isNaN(ttlMs) ? DEFAULT_CACHE_TTL : Math.max(0, ttlMs);
  }

  /**
   * Checks whether a single entry has expired according to the configured TTL.
   */
  isExpired(entry: Pick<CacheEntryMetadata, 'storedAt' | 'expiresAt'>, now: number = Date.now()): boolean {
    return now >= (entry.expiresAt ?? Infinity) || (this.ttlMs > 0 && now - entry.storedAt >= this.ttlMs);
  }

  /**
   * Identifies candidate URLs to evict based on TTL expiry and LRU order.
   */
  findEvictionCandidates(
    entries: CacheEntryMetadata[],
    incomingSizeBytes: number = 0,
    incomingUrl?: string
  ): string[] {
    const now = Date.now();
    const evictedSet = new Set<string>();
    let currentTotalSize = 0;
    let currentCount = 0;

    for (const entry of entries) {
      if (incomingUrl && entry.url === incomingUrl) {
        // Updating an existing entry in-place: do not count its old size/slot against the incoming replacement
        continue;
      }
      currentTotalSize += entry.size;
      currentCount++;
    }

    // 1. Evict expired entries first
    for (const entry of entries) {
      if (this.isExpired(entry, now)) {
        evictedSet.add(entry.url);
        if (!incomingUrl || entry.url !== incomingUrl) {
          currentTotalSize -= entry.size;
          currentCount--;
        }
      }
    }

    // If incoming entry is requested and maxEntries === 0 or incoming alone exceeds maxSizeBytes,
    // still return expired entries without needlessly wiping valid entries if incoming cannot fit.
    if (incomingSizeBytes > 0 && (this.maxEntries === 0 || incomingSizeBytes > this.maxSizeBytes)) {
      return Array.from(evictedSet);
    }

    // Filter remaining active entries sorted by least recently accessed (with storedAt tie-breaker)
    const remaining = entries
      .filter((e) => !evictedSet.has(e.url) && (!incomingUrl || e.url !== incomingUrl))
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.storedAt - b.storedAt);

    const addingNewEntry = incomingSizeBytes > 0 || incomingUrl !== undefined;

    // 2. Evict least-recently-used until within size and entry bounds
    for (const entry of remaining) {
      const willExceedSize = currentTotalSize + incomingSizeBytes > this.maxSizeBytes;
      const willExceedCount = addingNewEntry
        ? currentCount + 1 > this.maxEntries
        : currentCount > this.maxEntries;

      if (willExceedSize || willExceedCount) {
        evictedSet.add(entry.url);
        currentTotalSize -= entry.size;
        currentCount--;
      } else {
        break;
      }
    }

    return Array.from(evictedSet);
  }
}
