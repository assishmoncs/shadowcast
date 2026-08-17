/**
 * ShadowCast - Cache Types and Interfaces
 */

export interface CacheEntryMetadata {
  url: string;
  size: number;
  mimeType: string;
  assetHash?: string;
  storedAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

export interface CacheEntry extends CacheEntryMetadata {
  blob: Blob;
}

export interface CacheConfig {
  driver?: 'indexeddb' | 'memory';
  maxSizeBytes?: number; // e.g. 250 MB
  maxEntries?: number;   // e.g. 500 items
  ttlMs?: number;        // e.g. 7 days
}

export interface CacheStore {
  get(url: string): Promise<Blob | undefined>;
  set(url: string, blob: Blob, meta?: { assetHash?: string }): Promise<void>;
  has(url: string): Promise<boolean>;
  delete(url: string): Promise<boolean>;
  clear(): Promise<void>;
  getSize(): Promise<number>;
  getEntriesCount(): Promise<number>;
}

export const DEFAULT_MAX_CACHE_SIZE = 250 * 1024 * 1024; // 250 MB
export const DEFAULT_MAX_ENTRIES = 500;
export const DEFAULT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
