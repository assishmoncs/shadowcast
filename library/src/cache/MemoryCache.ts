/**
 * ShadowCast - In-Memory Cache Store with LRU Eviction
 */

import { CacheConfig, CacheEntry, CacheStore } from './types.js';
import { LRUPolicy } from './LRUPolicy.js';

export class MemoryCache implements CacheStore {
  private entries: Map<string, CacheEntry> = new Map();
  private lruPolicy: LRUPolicy;

  constructor(config: CacheConfig = {}) {
    this.lruPolicy = new LRUPolicy(config.maxSizeBytes, config.maxEntries, config.ttlMs);
  }

  async get(url: string): Promise<Blob | undefined> {
    const entry = this.entries.get(url);
    if (!entry) return undefined;

    // Check TTL expiry
    if (this.lruPolicy.ttlMs > 0 && Date.now() - entry.storedAt > this.lruPolicy.ttlMs) {
      this.entries.delete(url);
      return undefined;
    }

    // Update access metadata
    entry.lastAccessedAt = Date.now();
    entry.accessCount++;
    return entry.blob;
  }

  async set(url: string, blob: Blob, meta?: { assetHash?: string }): Promise<void> {
    // Run LRU eviction
    const metadataList = Array.from(this.entries.values());
    const toEvict = this.lruPolicy.findEvictionCandidates(metadataList, blob.size);
    for (const evictUrl of toEvict) {
      this.entries.delete(evictUrl);
    }

    const now = Date.now();
    const entry: CacheEntry = {
      url,
      blob,
      size: blob.size,
      mimeType: blob.type,
      assetHash: meta?.assetHash,
      storedAt: now,
      lastAccessedAt: now,
      accessCount: 1,
    };

    this.entries.set(url, entry);
  }

  async has(url: string): Promise<boolean> {
    const blob = await this.get(url);
    return blob !== undefined;
  }

  async delete(url: string): Promise<boolean> {
    return this.entries.delete(url);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async getSize(): Promise<number> {
    let size = 0;
    for (const entry of this.entries.values()) {
      size += entry.size;
    }
    return size;
  }

  async getEntriesCount(): Promise<number> {
    return this.entries.size;
  }
}
