/// <reference lib="webworker" />

import type { SWAssetResponseMessage, SWConfigMessage, SWPattern } from './types.js';

const worker = self as unknown as ServiceWorkerGlobalScope;
interface ClientConfig {
  urls?: Set<string>;
  include: RegExp[];
  exclude: RegExp[];
  timeout: number;
}
const configurations = new Map<string, ClientConfig | null>();
const originalHeaders = [
  'authorization', 'range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
];

function patterns(input: (string | SWPattern)[] | undefined, defaults: RegExp[]): RegExp[] {
  if (!Array.isArray(input)) return defaults;
  return input.flatMap((entry) => {
    try {
      if (typeof entry === 'string') return new RegExp(entry, 'i');
      return new RegExp(entry.source, entry.flags.replace(/[gy]/g, ''));
    } catch {
      return [];
    }
  });
}

function rememberClient(id: string, config: ClientConfig | null): void {
  configurations.delete(id);
  configurations.set(id, config);
  if (configurations.size > 128) configurations.delete(configurations.keys().next().value!);
}

worker.addEventListener('install', (event) => { event.waitUntil(worker.skipWaiting()); });
worker.addEventListener('activate', (event) => { event.waitUntil(worker.clients.claim()); });
worker.addEventListener('message', (event) => {
  const data = event.data as SWConfigMessage;
  const client = event.source;
  if (data?.type !== 'SHADOWCAST_SW_CONFIG' || !client || !('id' in client)) return;
  const config: ClientConfig = {
    urls: Array.isArray(data.assetUrls) ? new Set(data.assetUrls) : undefined,
    include: patterns(data.includePatterns, []),
    exclude: patterns(data.excludePatterns, []),
    timeout: Number.isFinite(data.timeoutMs) && data.timeoutMs! > 0 ? Math.min(data.timeoutMs!, 30_000) : 8000,
  };
  // A closed tab leaves no registrations behind when the worker restarts.
  rememberClient(client.id, config);
});

function requestBlob(client: Client, url: string, timeout: number): Promise<Blob | undefined> {
  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    const finish = (blob?: Blob) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(blob);
    };
    const timer = setTimeout(finish, timeout);
    channel.port1.onmessageerror = () => finish();
    channel.port1.onmessage = ({ data }: MessageEvent<SWAssetResponseMessage>) => {
      if (data?.id === id && data.type === 'SHADOWCAST_SW_RESPONSE') {
        finish(data.success && data.blob instanceof Blob ? data.blob : undefined);
      }
    };
    try {
      client.postMessage({ type: 'SHADOWCAST_SW_REQUEST', id, url }, [channel.port2]);
    } catch {
      channel.port2.close();
      finish();
    }
  });
}

worker.addEventListener('fetch', (event) => {
  const { request, clientId } = event;
  if (!clientId || request.method !== 'GET' || request.mode === 'navigate' ||
      request.integrity || request.cache !== 'default' || originalHeaders.some((header) => request.headers.has(header))) return;

  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;
  const config = configurations.get(clientId);
  if (config === undefined) {
    // After an idle worker restarts, restore the page's configuration without delaying this fetch.
    rememberClient(clientId, null);
    event.waitUntil(worker.clients.get(clientId).then((client) => {
      client?.postMessage({ type: 'SHADOWCAST_SW_CONFIG_REQUEST' });
    }).catch(() => {}));
    return;
  }
  if (!config || (config.urls && !config.urls.has(url.href))) return;
  const matches = (pattern: RegExp) => pattern.test(url.href) || pattern.test(url.pathname);
  if (!config.include.some(matches) || config.exclude.some(matches)) return;

  event.respondWith((async () => {
    let blob: Blob | undefined;
    try {
      const client = await worker.clients.get(clientId);
      if (client) blob = await requestBlob(client, url.href, config.timeout);
    } catch {
      // The initiating client may have navigated away.
    }
    if (!blob) return fetch(request);
    return new Response(blob, {
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'X-ShadowCast-Source': 'service-worker',
      },
    });
  })());
});
