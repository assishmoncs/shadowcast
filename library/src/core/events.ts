/**
 * ShadowCast - Lightweight Typed Event Emitter
 */

import { ConnectionState, TransferSource } from './types.js';

export interface ShadowCastEventMap {
  'peer:join': { peerId: string; totalPeers: number };
  'peer:leave': { peerId: string; totalPeers: number };
  'transfer:start': { url: string; source: TransferSource; totalBytes?: number };
  'transfer:progress': {
    url: string;
    source: TransferSource;
    bytesReceived: number;
    totalBytes: number;
    percent: number;
  };
  'transfer:complete': { url: string; source: TransferSource; durationMs: number; bytes: number };
  'transfer:error': { url: string; error: Error };
  'cache:hit': { url: string };
  'cache:store': { url: string; bytes: number };
  'bandwidth:saved': { bytes: number; cumulativeBytes: number };
  'connection:status': { state: ConnectionState };
}

export type EventListener<T> = (data: T) => void;

interface WrappedListener<T> {
  (data: T): void;
  __originalListener?: EventListener<T>;
}

export class EventEmitter<Events = ShadowCastEventMap> {
  private listeners: Map<keyof Events, Set<WrappedListener<any>>> = new Map();

  on<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): () => void {
    if (typeof listener !== 'function') {
      return () => {};
    }
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);

    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): () => void {
    if (typeof listener !== 'function') {
      return () => {};
    }
    const onceWrapper: WrappedListener<Events[K]> = (data) => {
      this.off(event, onceWrapper);
      listener(data);
    };
    onceWrapper.__originalListener = listener;
    return this.on(event, onceWrapper);
  }

  off<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;

    for (const item of set) {
      if (item === listener || item.__originalListener === listener) {
        set.delete(item);
      }
    }

    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  emit<K extends keyof Events>(event: K, data: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;

    for (const listener of Array.from(set)) {
      try {
        listener(data);
      } catch (err) {
        console.error(`[ShadowCast EventEmitter] Error in listener for "${String(event)}":`, err);
      }
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners<K extends keyof Events>(event?: K): void {
    if (event !== undefined) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}
