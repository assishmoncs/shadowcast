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

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
          store.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false });
          store.createIndex('storedAt', 'storedAt', { unique: false });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        db.onclose = () => {
          this.dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error);
      };

      request.onblocked = () => {
        this.dbPromise = null;
        reject(new Error('IndexedDB open request was blocked'));
      };
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
      if (this.lruPolicy.isExpired(entry)) {
        await new Promise<void>((resolve) => {
          const delReq = store.delete(url);
          delReq.onsuccess = () => resolve();
          delReq.onerror = () => resolve();
        });
        return undefined;
      }

      // Update access stats
      entry.lastAccessedAt = Date.now();
      entry.accessCount = (entry.accessCount || 0) + 1;
      await new Promise<void>((resolve) => {
        const putReq = store.put(entry);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => resolve();
      });

      return entry.blob;
    } catch (err) {
      console.warn('[ShadowCast IndexedDB] Failed to get entry:', err);
      return undefined;
    }
  }

  async set(url: string, blob: Blob, meta?: { assetHash?: string }): Promise<void> {
    try {
      if (this.lruPolicy.maxEntries <= 0 || blob.size > this.lruPolicy.maxSizeBytes) {
        return;
      }

      // Execute eviction check
      const metadataList = await this.getAllMetadata();
      const toEvict = this.lruPolicy.findEvictionCandidates(metadataList, blob.size, url);
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
        mimeType: blob.type || 'application/octet-stream',
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
    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
        const req = store.get(url);
        req.onsuccess = () => resolve(req.result as CacheEntry | undefined);
        req.onerror = () => reject(req.error);
      });

      if (!entry) return false;

      if (this.lruPolicy.isExpired(entry)) {
        store.delete(url);
        return false;
      }

      return true;
    } catch {
      return false;
    }
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
    const now = Date.now();
    return metadata
      .filter((m) => !this.lruPolicy.isExpired(m, now))
      .reduce((acc, m) => acc + m.size, 0);
  }

  async getEntriesCount(): Promise<number> {
    const metadata = await this.getAllMetadata();
    const now = Date.now();
    return metadata.filter((m) => !this.lruPolicy.isExpired(m, now)).length;
  }
}
