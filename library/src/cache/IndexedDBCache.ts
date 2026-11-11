import { CacheConfig, CacheEntry, CacheEntryMetadata, CacheStore, CacheWriteOptions } from './types.js';
import { LRUPolicy } from './LRUPolicy.js';

const ASSETS = 'assets';
const METADATA = 'metadata';
const DB_VERSION = 2;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function metadataFor({ blob: _blob, ...metadata }: CacheEntry): CacheEntryMetadata {
  return metadata;
}

export class IndexedDBCache implements CacheStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly lru: LRUPolicy;

  constructor(config: CacheConfig = {}, private readonly dbName = 'shadowcast_cache_db') {
    this.lru = new LRUPolicy(config.maxSizeBytes, config.maxEntries, config.ttlMs);
  }

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        reject(new Error('IndexedDB open request was blocked'));
      };
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        const assets = db.objectStoreNames.contains(ASSETS)
          ? request.transaction!.objectStore(ASSETS)
          : db.createObjectStore(ASSETS, { keyPath: 'url' });
        const metadata = db.createObjectStore(METADATA, { keyPath: 'url' });
        const cursor = assets.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (entry) {
            metadata.put(metadataFor(entry.value));
            entry.continue();
          }
        };
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked || this.dbPromise !== opening) {
          db.close();
          reject(new Error('IndexedDB connection was canceled'));
          return;
        }
        const invalidate = () => {
          if (this.dbPromise === opening) this.dbPromise = null;
          db.close();
        };
        db.onversionchange = invalidate;
        db.onclose = invalidate;
        resolve(db);
      };
    });
    this.dbPromise = opening;
    void opening.catch(() => {
      if (this.dbPromise === opening) this.dbPromise = null;
    });
    return opening;
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    work: (assets: IDBObjectStore, metadata: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.getDB();
    const tx = db.transaction([ASSETS, METADATA], mode);
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    try {
      const [result] = await Promise.all([
        work(tx.objectStore(ASSETS), tx.objectStore(METADATA)),
        committed,
      ]);
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Transaction already finished. */ }
      throw error;
    }
  }

  async get(url: string): Promise<Blob | undefined> {
    return this.transaction('readwrite', async (assets, metadata) => {
      const entry: CacheEntryMetadata | undefined = await requestResult(metadata.get(url));
      if (!entry) return;
      if (this.lru.isExpired(entry)) {
        assets.delete(url);
        metadata.delete(url);
        return;
      }

      const asset: CacheEntry | undefined = await requestResult(assets.get(url));
      if (!asset) {
        metadata.delete(url);
        return;
      }
      entry.lastAccessedAt = Date.now();
      entry.accessCount = (entry.accessCount || 0) + 1;
      metadata.put(entry);
      return asset.blob;
    });
  }

  async set(url: string, blob: Blob, meta?: CacheWriteOptions): Promise<void> {
    if (this.lru.maxEntries <= 0 || blob.size > this.lru.maxSizeBytes) return;
    await this.transaction('readwrite', async (assets, metadata) => {
      const entries = await requestResult<CacheEntryMetadata[]>(metadata.getAll());
      for (const key of this.lru.findEvictionCandidates(entries, blob.size, url)) {
        assets.delete(key);
        metadata.delete(key);
      }
      const now = Date.now();
      const entry: CacheEntry = {
        url, blob, size: blob.size, mimeType: blob.type || 'application/octet-stream',
        assetHash: meta?.assetHash, expiresAt: meta?.expiresAt, storedAt: now, lastAccessedAt: now, accessCount: 1,
      };
      assets.put(entry);
      metadata.put(metadataFor(entry));
    });
  }

  async has(url: string): Promise<boolean> {
    return this.transaction('readonly', async (_, metadata) => {
      const entry: CacheEntryMetadata | undefined = await requestResult(metadata.get(url));
      return entry !== undefined && !this.lru.isExpired(entry);
    });
  }

  async delete(url: string): Promise<boolean> {
    return this.transaction('readwrite', async (assets, metadata) => {
      const exists = await requestResult(metadata.getKey(url));
      if (exists === undefined) return false;
      assets.delete(url);
      metadata.delete(url);
      return true;
    });
  }

  async clear(): Promise<void> {
    await this.transaction('readwrite', async (assets, metadata) => {
      assets.clear();
      metadata.clear();
    });
  }

  private liveMetadata(): Promise<CacheEntryMetadata[]> {
    return this.transaction('readonly', async (_, store) => {
      const entries = await requestResult<CacheEntryMetadata[]>(store.getAll());
      const now = Date.now();
      return entries.filter((entry) => !this.lru.isExpired(entry, now));
    });
  }

  async getSize(): Promise<number> {
    return (await this.liveMetadata()).reduce((total, entry) => total + entry.size, 0);
  }

  async getEntriesCount(): Promise<number> {
    return (await this.liveMetadata()).length;
  }

  close(): void {
    const pending = this.dbPromise;
    this.dbPromise = null;
    void pending?.then((db) => db.close(), () => {});
  }
}
