/**
 * ShadowCast - Unified Cache Manager Facade
 */

import { CacheConfig, CacheStore } from './types.js';
import { MemoryCache } from './MemoryCache.js';
import { IndexedDBCache } from './IndexedDBCache.js';
import { normalizeAssetUrl } from '../utils/url.js';

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

  private normalize(url: string): string {
    return normalizeAssetUrl(url) || url;
  }

  private revokeUrl(key: string): void {
    const existing = this.objectUrls.get(key);
    if (existing) {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        try {
          URL.revokeObjectURL(existing);
        } catch {
          // Ignore revoke errors
        }
      }
      this.objectUrls.delete(key);
    }
  }

  async get(url: string): Promise<Blob | undefined> {
    const key = this.normalize(url);
    const blob = await this.store.get(key);
    if (!blob) {
      this.revokeUrl(key);
    }
    return blob;
  }

  async set(url: string, blob: Blob, meta?: { assetHash?: string }): Promise<void> {
    const key = this.normalize(url);
    this.revokeUrl(key);
    await this.store.set(key, blob, meta);
  }

  async has(url: string): Promise<boolean> {
    const key = this.normalize(url);
    const exists = await this.store.has(key);
    if (!exists) {
      this.revokeUrl(key);
    }
    return exists;
  }

  async getObjectUrl(url: string): Promise<string | null> {
    const key = this.normalize(url);
    const blob = await this.store.get(key);
    if (!blob) {
      this.revokeUrl(key);
      return null;
    }

    const existing = this.objectUrls.get(key);
    if (existing) return existing;

    const objUrl =
      typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(blob)
        : `blob:shadowcast/${ encodeURIComponent(key) }`;
    this.objectUrls.set(key, objUrl);
    return objUrl;
  }

  async delete(url: string): Promise<boolean> {
    const key = this.normalize(url);
    this.revokeUrl(key);
    return this.store.delete(key);
  }

  async clear(): Promise<void> {
    for (const key of Array.from(this.objectUrls.keys())) {
      this.revokeUrl(key);
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
