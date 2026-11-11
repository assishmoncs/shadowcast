import test from 'node:test';
import assert from 'node:assert/strict';
import { hashString, hashBuffer, hashBlob, sha256Fallback } from '../utils/hash.js';
import { getAssetId, normalizeAssetUrl, generateUUID } from '../utils/url.js';

test('hashString produces valid 64-char hex SHA-256 string matching NIST test vectors', async () => {
  const emptyHash = await hashString('');
  assert.equal(
    emptyHash,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );

  const abcHash = await hashString('abc');
  assert.equal(
    abcHash,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );

  const hash = await hashString('shadowcast-test-asset');
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test('sha256Fallback matches Web Crypto digest across arbitrary payloads', async () => {
  const payload = new Uint8Array(256);
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (i * 37 + 13) & 0xff;
  }

  const fallbackHex = sha256Fallback(payload);
  const bufferHex = await hashBuffer(payload);
  assert.equal(fallbackHex, bufferHex);
  assert.equal(fallbackHex.length, 64);
});

test('hashBuffer handles Uint8Array subviews with non-zero byteOffset', async () => {
  const backing = new Uint8Array([99, 99, 10, 20, 30, 40, 88, 88]);
  const subview = backing.subarray(2, 6); // [10, 20, 30, 40]
  const standalone = new Uint8Array([10, 20, 30, 40]);

  const subviewHash = await hashBuffer(subview);
  const standaloneHash = await hashBuffer(standalone.buffer);
  assert.equal(subviewHash, standaloneHash);
});

test('hashBlob produces identical hash to buffer', async () => {
  const data = new Uint8Array([10, 20, 30, 40]);
  const blob = new Blob([data]);
  const blobHash = await hashBlob(blob);
  const bufferHash = await hashBuffer(data.buffer);
  assert.equal(blobHash, bufferHash);
});

test('getAssetId derives deterministic alphanumeric identifier and strips URL hash fragments', () => {
  const url = 'https://example.com/assets/banner.png';
  const id1 = getAssetId(url);
  const id2 = getAssetId(url + '#section-1');

  assert.equal(id1, id2);
  assert.match(id1, /^[a-zA-Z0-9]+$/);
  assert.ok(id1.length > 0 && id1.length <= 20);
});

test('normalizeAssetUrl and generateUUID handle edge cases', () => {
  assert.equal(
    normalizeAssetUrl('  https://example.com/a.png?v=1#frag  '),
    'https://example.com/a.png?v=1'
  );
  assert.equal(normalizeAssetUrl(''), '');

  const uuid1 = generateUUID();
  const uuid2 = generateUUID();
  assert.notEqual(uuid1, uuid2);
  assert.match(uuid1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
