/**
 * ShadowCast - Mesh Manager
 */

import { PeerConnection } from './PeerConnection.js';
import { SignalingClient } from '../signaling/SignalingClient.js';
import { DEFAULT_ICE_SERVERS, SignalingMessagePayload } from '../core/types.js';

export interface MeshManagerCallbacks {
  onPeerJoin?: (peerId: string, totalPeers: number) => void;
  onPeerLeave?: (peerId: string, totalPeers: number) => void;
  onDataMessage: (data: ArrayBuffer | string, peerId: string) => void;
}

export class MeshManager {
  private peers: Map<string, PeerConnection> = new Map();
  private activeOpenPeers: Set<string> = new Set();
  private peerWaiters: Set<(ready: boolean) => void> = new Set();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();

  constructor(
    public localPeerId: string,
    private signalingClient: SignalingClient,
    private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS,
    private callbacks: MeshManagerCallbacks
  ) {}

  shouldInitiate(remotePeerId: string): boolean {
    return this.localPeerId < remotePeerId;
  }

  async handleSignalingMessage(msg: SignalingMessagePayload): Promise<void> {
    if (!msg || typeof msg.type !== 'string') return;

    try {
      switch (msg.type) {
        case 'self-id': {
          // If server confirmed or assigned our canonical peer ID, synchronize if no peers exist yet
          if (typeof msg.id === 'string' && msg.id && this.peers.size === 0) {
            this.localPeerId = msg.id;
          }
          break;
        }

        case 'room-peers': {
          const peers = Array.isArray(msg.peers) ? msg.peers : [];
          await Promise.allSettled(peers.map((peerId) => this.maybeInitiateOffer(peerId)));
          break;
        }

        case 'peer-joined': {
          const peerId = msg.id as string;
          if (peerId) {
            await this.maybeInitiateOffer(peerId);
          }
          break;
        }

        case 'peer-left': {
          const peerId = msg.id as string;
          if (peerId) {
            this.disconnectPeer(peerId);
          }
          break;
        }

        case 'offer': {
          await this.handleOffer(msg);
          break;
        }

        case 'answer': {
          await this.handleAnswer(msg);
          break;
        }

        case 'ice-candidate': {
          await this.handleIceCandidate(msg);
          break;
        }
      }
    } catch (err) {
      console.warn(`[ShadowCast MeshManager] Error handling signaling message "${msg.type}":`, err);
    }
  }

  async maybeInitiateOffer(peerId: string): Promise<void> {
    if (typeof peerId !== 'string' || !peerId || peerId === this.localPeerId ||
        !this.shouldInitiate(peerId) || this.peers.has(peerId)) {
      return;
    }
    await this.initiateOffer(peerId);
  }

  getOrCreatePeer(peerId: string): PeerConnection {
    let peer = this.peers.get(peerId);
    if (peer && peer.pc.signalingState !== 'closed') {
      return peer;
    }

    peer = new PeerConnection(peerId, this.iceServers, {
      onIceCandidate: (candidate) => {
        this.signalingClient.sendIceCandidate(peerId, this.localPeerId, candidate);
      },
      onDataChannelMessage: (data) => {
        this.callbacks.onDataMessage(data, peerId);
      },
      onDataChannelOpen: () => {
        const wasOpen = this.activeOpenPeers.has(peerId);
        this.activeOpenPeers.add(peerId);
        this.notifyPeerWaiters(true);
        if (!wasOpen) {
          this.callbacks.onPeerJoin?.(peerId, this.openPeersCount);
        }
      },
      onDataChannelClose: () => {
        this.disconnectPeer(peerId);
      },
      onDisconnect: () => {
        this.disconnectPeer(peerId);
      },
    });

    this.peers.set(peerId, peer);
    const candidates = this.pendingIce.get(peerId);
    this.pendingIce.delete(peerId);
    if (candidates) {
      for (const candidate of candidates) void peer.addIceCandidate(candidate);
    }
    return peer;
  }

  async initiateOffer(peerId: string): Promise<void> {
    const peer = this.getOrCreatePeer(peerId);
    try {
      peer.createDataChannel('asset-transfer');
      const sdp = await peer.createOffer();
      if (this.peers.get(peerId) === peer && !this.signalingClient.sendOffer(peerId, this.localPeerId, sdp)) {
        this.disconnectPeer(peerId);
      }
    } catch (err) {
      if (this.peers.get(peerId) === peer) this.disconnectPeer(peerId);
      throw err;
    }
  }

