import { CacheConfig, CacheStore, CacheWriteOptions } from './types.js';
import { MemoryCache } from './MemoryCache.js';
import { IndexedDBCache } from './IndexedDBCache.js';
import { normalizeAssetUrl } from '../utils/url.js';

export class CacheManager {
  private readonly memory: MemoryCache;
  private persistent?: IndexedDBCache;
  private readonly objectUrls = new Map<string, string>();
  private closed = false;

  constructor(config: CacheConfig = {}, dbName?: string) {
    this.memory = new MemoryCache(config);
    if (config.driver !== 'memory' && typeof indexedDB !== 'undefined') {
      this.persistent = new IndexedDBCache(config, dbName);
    }
  }

  private async operate<T>(operation: (store: CacheStore) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('[ShadowCast] Cache is closed');
    if (this.persistent) {
      try {
        return await operation(this.persistent);
      } catch (error) {
        this.persistent?.close();
        this.persistent = undefined;
        console.warn('[ShadowCast] IndexedDB operation failed, using memory cache:', error);
      }
    }
    if (this.closed) throw new Error('[ShadowCast] Cache is closed');
    return operation(this.memory);
  }

  private revoke(key: string): void {
    const url = this.objectUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    this.objectUrls.delete(key);
  }

  private key(url: string): string {
    return normalizeAssetUrl(url) || url;
  }

  async get(url: string): Promise<Blob | undefined> {
    const key = this.key(url);
    const blob = await this.operate((store) => store.get(key));
    if (!blob) this.revoke(key);
    return blob;
  }

  async set(url: string, blob: Blob, meta?: CacheWriteOptions): Promise<void> {
    const key = this.key(url);
    this.revoke(key);
    await this.operate((store) => store.set(key, blob, meta));
    for (const cached of this.objectUrls.keys()) {
      if (!await this.operate((store) => store.has(cached))) this.revoke(cached);
    }
  }

  async has(url: string): Promise<boolean> {
    const key = this.key(url);
    const exists = await this.operate((store) => store.has(key));
    if (!exists) this.revoke(key);
    return exists;
  }

  async getObjectUrl(url: string): Promise<string | null> {
    const key = this.key(url);
    const blob = await this.get(url);
    if (!blob || this.closed) return null;
    const existing = this.objectUrls.get(key);
    if (existing) return existing;
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrls.set(key, objectUrl);
    return objectUrl;
  }

  async delete(url: string): Promise<boolean> {
    const key = this.key(url);
    this.revoke(key);
    return this.operate((store) => store.delete(key));
  }

  async clear(): Promise<void> {
    for (const key of this.objectUrls.keys()) this.revoke(key);
    await this.operate((store) => store.clear());
    await this.memory.clear();
  }

  getSize(): Promise<number> {
    return this.operate((store) => store.getSize());
  }

  getEntriesCount(): Promise<number> {
    return this.operate((store) => store.getEntriesCount());
  }

  close(): void {
    this.closed = true;
    this.persistent?.close();
    void this.memory.clear();
    for (const key of this.objectUrls.keys()) this.revoke(key);
  }
}
