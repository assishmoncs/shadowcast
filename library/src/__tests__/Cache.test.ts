import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCache } from '../cache/MemoryCache.js';
import { CacheManager } from '../cache/CacheManager.js';

test('MemoryCache stores, retrieves, tracks size, and respects LRU eviction', async () => {
  const cache = new MemoryCache({ maxSizeBytes: 10, maxEntries: 2, ttlMs: 60000 });

  const b1 = new Blob([new Uint8Array(4)], { type: 'image/png' });
  const b2 = new Blob([new Uint8Array(4)], { type: 'image/png' });
  const b3 = new Blob([new Uint8Array(4)], { type: 'image/png' });

  await cache.set('https://example.com/1.png', b1);
  await new Promise((r) => setTimeout(r, 5));
  await cache.set('https://example.com/2.png', b2);

  // Access 1.png so 2.png becomes the least recently accessed
  await new Promise((r) => setTimeout(r, 5));
  await cache.get('https://example.com/1.png');

  // Adding 3.png exceeds both maxSizeBytes (12 > 10) and maxEntries (3 > 2), evicting 2.png
  await cache.set('https://example.com/3.png', b3);

  assert.equal(await cache.has('https://example.com/1.png'), true);
  assert.equal(await cache.has('https://example.com/2.png'), false);
  assert.equal(await cache.has('https://example.com/3.png'), true);
  assert.equal(await cache.getEntriesCount(), 2);
  assert.equal(await cache.getSize(), 8);
});

test('MemoryCache updating existing URL in-place does not falsely evict other entries', async () => {
  const cache = new MemoryCache({ maxSizeBytes: 10, maxEntries: 2, ttlMs: 60000 });

  const b1 = new Blob([new Uint8Array(5)]);
  const b2 = new Blob([new Uint8Array(5)]);

  await cache.set('https://example.com/a.bin', b1);
  await cache.set('https://example.com/b.bin', b2);

  // Replace a.bin with another 5-byte blob; total stays 10 bytes and 2 entries
  await cache.set('https://example.com/a.bin', new Blob([new Uint8Array(5)]));

  assert.equal(await cache.has('https://example.com/a.bin'), true);
  assert.equal(await cache.has('https://example.com/b.bin'), true);
  assert.equal(await cache.getEntriesCount(), 2);
});

test('CacheManager normalizes URLs, generates ObjectURLs, and clears cleanly', async () => {
  const manager = new CacheManager({ driver: 'memory', maxSizeBytes: 1024 });
  const blob = new Blob([new TextEncoder().encode('hello cache')], { type: 'text/plain' });

  await manager.set('https://example.com/file.txt#section', blob);
  assert.equal(await manager.has('https://example.com/file.txt'), true);

  const objUrl = await manager.getObjectUrl('https://example.com/file.txt');
  assert.ok(typeof objUrl === 'string' && objUrl.length > 0);

  await manager.delete('https://example.com/file.txt');
  assert.equal(await manager.has('https://example.com/file.txt'), false);
  assert.equal(await manager.getObjectUrl('https://example.com/file.txt'), null);
});