  async handleOffer(msg: SignalingMessagePayload): Promise<void> {
    const fromId = msg.from as string;
    if (typeof fromId !== 'string' || !fromId || fromId === this.localPeerId || !msg.sdp) return;

    const existing = this.peers.get(fromId);
    if (existing?.pc.remoteDescription && existing.pc.signalingState === 'stable') {
      return;
    }

    if (existing && existing.pc.signalingState !== 'stable' && this.shouldInitiate(fromId)) {
      return;
    }

    const peer = this.getOrCreatePeer(fromId);
    try {
      const answerSdp = await peer.handleOffer(msg.sdp as RTCSessionDescriptionInit);
      if (this.peers.get(fromId) === peer && !this.signalingClient.sendAnswer(fromId, this.localPeerId, answerSdp)) {
        this.disconnectPeer(fromId);
      }
    } catch (err) {
      if (this.peers.get(fromId) === peer) this.disconnectPeer(fromId);
      throw err;
    }
  }

  async handleAnswer(msg: SignalingMessagePayload): Promise<void> {
    const fromId = msg.from as string;
    if (!fromId || !msg.sdp) return;
    const peer = this.peers.get(fromId);
    if (!peer || peer.pc.signalingState === 'stable') return;
    try {
      await peer.handleAnswer(msg.sdp);
    } catch (err) {
      if (this.peers.get(fromId) === peer) this.disconnectPeer(fromId);
      throw err;
    }
  }

  async handleIceCandidate(msg: SignalingMessagePayload): Promise<void> {
    const fromId = msg.from as string;
    if (typeof fromId !== 'string' || !fromId || fromId === this.localPeerId || !msg.candidate) return;
    const peer = this.peers.get(fromId);
    if (!peer) {
      const candidates = this.pendingIce.get(fromId) ?? [];
      if (candidates.length < 128 && (candidates.length > 0 || this.pendingIce.size < 128)) {
        candidates.push(msg.candidate);
        this.pendingIce.set(fromId, candidates);
      }
      return;
    }
    await peer.addIceCandidate(msg.candidate as RTCIceCandidateInit);
  }

  disconnectPeer(peerId: string): void {
    this.pendingIce.delete(peerId);
    const peer = this.peers.get(peerId);
    const wasActive = this.activeOpenPeers.delete(peerId);
    if (peer) {
      this.peers.delete(peerId);
      peer.close();
    }
    if (wasActive) {
      this.callbacks.onPeerLeave?.(peerId, this.openPeersCount);
    }
  }

  broadcast(message: string | ArrayBuffer): number {
    let sentCount = 0;
    for (const peer of this.peers.values()) {
      if (peer.send(message)) {
        sentCount++;
      }
    }
    return sentCount;
  }

  sendToPeer(peerId: string, message: string | ArrayBuffer): boolean {
    const peer = this.peers.get(peerId);
    return peer ? peer.send(message) : false;
  }

  waitForWritablePeer(peerId: string, bytes: number): Promise<boolean> {
    return this.peers.get(peerId)?.waitForWritable(bytes) ?? Promise.resolve(false);
  }

  hasOpenDataChannel(): boolean {
    for (const peer of this.peers.values()) {
      if (peer.isDataChannelOpen) return true;
    }
    return false;
  }

  getOpenPeerIds(): string[] {
    const list: string[] = [];
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.isDataChannelOpen) {
        list.push(peerId);
      }
    }
    return list;
  }

  get openPeersCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.isDataChannelOpen) count++;
    }
    return count;
  }

  waitForPeers(timeoutMs: number = 5000): Promise<boolean> {
    if (this.hasOpenDataChannel()) {
      return Promise.resolve(true);
    }

    if (timeoutMs <= 0) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const done = (ready: boolean) => {
        clearTimeout(timer);
        this.peerWaiters.delete(done);
        resolve(ready);
      };

      const timer = setTimeout(() => done(false), timeoutMs);
      this.peerWaiters.add(done);
    });
  }

  private notifyPeerWaiters(ready: boolean): void {
    if (ready && !this.hasOpenDataChannel()) return;
    for (const waiter of Array.from(this.peerWaiters)) {
      waiter(ready);
    }
    this.peerWaiters.clear();
  }

  cleanup(): void {
    const peers = Array.from(this.peers.values());
    const opened = Array.from(this.activeOpenPeers);
    this.peers.clear();
    this.activeOpenPeers.clear();
    this.pendingIce.clear();
    this.notifyPeerWaiters(false);
    for (const peer of peers) peer.close();
    for (const id of opened) this.callbacks.onPeerLeave?.(id, this.openPeersCount);
  }
}
