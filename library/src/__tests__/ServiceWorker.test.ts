import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceWorkerManager } from '../interception/ServiceWorkerManager.js';
import { DEFAULT_SW_INCLUDE_PATTERNS } from '../interception/types.js';

test('Default service worker patterns match static assets with query strings', () => {
  const matches = (url: string) => DEFAULT_SW_INCLUDE_PATTERNS.some((pattern) => pattern.test(url));
  assert.equal(matches('https://example.com/photo.jpg'), true);
  assert.equal(matches('https://cdn.example.com/bundle.wasm?v=2'), true);
  assert.equal(matches('https://example.com/api/users.json'), false);
});

test('ServiceWorkerManager preserves regex flags and accepts requests only from its worker', async (t) => {
  const listeners = new Map<string, (event: unknown) => Promise<void> | void>();
  const posts: unknown[] = [];
  const worker = { postMessage: (message: unknown) => posts.push(message) };
  const registration = { active: worker, unregister: t.mock.fn(async () => true) };
  const register = t.mock.fn(async () => registration);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        register,
        addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  const asset = 'https://example.com/hero.webp';
  const manager = new ServiceWorkerManager({
    onRequestAssetBlob: async (url) => new Blob([url], { type: 'image/webp' }),
    assetUrls: [asset],
  });
  assert.ok(await manager.register('/sw.js', {
    scope: '/app',
    timeoutMs: 4000,
    includePatterns: [/\.webp$/gi, /\.PNG$/u],
  }));
  assert.deepEqual(register.mock.calls[0].arguments, ['/sw.js', { scope: '/app', type: 'module' }]);
  assert.deepEqual(posts[0], {
    type: 'SHADOWCAST_SW_CONFIG',
    assetUrls: [asset],
    includePatterns: [{ source: '\\.webp$', flags: 'i' }, { source: '\\.PNG$', flags: 'u' }],
    excludePatterns: undefined,
    timeoutMs: 4000,
  });

  const replies: { id: string; success: boolean; blob: Blob }[] = [];
  const port = { postMessage: (message: typeof replies[number]) => replies.push(message), close: t.mock.fn() };
  const data = { type: 'SHADOWCAST_SW_REQUEST', id: 'request', url: asset };
  const onMessage = listeners.get('message')!;
  await onMessage({ source: {}, data, ports: [port] });
  assert.equal(replies.length, 0);
  await onMessage({ source: worker, data, ports: [port] });
  assert.equal(replies[0].id, 'request');
  assert.equal(replies[0].success, true);
  assert.equal(await replies[0].blob.text(), asset);
  assert.equal(port.close.mock.callCount(), 1);
  assert.equal(await manager.unregister(), true);
  assert.equal(registration.unregister.mock.callCount(), 1);
  assert.equal(listeners.size, 0);
});
