/**
 * ShadowCast - Service Worker Manager (Main Window Thread)
 */

import { ServiceWorkerOptions, SWAssetRequestMessage, SWConfigMessage } from './types.js';

export interface ServiceWorkerManagerCallbacks {
  onRequestAssetBlob: (url: string) => Promise<Blob>;
}

export class ServiceWorkerManager {
  private registration: ServiceWorkerRegistration | null = null;
  private messageListener: ((event: MessageEvent) => void) | null = null;

  constructor(private callbacks: ServiceWorkerManagerCallbacks) {}

  async register(
    scriptUrl: string = '/sw.js',
    options: ServiceWorkerOptions = {}
  ): Promise<ServiceWorkerRegistration | null> {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      console.warn('[ShadowCast SW] Service Workers are not supported in this environment.');
      return null;
    }

    try {
      this.registration = await navigator.serviceWorker.register(scriptUrl, {
        scope: options.scope || '/',
      });

      this.setupMessageListener();
      this.postConfigToWorker(options);
      return this.registration;
    } catch (err) {
      console.error('[ShadowCast SW] Failed to register Service Worker:', err);
      return null;
    }
  }

  private postConfigToWorker(options: ServiceWorkerOptions): void {
    if (!this.registration) return;
    const worker =
      this.registration.active || this.registration.waiting || this.registration.installing;
    if (!worker) return;

    const serializePattern = (p: string | RegExp): string =>
      p instanceof RegExp ? p.source : String(p);

    const configMsg: SWConfigMessage = {
      type: 'SHADOWCAST_SW_CONFIG',
      includePatterns: options.includePatterns?.map(serializePattern),
      excludePatterns: options.excludePatterns?.map(serializePattern),
      timeoutMs: options.timeoutMs,
    };

    try {
      worker.postMessage(configMsg);
    } catch {
      // Ignore postMessage errors if worker is not ready
    }
  }

  private setupMessageListener(): void {
    if (this.messageListener) {
      navigator.serviceWorker.removeEventListener('message', this.messageListener);
    }

    this.messageListener = async (event: MessageEvent) => {
      const data = event.data as SWAssetRequestMessage;
      if (!data || data.type !== 'SHADOWCAST_SW_REQUEST') {
        return;
      }

      const port = event.ports?.[0];
      if (!port) return;

      try {
        const blob = await this.callbacks.onRequestAssetBlob(data.url);
        port.postMessage({
          type: 'SHADOWCAST_SW_RESPONSE',
          id: data.id,
          success: true,
          blob,
          mimeType: blob.type || 'application/octet-stream',
        });
      } catch (err: any) {
        port.postMessage({
          type: 'SHADOWCAST_SW_RESPONSE',
          id: data.id,
          success: false,
          error: err?.message || String(err),
        });
      } finally {
        try {
          port.close?.();
        } catch {
          // Ignore port close error
        }
      }
    };

    navigator.serviceWorker.addEventListener('message', this.messageListener);
  }

  async unregister(): Promise<boolean> {
    if (this.messageListener && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }

    if (this.registration) {
      const reg = this.registration;
      this.registration = null;
      try {
        return await reg.unregister();
      } catch {
        return false;
      }
    }

    return false;
  }
}
