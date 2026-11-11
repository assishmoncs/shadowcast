import { SignalingMessagePayload } from '../core/types.js';

export type SignalingMessageHandler = (msg: SignalingMessagePayload) => void;

interface Connection {
  socket: WebSocket;
  room: string;
  peerId: string;
  ready: boolean;
  joined: Promise<void>;
  finish: (error?: Error) => void;
}

export class SignalingClient {
  private connection: Connection | null = null;
  private messageHandlers = new Set<SignalingMessageHandler>();
  private closeHandlers = new Set<() => void>();

  constructor(
    public readonly url: string,
    private readonly connectTimeoutMs: number = 10000
  ) {}

  async connect(room: string, peerId: string): Promise<void> {
    if (!room || !peerId) {
      throw new Error('[SignalingClient] Room and peer IDs are required');
    }

    const current = this.connection;
    if (current?.room === room && current.peerId === peerId) {
      return current.joined;
    }

    const reuseSocket = this.isConnected && current?.peerId === peerId;
    if (!reuseSocket) this.disconnect();
    const socket = reuseSocket ? current.socket : new WebSocket(this.url);
    let finish!: Connection['finish'];
    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close(new Error(`[SignalingClient] Room join timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      finish = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
    });
    const connection: Connection = { socket, room, peerId, ready: false, joined, finish };
    this.connection = connection;

    const sendJoin = () => {
      if (this.connection !== connection) return;
      try {
        socket.send(JSON.stringify({ type: 'join', room, from: peerId }));
      } catch (cause) {
        this.close(new Error('[SignalingClient] Failed to send room join', { cause }));
      }
    };
    socket.onopen = sendJoin;
    socket.onmessage = ({ data }) => {
      if (this.connection !== connection || typeof data !== 'string') return;
      let msg: SignalingMessagePayload;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (!connection.ready) {
        if (msg.type === 'error') {
          this.close(new Error(msg.error || '[SignalingClient] Room join failed'));
          return;
        }
        if (msg.type !== 'room-peers' || !Array.isArray(msg.peers)) return;
        if (msg.room !== undefined && msg.room !== room) return;
        if (msg.id !== undefined && msg.id !== peerId) {
          this.close(new Error('[SignalingClient] Room acknowledgment did not match the request'));
          return;
        }
        connection.ready = true;
        connection.finish();
      }
      // The initial server-generated ID predates room admission.
      if (msg.type === 'self-id') return;
      for (const handler of Array.from(this.messageHandlers)) {
        try {
          handler(msg);
        } catch (err) {
          console.error('[SignalingClient] Error in message handler:', err);
        }
      }
    };
    socket.onerror = () => {
      if (this.connection === connection) this.close(new Error('[SignalingClient] WebSocket error'), true);
    };
    socket.onclose = () => {
      if (this.connection === connection) this.close(new Error('[SignalingClient] WebSocket closed'), true);
    };
    if (reuseSocket) sendJoin();
    return joined;
  }

  private close(error: Error, notify = false): void {
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    const { socket } = connection;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    connection.finish(error);
    try {
      socket.close();
    } catch {
      // The transport may already be closed.
    }

    if (notify && connection.ready) {
      for (const handler of Array.from(this.closeHandlers)) {
        try {
          handler();
        } catch (err) {
          console.error('[SignalingClient] Error in close handler:', err);
        }
      }
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
    if (!this.connection || !this.isConnected) return false;
    try {
      this.connection.socket.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.warn('[SignalingClient] Failed to send message:', err);
      return false;
    }
  }

  sendOffer(target: string, from: string, sdp: RTCSessionDescriptionInit): boolean {
    return this.send({ type: 'offer', target, from, sdp });
  }

  sendAnswer(target: string, from: string, sdp: RTCSessionDescriptionInit): boolean {
    return this.send({ type: 'answer', target, from, sdp });
  }

  sendIceCandidate(target: string, from: string, candidate: RTCIceCandidateInit): boolean {
    return this.send({ type: 'ice-candidate', target, from, candidate });
  }

  disconnect(notifyClose: boolean = false): void {
    this.close(new Error('[SignalingClient] Connection canceled'), notifyClose);
  }

  get isConnected(): boolean {
    const connection = this.connection;
    return connection !== null && connection.ready && connection.socket.readyState === WebSocket.OPEN;
  }
}
