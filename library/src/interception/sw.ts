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
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: Clients;
};

const DEFAULT_PATTERNS: RegExp[] = [
  /\.(png|jpe?g|gif|webp|svg|avif|ico|mp4|webm|mp3|wasm|woff2?)(\?.*)?$/i,
];

let includePatterns: RegExp[] = [...DEFAULT_PATTERNS];
let excludePatterns: RegExp[] = [];
let requestTimeoutMs = 8000;

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // Fallback
    }
  }
  return `sc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function shouldInterceptUrl(rawUrl: string): boolean {
  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    // Use rawUrl if parsing fails
  }

  for (const exclude of excludePatterns) {
    if (exclude.test(rawUrl) || exclude.test(pathname)) {
      return false;
    }
  }

  return includePatterns.some((pattern) => pattern.test(rawUrl) || pattern.test(pathname));
}

if (typeof sw !== 'undefined' && typeof sw.addEventListener === 'function') {
  sw.addEventListener('install', (event: ExtendableEvent) => {
    event.waitUntil(sw.skipWaiting());
  });

  sw.addEventListener('activate', (event: ExtendableEvent) => {
    event.waitUntil(sw.clients.claim());
  });

  sw.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (!data || data.type !== 'SHADOWCAST_SW_CONFIG') return;

    if (Array.isArray(data.includePatterns) && data.includePatterns.length > 0) {
      includePatterns = data.includePatterns.map((p: string) => new RegExp(p, 'i'));
    }
    if (Array.isArray(data.excludePatterns)) {
      excludePatterns = data.excludePatterns.map((p: string) => new RegExp(p, 'i'));
    }
    if (typeof data.timeoutMs === 'number' && data.timeoutMs > 0) {
      requestTimeoutMs = data.timeoutMs;
    }
  });

  sw.addEventListener('fetch', (event: FetchEvent) => {
    const request = event.request;
    const url = request.url;

    // Only intercept GET requests
    if (request.method !== 'GET') {
      return;
    }

    // Check if URL matches static asset extensions or configured patterns
    if (!shouldInterceptUrl(url)) {
      return;
    }

    event.respondWith(
      (async () => {
        try {
          // Find an active window client running ShadowCast
          const allClients = await sw.clients.matchAll({
            type: 'window',
            includeUncontrolled: true,
          });
          if (!allClients || allClients.length === 0) {
            return fetch(request);
          }

          const client = allClients[0];
          const requestId = generateRequestId();

          // Create a MessageChannel to receive the response
          const channel = new MessageChannel();

          const responsePromise = new Promise<Response>((resolve, reject) => {
            const timeout = setTimeout(() => {
              try {
                channel.port1.close();
              } catch {
                // Ignore
              }
              reject(new Error('ShadowCast SW request timed out'));
            }, requestTimeoutMs);

            channel.port1.onmessage = (msgEvent) => {
              clearTimeout(timeout);
              try {
                channel.port1.close();
              } catch {
                // Ignore
              }
              const data = msgEvent.data;

              if (data && data.success && data.blob) {
                const headers = new Headers();
                headers.set(
                  'Content-Type',
                  data.mimeType || data.blob.type || 'application/octet-stream'
                );
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
        } catch {
          // Fallback to origin network fetch on any error
          return fetch(request);
        }
      })()
    );
  });
}
