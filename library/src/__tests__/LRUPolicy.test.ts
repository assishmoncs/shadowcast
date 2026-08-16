import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUPolicy } from '../cache/LRUPolicy.js';
import { CacheEntryMetadata } from '../cache/types.js';

test('LRUPolicy evicts least recently accessed entries when size exceeds max', () => {
  const policy = new LRUPolicy(1000, 10, 0); // max 1000 bytes, no TTL

  const entries: CacheEntryMetadata[] = [
    {
      url: 'https://example.com/asset1.png',
      size: 400,
      mimeType: 'image/png',
      storedAt: 1000,
      lastAccessedAt: 1000,
      accessCount: 1,
    },
    {
      url: 'https://example.com/asset2.png',
      size: 400,
      mimeType: 'image/png',
      storedAt: 2000,
      lastAccessedAt: 3000,
      accessCount: 2,
    },
    {
      url: 'https://example.com/asset3.png',
      size: 400,
      mimeType: 'image/png',
      storedAt: 3000,
      lastAccessedAt: 4000,
      accessCount: 3,
    },
  ];

  // Total size is 1200 > 1000. Least recently accessed is asset1 (lastAccessedAt: 1000)
  const evictions = policy.findEvictionCandidates(entries, 0);
  assert.deepEqual(evictions, ['https://example.com/asset1.png']);
});

test('LRUPolicy evicts expired TTL entries', () => {
  const ttl = 10000; // 10 seconds
  const policy = new LRUPolicy(100000, 100, ttl);

  const now = Date.now();
  const entries: CacheEntryMetadata[] = [
    {
      url: 'https://example.com/fresh.png',
      size: 100,
      mimeType: 'image/png',
      storedAt: now - 1000,
      lastAccessedAt: now - 1000,
      accessCount: 1,
    },
    {
      url: 'https://example.com/expired.png',
      size: 100,
      mimeType: 'image/png',
      storedAt: now - 20000, // 20 seconds old (> 10s TTL)
      lastAccessedAt: now - 500,
      accessCount: 5,
    },
  ];

  const evictions = policy.findEvictionCandidates(entries, 0);
  assert.deepEqual(evictions, ['https://example.com/expired.png']);
});
