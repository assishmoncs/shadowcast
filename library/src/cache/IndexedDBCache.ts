/**
 * ShadowCast - IndexedDB Persistent Cache Store
 */

import { CacheConfig, CacheEntry, CacheEntryMetadata, CacheStore } from './types.js';
import { LRUPolicy } from './LRUPolicy.js';

const DB_NAME = 'shadowcast_cache_db';
const STORE_NAME = 'assets';
const DB_VERSION = 1;

export class IndexedDBCache implements CacheStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private lruPolicy: LRUPolicy;

  constructor(config: CacheConfig = {}) {
    this.lruPolicy = new LRUPolicy(config.maxSizeBytes, config.maxEntries, config.ttlMs);
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    if (typeof window === 'undefined' || !window.indexedDB) {
      throw new Error('IndexedDB is not supported in this environment');
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
          store.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false });
          store.createIndex('storedAt', 'storedAt', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  async get(url: string): Promise<Blob | undefined> {
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
        const req = store.get(url);
        req.onsuccess = () => resolve(req.result as CacheEntry | undefined);
        req.onerror = () => reject(req.error);
      });

      if (!entry) return undefined;

      // TTL check
      if (this.lruPolicy.ttlMs > 0 && Date.now() - entry.storedAt > this.lruPolicy.ttlMs) {
        store.delete(url);
        return undefined;
      }

      // Update access stats
      entry.lastAccessedAt = Date.now();
      entry.accessCount = (entry.accessCount || 0) + 1;
      store.put(entry);

      return entry.blob;
    } catch (err) {
      console.warn('[ShadowCast IndexedDB] Failed to get entry:', err);
      return undefined;
    }
  }

  async set(url: string, blob: Blob, meta?: { assetHash?: string }): Promise<void> {
    try {
      // Execute eviction check
      const metadataList = await this.getAllMetadata();
      const toEvict = this.lruPolicy.findEvictionCandidates(metadataList, blob.size);
      for (const evictUrl of toEvict) {
        await this.delete(evictUrl);
      }

      const db = await this.getDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

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

      await new Promise<void>((resolve, reject) => {
        const req = store.put(entry);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[ShadowCast IndexedDB] Failed to set entry:', err);
    }
  }

  private async getAllMetadata(): Promise<CacheEntryMetadata[]> {
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);

      return new Promise<CacheEntryMetadata[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const list = (req.result as CacheEntry[]) || [];
          resolve(
            list.map(({ url, size, mimeType, assetHash, storedAt, lastAccessedAt, accessCount }) => ({
              url,
              size,
              mimeType,
              assetHash,
              storedAt,
              lastAccessedAt,
              accessCount,
            }))
          );
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  async has(url: string): Promise<boolean> {
    const blob = await this.get(url);
    return blob !== undefined;
  }

  async delete(url: string): Promise<boolean> {
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const req = store.delete(url);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      return true;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[ShadowCast IndexedDB] Failed to clear store:', err);
    }
  }

  async getSize(): Promise<number> {
    const metadata = await this.getAllMetadata();
    return metadata.reduce((acc, m) => acc + m.size, 0);
  }

  async getEntriesCount(): Promise<number> {
    const metadata = await this.getAllMetadata();
    return metadata.length;
  }
}
