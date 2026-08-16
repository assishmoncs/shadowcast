/**
 * ShadowCast - Unified Cache Manager Facade
 */

import { CacheConfig, CacheStore } from './types.js';
import { MemoryCache } from './MemoryCache.js';
import { IndexedDBCache } from './IndexedDBCache.js';

export class CacheManager {
  private store: CacheStore;
  private objectUrls: Map<string, string> = new Map();

  constructor(config: CacheConfig = {}) {
    const isBrowser = typeof window !== 'undefined';
    const supportsIDB = isBrowser && typeof window.indexedDB !== 'undefined';

    if (config.driver === 'memory' || !supportsIDB) {
      this.store = new MemoryCache(config);
    } else {
      this.store = new IndexedDBCache(config);
    }
  }

  async get(url: string): Promise<Blob | undefined> {
    return this.store.get(url);
  }

  async set(url: string, blob: Blob, meta?: { assetHash?: string }): Promise<void> {
    await this.store.set(url, blob, meta);
  }

  async has(url: string): Promise<boolean> {
    return this.store.has(url);
  }

  async getObjectUrl(url: string): Promise<string | null> {
    const existing = this.objectUrls.get(url);
    if (existing) return existing;

    const blob = await this.store.get(url);
    if (!blob) return null;

    const objUrl = URL.createObjectURL(blob);
    this.objectUrls.set(url, objUrl);
    return objUrl;
  }

  async delete(url: string): Promise<boolean> {
    const objUrl = this.objectUrls.get(url);
    if (objUrl) {
      URL.revokeObjectURL(objUrl);
      this.objectUrls.delete(url);
    }
    return this.store.delete(url);
  }

  async clear(): Promise<void> {
    for (const objUrl of this.objectUrls.values()) {
      URL.revokeObjectURL(objUrl);
    }
    this.objectUrls.clear();
    await this.store.clear();
  }

  async getSize(): Promise<number> {
    return this.store.getSize();
  }

  async getEntriesCount(): Promise<number> {
    return this.store.getEntriesCount();
  }
}
