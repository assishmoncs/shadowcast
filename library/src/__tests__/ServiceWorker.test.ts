import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceWorkerManager } from '../interception/ServiceWorkerManager.js';
import { DEFAULT_SW_INCLUDE_PATTERNS } from '../interception/types.js';

test('DEFAULT_SW_INCLUDE_PATTERNS matches static assets with and without query strings', () => {
  const urls = [
    'https://example.com/photo.jpg',
    'https://images.unsplash.com/photo.png?q=80&w=1080',
    'https://cdn.example.com/bundle.wasm?v=2.1.0',
    'https://cdn.example.com/font.woff2',
  ];

  for (const url of urls) {
    const matched = DEFAULT_SW_INCLUDE_PATTERNS.some((p) => p.test(url));
    assert.equal(matched, true, `Should match ${url}`);
  }

  const nonStatic = 'https://example.com/api/v1/users.json';
  assert.equal(
    DEFAULT_SW_INCLUDE_PATTERNS.some((p) => p.test(nonStatic)),
    false
  );
});

test('ServiceWorkerManager registers worker, posts config, and serves SHADOWCAST_SW_REQUEST over MessageChannel', async () => {
  let registeredListener: ((ev: any) => void) | null = null;
  let postedConfig: any = null;
  let unregistered = false;

  (globalThis as any).window = globalThis;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        register: async () => ({
          active: {
            postMessage: (msg: any) => {
              postedConfig = msg;
            },
          },
          unregister: async () => {
            unregistered = true;
            return true;
          },
        }),
        addEventListener: (_type: string, fn: any) => {
          registeredListener = fn;
        },
        removeEventListener: () => {
          registeredListener = null;
        },
      },
    },
  });

  const swManager = new ServiceWorkerManager({
    onRequestAssetBlob: async (url) =>
      new Blob([new TextEncoder().encode(`content:${url}`)], { type: 'image/webp' }),
  });

  const reg = await swManager.register('/sw.js', {
    scope: '/app',
    timeoutMs: 4000,
    includePatterns: [/\.webp$/i],
  });

  assert.ok(reg !== null);
  assert.equal(postedConfig?.type, 'SHADOWCAST_SW_CONFIG');
  assert.equal(postedConfig?.timeoutMs, 4000);
  assert.ok(registeredListener !== null);

  // Simulate Service Worker requesting an asset via MessagePort
  let portReply: any = null;
  const mockPort = {
    postMessage: (msg: any) => {
      portReply = msg;
    },
    close: () => {},
  };

  await registeredListener!({
    data: {
      type: 'SHADOWCAST_SW_REQUEST',
      id: 'req-42',
      url: 'https://example.com/hero.webp',
    },
    ports: [mockPort],
  });

  assert.ok(portReply !== null);
  assert.equal(portReply.success, true);
  assert.equal(portReply.id, 'req-42');
  assert.equal(portReply.mimeType, 'image/webp');
  assert.equal(await portReply.blob.text(), 'content:https://example.com/hero.webp');

  const unregResult = await swManager.unregister();
  assert.equal(unregResult, true);
  assert.equal(unregistered, true);
});
