/**
 * ShadowCast - Service Worker Script
 * Intercepts HTTP requests and routes them to the ShadowCast P2P client in the main thread.
 */

// Context typing for Service Worker environment under DOM tsconfig
type ExtendableEvent = Event & {
  waitUntil(fn: Promise<any>): void;
};

type FetchEvent = ExtendableEvent & {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
};

interface WindowClient {
  id: string;
  url: string;
  postMessage(message: any, transfer?: Transferable[]): void;
}

interface Clients {
  claim(): Promise<void>;
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<WindowClient[]>;
}

const sw = self as unknown as {
  addEventListener(type: 'install', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: Clients;
};

const DEFAULT_PATTERNS = [
  /\.(png|jpe?g|gif|webp|svg|avif|ico|mp4|webm|mp3|wasm|woff2?)$/i,
];

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(sw.skipWaiting());
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request;
  const url = request.url;

  // Only intercept GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Check if URL matches static asset extensions or configured patterns
  const isStaticAsset = DEFAULT_PATTERNS.some((pattern) => pattern.test(url));
  if (!isStaticAsset) {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        // Find an active window client running ShadowCast
        const allClients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (!allClients || allClients.length === 0) {
          return fetch(request);
        }

        const client = allClients[0];
        const requestId = crypto.randomUUID();

        // Create a MessageChannel to receive the response
        const channel = new MessageChannel();

        const responsePromise = new Promise<Response>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('ShadowCast SW request timed out'));
          }, 8000);

          channel.port1.onmessage = (msgEvent) => {
            clearTimeout(timeout);
            const data = msgEvent.data;

            if (data && data.success && data.blob) {
              const headers = new Headers();
              headers.set('Content-Type', data.mimeType || data.blob.type || 'application/octet-stream');
              headers.set('X-ShadowCast-Source', 'P2P-ServiceWorker');

              resolve(
                new Response(data.blob, {
                  status: 200,
                  headers,
                })
              );
            } else {
              reject(new Error(data?.error || 'ShadowCast SW failed to load asset'));
            }
          };
        });

        // Send request to client window
        client.postMessage(
          {
            type: 'SHADOWCAST_SW_REQUEST',
            id: requestId,
            url,
          },
          [channel.port2]
        );

        return await responsePromise;
      } catch (err) {
        // Fallback to origin network fetch on any error
        return fetch(request);
      }
    })()
  );
});
