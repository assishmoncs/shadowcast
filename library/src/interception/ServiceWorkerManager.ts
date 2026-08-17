/**
 * ShadowCast - Service Worker Manager (Main Window Thread)
 */

import { ServiceWorkerOptions, SWAssetRequestMessage } from './types.js';

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
      return this.registration;
    } catch (err) {
      console.error('[ShadowCast SW] Failed to register Service Worker:', err);
      return null;
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

      const port = event.ports[0];
      if (!port) return;

      try {
        const blob = await this.callbacks.onRequestAssetBlob(data.url);
        port.postMessage({
          type: 'SHADOWCAST_SW_RESPONSE',
          id: data.id,
          success: true,
          blob,
          mimeType: blob.type,
        });
      } catch (err: any) {
        port.postMessage({
          type: 'SHADOWCAST_SW_RESPONSE',
          id: data.id,
          success: false,
          error: err?.message || String(err),
        });
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
      const result = await this.registration.unregister();
      this.registration = null;
      return result;
    }

    return false;
  }
}
