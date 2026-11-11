import { DEFAULT_SW_INCLUDE_PATTERNS, ServiceWorkerOptions, SWAssetRequestMessage, SWConfigMessage } from './types.js';

export interface ServiceWorkerManagerCallbacks {
  onRequestAssetBlob: (url: string) => Promise<Blob>;
  assetUrls?: readonly string[];
}

export class ServiceWorkerManager {
  private registration: ServiceWorkerRegistration | null = null;
  private generation = 0;
  private config?: SWConfigMessage;
  private listening = false;

  constructor(private readonly callbacks: ServiceWorkerManagerCallbacks) {}

  async register(scriptUrl = '/sw.js', options: ServiceWorkerOptions = {}): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
    const generation = ++this.generation;
    try {
      const registration = await navigator.serviceWorker.register(scriptUrl, { scope: options.scope || '/', type: 'module' });
      if (generation !== this.generation) return null;
      this.registration = registration;
      const serialize = (pattern: string | RegExp) => typeof pattern === 'string'
        ? { source: pattern, flags: 'i' }
        : { source: pattern.source, flags: pattern.flags.replace(/[gy]/g, '') };
      this.config = {
        type: 'SHADOWCAST_SW_CONFIG',
        assetUrls: this.callbacks.assetUrls,
        includePatterns: (options.includePatterns ?? DEFAULT_SW_INCLUDE_PATTERNS).map(serialize),
        excludePatterns: options.excludePatterns?.map(serialize),
        timeoutMs: options.timeoutMs,
      };
      if (!this.listening) {
        navigator.serviceWorker.addEventListener('message', this.onMessage);
        navigator.serviceWorker.addEventListener('controllerchange', this.postConfig);
        this.listening = true;
      }
      this.postConfig();
      return registration;
    } catch (error) {
      console.warn('[ShadowCast] Service worker registration failed:', error);
      return null;
    }
  }

  private postConfig = (): void => {
    const registration = this.registration;
    if (!registration || !this.config) return;
    for (const worker of [registration.active, registration.waiting, registration.installing]) {
      try {
        worker?.postMessage(this.config);
      } catch {
        // A worker can become redundant during an update.
      }
    }
  };

  private onMessage = async (event: MessageEvent): Promise<void> => {
    const registration = this.registration;
    if (!registration || !event.source ||
        ![registration.active, registration.installing, registration.waiting].includes(event.source as ServiceWorker)) return;

    if (event.data?.type === 'SHADOWCAST_SW_CONFIG_REQUEST') {
      this.postConfig();
      return;
    }

    const request = event.data as SWAssetRequestMessage;
    const port = event.ports?.[0];
    if (!port || !request || typeof request.id !== 'string' || typeof request.url !== 'string') return;
    if (request.type !== 'SHADOWCAST_SW_REQUEST') return;
    try {
      const blob = await this.callbacks.onRequestAssetBlob(request.url);
      port.postMessage({ type: 'SHADOWCAST_SW_RESPONSE', id: request.id, success: true, blob, mimeType: blob.type });
    } catch {
      try {
        port.postMessage({ type: 'SHADOWCAST_SW_RESPONSE', id: request.id, success: false });
      } catch {
        // The original fetch already resumed after a timeout.
      }
    } finally {
      port.close();
    }
  };

  detach(): void {
    this.generation++;
    const worker = this.registration?.active;
    try {
      worker?.postMessage({ type: 'SHADOWCAST_SW_CONFIG', assetUrls: [] });
    } catch {
      // The worker may have stopped.
    }
    if (this.listening) {
      navigator.serviceWorker.removeEventListener('message', this.onMessage);
      navigator.serviceWorker.removeEventListener('controllerchange', this.postConfig);
      this.listening = false;
    }
    this.registration = null;
    this.config = undefined;
  }

  async unregister(): Promise<boolean> {
    const registration = this.registration;
    this.detach();
    try {
      return await registration?.unregister() ?? false;
    } catch {
      return false;
    }
  }
}
