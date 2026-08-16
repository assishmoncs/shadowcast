/**
 * ShadowCast - Main Orchestrator Facade
 * Decentralized P2P WebRTC Asset Delivery Client
 */

import {
  DEFAULT_ROOM,
  DEFAULT_SIGNALING_URL,
  DEFAULT_ICE_SERVERS,
  DEFAULT_CHUNK_SIZE,
  ShadowCastConfig,
  ShadowCastStats,
  PendingAsset,
} from './types.js';
import { EventEmitter, ShadowCastEventMap, EventListener } from './events.js';
import { SignalingClient } from '../signaling/SignalingClient.js';
import { MeshManager } from '../mesh/MeshManager.js';
import { ChunkSender } from '../transfer/ChunkSender.js';
import { ChunkReceiver } from '../transfer/ChunkReceiver.js';
import { PiecePicker } from '../transfer/PiecePicker.js';
import { CacheManager } from '../cache/CacheManager.js';
import { ServiceWorkerManager } from '../interception/ServiceWorkerManager.js';
import { ServiceWorkerOptions } from '../interception/types.js';
import { getAssetId } from '../utils/url.js';

export class ShadowCast {
  public readonly peerId: string = crypto.randomUUID();
  public readonly events: EventEmitter<ShadowCastEventMap> = new EventEmitter();

  private signalingClient: SignalingClient;
  private meshManager: MeshManager;
  private chunkSender: ChunkSender;
  private chunkReceiver: ChunkReceiver;
  private piecePicker: PiecePicker;
  private cacheManager: CacheManager;
  private swManager: ServiceWorkerManager;

  private currentRoom: string = '';
  private initialized = false;
  private connectingPromise: Promise<void> | null = null;

  private assetResolvers: Map<string, PendingAsset> = new Map();
  private assetUrlsById: Map<string, string> = new Map();
  private config: Required<Omit<ShadowCastConfig, 'cache'>> & { cache?: ShadowCastConfig['cache'] };

  // Telemetry metrics
  private totalSavedBandwidth = 0;
  private totalP2PBytesReceived = 0;
  private totalHttpBytesReceived = 0;
  private totalCacheHits = 0;
  private totalTransfers = 0;

  constructor(configOrUrl: string | ShadowCastConfig = DEFAULT_SIGNALING_URL) {
    const parsedConfig: ShadowCastConfig =
      typeof configOrUrl === 'string' ? { signalingUrl: configOrUrl } : configOrUrl;

    this.config = {
      signalingUrl: parsedConfig.signalingUrl || DEFAULT_SIGNALING_URL,
      defaultRoom: parsedConfig.defaultRoom || DEFAULT_ROOM,
      iceServers: parsedConfig.iceServers || DEFAULT_ICE_SERVERS,
      chunkSize: parsedConfig.chunkSize || DEFAULT_CHUNK_SIZE,
      p2pTimeout: parsedConfig.p2pTimeout || 5000,
      peerWaitTimeout: parsedConfig.peerWaitTimeout || 1500,
      verifyIntegrity: parsedConfig.verifyIntegrity ?? true,
      cache: parsedConfig.cache,
    };

    this.cacheManager = new CacheManager(this.config.cache);
    this.chunkSender = new ChunkSender(this.config.chunkSize);
    this.piecePicker = new PiecePicker();
    this.signalingClient = new SignalingClient(this.config.signalingUrl);

    this.chunkReceiver = new ChunkReceiver(
      {
        onAssetRequested: (assetId, url, peerId) => {
          this.handlePeerAssetRequest(assetId, url, peerId);
        },
        onSwarmBitfieldReceived: (bitfield, peerId) => {
          this.handleSwarmBitfield(bitfield, peerId);
        },
        onSwarmPieceRequested: (pieceReq, peerId) => {
          this.handleSwarmPieceRequest(pieceReq, peerId);
        },
        onAssetComplete: (assetId, blob) => {
          this.handleAssetReassembled(assetId, blob);
        },
        onChunkProgress: (assetId, received, total) => {
          const url = this.assetUrlsById.get(assetId);
          if (url) {
            this.events.emit('transfer:progress', {
              url,
              source: 'p2p',
              bytesReceived: received * this.config.chunkSize,
              totalBytes: total * this.config.chunkSize,
              percent: Math.min(100, Math.round((received / total) * 100)),
            });
          }
        },
        onIntegrityError: (assetId, reason) => {
          console.warn(`[ShadowCast Integrity] ${reason}`);
          const url = this.assetUrlsById.get(assetId);
          if (url) {
            this.events.emit('transfer:error', { url, error: new Error(reason) });
          }
        },
      },
      this.config.verifyIntegrity
    );

    this.meshManager = new MeshManager(
      this.peerId,
      this.signalingClient,
      this.config.iceServers,
      {
        onPeerJoin: (peerId, totalPeers) => {
          this.events.emit('peer:join', { peerId, totalPeers });
        },
        onPeerLeave: (peerId, totalPeers) => {
          this.piecePicker.unregisterPeer(peerId);
          this.events.emit('peer:leave', { peerId, totalPeers });
        },
        onDataMessage: (data, peerId) => {
          this.chunkReceiver.handleMessage(data, peerId);
        },
      }
    );

    this.swManager = new ServiceWorkerManager({
      onRequestAssetBlob: async (url: string) => {
        return this.requestAssetBlob(url);
      },
    });

    this.signalingClient.onMessage((msg) => {
      this.meshManager.handleSignalingMessage(msg);
    });

    this.signalingClient.onClose(() => {
      this.initialized = false;
      this.connectingPromise = null;
      this.events.emit('connection:status', { state: 'disconnected' });
    });
  }

