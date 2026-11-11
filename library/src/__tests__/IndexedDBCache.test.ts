import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IndexedDBCache } from '../cache/IndexedDBCache.js';
import { CacheManager } from '../cache/CacheManager.js';

test('IndexedDB serializes concurrent writes and enforces a single byte and entry budget across instances', async (t) => {
  const name = crypto.randomUUID();
  const cacheA = new IndexedDBCache({ maxSizeBytes: 8, maxEntries: 2 }, name);
  const cacheB = new IndexedDBCache({ maxSizeBytes: 8, maxEntries: 2 }, name);
  t.after(() => { cacheA.close(); cacheB.close(); });

  await Promise.all(Array.from({ length: 16 }, (_, index) =>
    (index % 2 ? cacheA : cacheB).set(String(index), new Blob(['data']))));
  assert.equal(await cacheA.getSize(), 8);
  assert.equal(await cacheB.getEntriesCount(), 2);
  assert.equal(await cacheA.delete('unknown'), false);
  await cacheB.clear();
  assert.equal(await cacheA.getEntriesCount(), 0);
});

test('IndexedDB upgrades v1 entries and preserves blobs, TTL and LRU metadata', async (t) => {
  const name = crypto.randomUUID();
  const now = Date.now();
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      const assets = opening.result.createObjectStore('assets', { keyPath: 'url' });
      for (const [url, storedAt] of [['old', now - 600_000], ['keep', now]] as const) {
        assets.put({
          url, storedAt, lastAccessedAt: storedAt, size: 4, accessCount: 1,
          mimeType: 'text/plain', blob: new Blob(['data'], { type: 'text/plain' }),
        });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  legacy.close();
  const cache = new IndexedDBCache({ ttlMs: 60_000 }, name);
  t.after(() => cache.close());
  assert.equal(await cache.has('old'), false);
  assert.equal(await cache.get('old'), undefined);
  assert.equal(await (await cache.get('keep'))?.text(), 'data');
  assert.equal(await cache.getSize(), 4);
});

test('CacheManager degrades to memory when persistent storage is blocked', async (t) => {
  t.mock.method(indexedDB, 'open', () => { throw new DOMException('blocked', 'SecurityError'); });
  const warning = t.mock.method(console, 'warn', () => {});
  const cache = new CacheManager({}, crypto.randomUUID());
  t.after(() => cache.close());
  const url = 'https://example.com/data';
  await cache.set(url, new Blob(['data']));
  assert.equal(await (await cache.get(url))?.text(), 'data');
  assert.equal(warning.mock.callCount(), 1);
  await cache.clear();
  assert.equal(await cache.has(url), false);
});
