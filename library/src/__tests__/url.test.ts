import test from 'node:test';
import assert from 'node:assert/strict';
import { getAssetId } from '../utils/url.js';

test('getAssetId derives deterministic alphanumeric identifier', () => {
  const url = 'https://example.com/assets/banner.png';
  const id1 = getAssetId(url);
  const id2 = getAssetId(url);

  assert.equal(id1, id2);
  assert.match(id1, /^[a-zA-Z0-9]+$/);
  assert.ok(id1.length > 0 && id1.length <= 20);
});

test('getAssetId handles query parameters and edge cases', () => {
  const url1 = 'https://example.com/image.jpg?w=800&q=80';
  const url2 = 'https://example.com/image.jpg?w=1200&q=80';

  const id1 = getAssetId(url1);
  const id2 = getAssetId(url2);

  assert.notEqual(id1, id2);
});