  // ---------- Public API ----------

  on<K extends keyof ShadowCastEventMap>(
    event: K,
    listener: EventListener<ShadowCastEventMap[K]>
  ): () => void {
    return this.events.on(event, listener);
  }

  once<K extends keyof ShadowCastEventMap>(
    event: K,
    listener: EventListener<ShadowCastEventMap[K]>
  ): () => void {
    return this.events.once(event, listener);
  }

  off<K extends keyof ShadowCastEventMap>(
    event: K,
    listener: EventListener<ShadowCastEventMap[K]>
  ): void {
    this.events.off(event, listener);
  }

  async init(roomId: string = this.config.defaultRoom): Promise<void> {
    return this.connect(roomId);
  }

  async connect(roomId: string = this.config.defaultRoom): Promise<void> {
    if (this.initialized && this.currentRoom === roomId && this.signalingClient.isConnected) {
      return;
    }

    if (this.connectingPromise && this.currentRoom === roomId) {
      return this.connectingPromise;
    }

    if (this.signalingClient.isConnected || this.meshManager.openPeersCount > 0) {
      this.cleanupMesh();
    }

    this.currentRoom = roomId;
    this.initialized = false;
    this.events.emit('connection:status', { state: 'connecting' });

    this.connectingPromise = this.signalingClient
      .connect(roomId, this.peerId)
      .then(() => {
        this.initialized = true;
        this.connectingPromise = null;
        this.events.emit('connection:status', { state: 'connected' });
      })
      .catch((err) => {
        this.connectingPromise = null;
        this.events.emit('connection:status', { state: 'disconnected' });
        throw err;
      });

    return this.connectingPromise;
  }

  waitForPeers({ timeout }: { timeout?: number } = {}): Promise<boolean> {
    return this.meshManager.waitForPeers(timeout ?? this.config.peerWaitTimeout);
  }

  async requestAsset(url: string): Promise<string> {
    // 1. Cache hit check
    const cachedUrl = await this.cacheManager.getObjectUrl(url);
    if (cachedUrl) {
      this.totalCacheHits++;
      this.events.emit('cache:hit', { url });
      return cachedUrl;
    }

    // 2. Ensure connected to signaling
    await this.connect(this.currentRoom || this.config.defaultRoom);

    const assetId = getAssetId(url);
    this.assetUrlsById.set(assetId, url);

    const startTime = performance.now();

    // 3. Try P2P transfer if peers are available
    if (await this.waitForPeers({ timeout: this.config.peerWaitTimeout })) {
      return new Promise<string>((resolve) => {
        this.events.emit('transfer:start', { url, source: 'p2p' });

        this.assetResolvers.set(assetId, { url, startTime, resolve });
        this.requestFromPeers(assetId, url);

        setTimeout(() => {
          if (this.assetResolvers.has(assetId)) {
            this.assetResolvers.delete(assetId);
            this.piecePicker.clearAsset(assetId);
            this.fallbackToHttp(url, startTime).then(resolve);
          }
        }, this.config.p2pTimeout);
      });
    }

    // 4. Fallback to HTTP if no peers available
    return this.fallbackToHttp(url, startTime);
  }

  async requestAssetBlob(url: string): Promise<Blob> {
    const cached = await this.cacheManager.get(url);
    if (cached) {
      this.totalCacheHits++;
      this.events.emit('cache:hit', { url });
      return cached;
    }

    await this.requestAsset(url);
    const blob = await this.cacheManager.get(url);
    if (!blob) {
      throw new Error(`[ShadowCast] Asset could not be retrieved as Blob: ${url}`);
    }
    return blob;
  }

  async clearCache(): Promise<void> {
    await this.cacheManager.clear();
  }

  async registerServiceWorker(
    scriptUrl: string = '/sw.js',
    options?: ServiceWorkerOptions
  ): Promise<ServiceWorkerRegistration | null> {
    return this.swManager.register(scriptUrl, options);
  }

  async unregisterServiceWorker(): Promise<boolean> {
    return this.swManager.unregister();
  }

  private requestFromPeers(assetId: string, url: string): void {
    const req = JSON.stringify({ type: 'asset-request', assetId, url });
    this.meshManager.broadcast(req);
  }

