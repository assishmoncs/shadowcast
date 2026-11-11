/**
 * ShadowCast - Signaling Client
 */

import { SignalingMessagePayload } from '../core/types.js';

export type SignalingMessageHandler = (msg: SignalingMessagePayload) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private connectingPromise: Promise<void> | null = null;
  private messageHandlers: Set<SignalingMessageHandler> = new Set();
  private closeHandlers: Set<() => void> = new Set();
  private currentRoom: string = '';
  private currentPeerId: string = '';

  constructor(
    public readonly url: string,
    private readonly connectTimeoutMs: number = 10000
  ) {}

  async connect(room: string, peerId: string): Promise<void> {
    if (!room || typeof room !== 'string') {
      throw new Error('[SignalingClient] Room ID must be a non-empty string');
    }
    if (!peerId || typeof peerId !== 'string') {
      throw new Error('[SignalingClient] Peer ID must be a non-empty string');
    }

    if (this.isConnected && this.currentRoom === room && this.currentPeerId === peerId) {
      return;
    }

    if (this.connectingPromise && this.currentRoom === room && this.currentPeerId === peerId) {
      return this.connectingPromise;
    }

    this.disconnect(false);
    this.currentRoom = room;
    this.currentPeerId = peerId;

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;

      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        this.connectingPromise = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.ws = socket;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.connectingPromise = null;
          this.detachAndCloseSocket(socket);
          if (this.ws === socket) {
            this.ws = null;
          }
          reject(new Error(`[SignalingClient] Connection timed out after ${this.connectTimeoutMs}ms`));
        }
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        if (this.ws !== socket) return;
        clearTimeout(timer);
        try {
          socket.send(JSON.stringify({ type: 'join', room, from: peerId }));
          settled = true;
          this.connectingPromise = null;
          resolve();
        } catch (err) {
          settled = true;
          this.connectingPromise = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        try {
          const raw = typeof event.data === 'string' ? event.data : String(event.data);
          const msg = JSON.parse(raw) as SignalingMessagePayload;
          if (!msg || typeof msg.type !== 'string') return;
          for (const handler of Array.from(this.messageHandlers)) {
            try {
              handler(msg);
            } catch (handlerErr) {
              console.error('[SignalingClient] Error in message handler:', handlerErr);
            }
          }
        } catch (err) {
          console.error('[SignalingClient] Failed to parse message:', err);
        }
      };

      socket.onerror = (err) => {
        if (this.ws !== socket) return;
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.connectingPromise = null;
          reject(err instanceof Error ? err : new Error('[SignalingClient] WebSocket error'));
        }
      };

      socket.onclose = () => {
        if (this.ws !== socket) return;
        clearTimeout(timer);
        this.ws = null;
        this.connectingPromise = null;
        if (!settled) {
          settled = true;
          reject(new Error('[SignalingClient] WebSocket closed before connection established'));
        }
        for (const handler of Array.from(this.closeHandlers)) {
          try {
            handler();
          } catch (closeErr) {
            console.error('[SignalingClient] Error in close handler:', closeErr);
          }
        }
      };
    });

    return this.connectingPromise;
  }

  private detachAndCloseSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {
      // Ignore close errors
    }
  }

  onMessage(handler: SignalingMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  send(msg: SignalingMessagePayload): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        return true;
      } catch (err) {
        console.error('[SignalingClient] Failed to send message:', err);
        return false;
      }
    }
    return false;
  }

  sendOffer(target: string, from: string, sdp: RTCSessionDescriptionInit): boolean {
    return this.send({
      type: 'offer',
      target,
      from,
      sdp,
    });
  }

  sendAnswer(target: string, from: string, sdp: RTCSessionDescriptionInit): boolean {
    return this.send({
      type: 'answer',
      target,
      from,
      sdp,
    });
  }

  sendIceCandidate(target: string, from: string, candidate: RTCIceCandidateInit): boolean {
    return this.send({
      type: 'ice-candidate',
      target,
      from,
      candidate,
    });
  }

  disconnect(notifyClose: boolean = false): void {
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      this.detachAndCloseSocket(socket);
      if (notifyClose) {
        for (const handler of Array.from(this.closeHandlers)) {
          try {
            handler();
          } catch {
            // Ignore handler errors
          }
        }
      }
    }
    this.connectingPromise = null;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
