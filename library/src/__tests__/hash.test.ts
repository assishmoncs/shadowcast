import test from 'node:test';
import assert from 'node:assert/strict';
import { hashString, hashBuffer, hashBlob } from '../utils/hash.js';

test('hashString produces valid 64-char hex SHA-256 string', async () => {
  const hash = await hashString('shadowcast-test-asset');
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test('hashBuffer produces identical hash for identical buffers', async () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const hash1 = await hashBuffer(data.buffer);
  const hash2 = await hashBuffer(data.buffer);
  assert.equal(hash1, hash2);
});

test('hashBlob produces identical hash to buffer', async () => {
  const data = new Uint8Array([10, 20, 30, 40]);
  const blob = new Blob([data]);
  const blobHash = await hashBlob(blob);
  const bufferHash = await hashBuffer(data.buffer);
  assert.equal(blobHash, bufferHash);
});
