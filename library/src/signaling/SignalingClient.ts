/**
 * ShadowCast - Signaling Client
 */

import { SignalingMessagePayload } from '../core/types';

export type SignalingMessageHandler = (msg: SignalingMessagePayload) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private connectingPromise: Promise<void> | null = null;
  private messageHandlers: Set<SignalingMessageHandler> = new Set();
  private closeHandlers: Set<() => void> = new Set();

  constructor(public readonly url: string) {}

  async connect(room: string, peerId: string): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.disconnect();

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.ws = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'join', room, from: peerId }));
        this.connectingPromise = null;
        resolve();
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as SignalingMessagePayload;
          for (const handler of this.messageHandlers) {
            handler(msg);
          }
        } catch (err) {
          console.error('[SignalingClient] Failed to parse message:', err);
        }
      };

      socket.onerror = (err) => {
        this.connectingPromise = null;
        reject(err);
      };

      socket.onclose = () => {
        this.connectingPromise = null;
        for (const handler of this.closeHandlers) {
          handler();
        }
      };
    });

    return this.connectingPromise;
  }

  onMessage(handler: SignalingMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  send(msg: SignalingMessagePayload): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendOffer(target: string, from: string, sdp: RTCSessionDescriptionInit): void {
    this.send({
      type: 'offer',
      target,
      from,
      sdp,
    });
  }

  sendAnswer(target: string, from: string, sdp: RTCSessionDescriptionInit): void {
    this.send({
      type: 'answer',
      target,
      from,
      sdp,
    });
  }

  sendIceCandidate(target: string, from: string, candidate: RTCIceCandidateInit): void {
    this.send({
      type: 'ice-candidate',
      target,
      from,
      candidate,
    });
  }

  disconnect(): void {
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.close();
    }
    this.connectingPromise = null;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
