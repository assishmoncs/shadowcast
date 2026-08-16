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
  private peerWaiters: Set<() => void> = new Set();

  constructor(
    public readonly localPeerId: string,
    private signalingClient: SignalingClient,
    private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS,
    private callbacks: MeshManagerCallbacks
  ) {}

  shouldInitiate(remotePeerId: string): boolean {
    return this.localPeerId < remotePeerId;
  }

  async handleSignalingMessage(msg: SignalingMessagePayload): Promise<void> {
    switch (msg.type) {
      case 'room-peers': {
        const peers = (msg.peers as string[]) || [];
        for (const peerId of peers) {
          await this.maybeInitiateOffer(peerId);
        }
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
  }

  async maybeInitiateOffer(peerId: string): Promise<void> {
    if (!peerId || peerId === this.localPeerId || !this.shouldInitiate(peerId) || this.peers.has(peerId)) {
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
        this.notifyPeerWaiters();
        this.callbacks.onPeerJoin?.(peerId, this.openPeersCount);
      },
      onDataChannelClose: () => {
        // Will be cleaned up if disconnect triggers
      },
      onDisconnect: () => {
        this.disconnectPeer(peerId);
      },
    });

    this.peers.set(peerId, peer);
    return peer;
  }

  async initiateOffer(peerId: string): Promise<void> {
    const peer = this.getOrCreatePeer(peerId);
    peer.createDataChannel('asset-transfer');

    const sdp = await peer.createOffer();
    this.signalingClient.sendOffer(peerId, this.localPeerId, sdp);
  }

  async handleOffer(msg: SignalingMessagePayload): Promise<void> {
    const fromId = msg.from as string;
    if (!fromId || fromId === this.localPeerId) return;

    const existing = this.peers.get(fromId);
    if (existing?.pc.remoteDescription && existing.pc.signalingState === 'stable') {
      return;
    }

    if (existing && existing.pc.signalingState !== 'stable' && this.shouldInitiate(fromId)) {
      return;
    }

    const peer = this.getOrCreatePeer(fromId);
    const answerSdp = await peer.handleOffer(msg.sdp as RTCSessionDescriptionInit);
    this.signalingClient.sendAnswer(fromId, this.localPeerId, answerSdp);
  }

  async handleAnswer(msg: SignalingMessagePayload): Promise<void> {
    const fromId = msg.from as string;
    const peer = this.peers.get(fromId);
    if (!peer || peer.pc.signalingState === 'stable') return;
    await peer.handleAnswer(msg.sdp as RTCSessionDescriptionInit);
  }

  async handleIceCandidate(msg: SignalingMessagePayload): Promise<void> {
    const fromId = msg.from as string;
    const peer = this.peers.get(fromId);
    if (!peer || !msg.candidate) return;
    await peer.addIceCandidate(msg.candidate as RTCIceCandidateInit);
  }

  disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.close();
      this.peers.delete(peerId);
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

    return new Promise((resolve) => {
      const done = (ready: boolean) => {
        clearTimeout(timer);
        this.peerWaiters.delete(onPeerReady);
        resolve(ready);
      };

      const onPeerReady = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.peerWaiters.add(onPeerReady);
    });
  }

  private notifyPeerWaiters(): void {
    if (!this.hasOpenDataChannel()) return;
    for (const waiter of this.peerWaiters) {
      waiter();
    }
    this.peerWaiters.clear();
  }

  cleanup(): void {
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.peerWaiters.clear();
  }
}