  private async handlePeerAssetRequest(assetId: string, url: string, peerId: string): Promise<void> {
    const blob = await this.cacheManager.get(url);
    if (blob) {
      // Send bitfield to peer so they can schedule multi-peer swarm pieces
      this.chunkSender.sendBitfield(
        (data) => this.meshManager.sendToPeer(peerId, data),
        assetId,
        url,
        blob
      );

      // Also stream default chunks if peer didn't use parallel piece picker
      this.chunkSender.sendBlob(
        (data) => this.meshManager.sendToPeer(peerId, data),
        assetId,
        blob
      );
    }
  }

  private handleSwarmBitfield(
    bitfield: { assetId: string; url: string; totalChunks: number; availableChunks: number[] },
    peerId: string
  ): void {
    this.piecePicker.registerPeerChunks(bitfield.assetId, peerId, bitfield.availableChunks);

    const received = this.chunkReceiver.getReceivedChunkIndices(bitfield.assetId);
    const openPeers = this.meshManager.getOpenPeerIds();

    // Plan swarm piece downloads
    const assignments = this.piecePicker.planPieceRequests(
      bitfield.assetId,
      bitfield.totalChunks,
      received,
      openPeers
    );

    for (const assignment of assignments) {
      const pieceReq = JSON.stringify({
        type: 'swarm-piece-request',
        assetId: bitfield.assetId,
        indices: assignment.indices,
      });
      this.meshManager.sendToPeer(assignment.peerId, pieceReq);
    }
  }

  private async handleSwarmPieceRequest(
    pieceReq: { assetId: string; indices: number[] },
    peerId: string
  ): Promise<void> {
    const url = this.assetUrlsById.get(pieceReq.assetId);
    if (!url) return;

    const blob = await this.cacheManager.get(url);
    if (blob) {
      this.chunkSender.sendBlob(
        (data) => this.meshManager.sendToPeer(peerId, data),
        pieceReq.assetId,
        blob,
        pieceReq.indices
      );
    }
  }

  private async handleAssetReassembled(assetId: string, blob: Blob): Promise<void> {
    const pending = this.assetResolvers.get(assetId);
    const url = pending?.url ?? this.assetUrlsById.get(assetId);
    const durationMs = pending ? Math.round(performance.now() - pending.startTime) : 0;

    if (url) {
      await this.cacheManager.set(url, blob);
      this.totalSavedBandwidth += blob.size;
      this.totalP2PBytesReceived += blob.size;
      this.totalTransfers++;

      this.events.emit('cache:store', { url, bytes: blob.size });
      this.events.emit('bandwidth:saved', {
        bytes: blob.size,
        cumulativeBytes: this.totalSavedBandwidth,
      });
      this.events.emit('transfer:complete', {
        url,
        source: 'p2p',
        durationMs,
        bytes: blob.size,
      });
    }

    this.piecePicker.clearAsset(assetId);

    if (pending) {
      this.assetResolvers.delete(assetId);
      const objectUrl = (await this.cacheManager.getObjectUrl(pending.url)) || URL.createObjectURL(blob);
      pending.resolve(objectUrl);
    }
  }

  private async fallbackToHttp(url: string, startTime: number = performance.now()): Promise<string> {
    this.events.emit('transfer:start', { url, source: 'http' });

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`[ShadowCast] HTTP fallback failed: ${response.status} ${url}`);
      }
      const blob = await response.blob();
      const durationMs = Math.round(performance.now() - startTime);

      await this.cacheManager.set(url, blob);
      this.totalHttpBytesReceived += blob.size;
      this.totalTransfers++;

      this.events.emit('cache:store', { url, bytes: blob.size });
      this.events.emit('transfer:complete', {
        url,
        source: 'http',
        durationMs,
        bytes: blob.size,
      });

      return (await this.cacheManager.getObjectUrl(url)) || URL.createObjectURL(blob);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.events.emit('transfer:error', { url, error });
      throw error;
    }
  }

  private cleanupMesh(): void {
    this.signalingClient.disconnect();
    this.meshManager.cleanup();
    this.piecePicker.clear();
    this.initialized = false;
  }

  get isConnected(): boolean {
    return this.signalingClient.isConnected;
  }

  get peersCount(): number {
    return this.meshManager.openPeersCount;
  }

  get cumulativeBandwidthSaved(): number {
    return this.totalSavedBandwidth;
  }

  get stats(): ShadowCastStats {
    return {
      peersCount: this.peersCount,
      isConnected: this.isConnected,
      cumulativeBandwidthSaved: this.totalSavedBandwidth,
      totalP2PBytes: this.totalP2PBytesReceived,
      totalHttpBytes: this.totalHttpBytesReceived,
      cacheHits: this.totalCacheHits,
      transfersCount: this.totalTransfers,
    };
  }

  destroy(): void {
    this.cleanupMesh();
    this.chunkReceiver.clear();
    this.cacheManager.clear();
    this.piecePicker.clear();
    this.assetResolvers.clear();
    this.assetUrlsById.clear();
    this.events.removeAllListeners();
    this.swManager.unregister();
  }
}
