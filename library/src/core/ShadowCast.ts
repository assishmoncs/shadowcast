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
  SwarmBitfieldMessage,
  SwarmPieceRequestMessage,
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
import { getAssetId, normalizeAssetUrl, generateUUID } from '../utils/url.js';

export class ShadowCast {
  public readonly peerId: string = generateUUID();
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
  private destroyed = false;
  private connectingPromise: Promise<void> | null = null;

  private assetResolvers: Map<string, PendingAsset> = new Map();
  private inFlightBlobRequests: Map<string, Promise<Blob>> = new Map();
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
      typeof configOrUrl === 'string' ? { signalingUrl: configOrUrl } : configOrUrl || {};

    this.config = {
      signalingUrl: parsedConfig.signalingUrl || DEFAULT_SIGNALING_URL,
      defaultRoom: parsedConfig.defaultRoom || DEFAULT_ROOM,
      iceServers: parsedConfig.iceServers || DEFAULT_ICE_SERVERS,
      chunkSize:
        parsedConfig.chunkSize && parsedConfig.chunkSize > 0
          ? parsedConfig.chunkSize
          : DEFAULT_CHUNK_SIZE,
      p2pTimeout:
        parsedConfig.p2pTimeout && parsedConfig.p2pTimeout > 0 ? parsedConfig.p2pTimeout : 5000,
      peerWaitTimeout:
        parsedConfig.peerWaitTimeout !== undefined && parsedConfig.peerWaitTimeout >= 0
          ? parsedConfig.peerWaitTimeout
          : 1500,
      verifyIntegrity: parsedConfig.verifyIntegrity ?? true,
      cache: parsedConfig.cache,
    };

    this.cacheManager = new CacheManager(this.config.cache);
    this.chunkSender = new ChunkSender(this.config.chunkSize);
    this.piecePicker = new PiecePicker(this.config.p2pTimeout);
    this.signalingClient = new SignalingClient(this.config.signalingUrl);

    this.chunkReceiver = new ChunkReceiver(
      {
        onAssetRequested: (assetId, url, peerId, direct) => {
          void this.handlePeerAssetRequest(assetId, url, peerId, direct);
        },
        onSwarmBitfieldReceived: (bitfield, peerId) => {
          this.handleSwarmBitfield(bitfield, peerId);
        },
        onSwarmPieceRequested: (pieceReq, peerId) => {
          void this.handleSwarmPieceRequest(pieceReq, peerId);
        },
        onAssetComplete: (assetId, blob) => {
          void this.handleAssetReassembled(assetId, blob);
        },
        onChunkReceived: (assetId, chunkIndex) => {
          this.piecePicker.markChunkCompleted(assetId, chunkIndex);
        },
        onChunkProgress: (assetId, received, total) => {
          const url = this.assetUrlsById.get(assetId);
          if (url && total > 0) {
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
          const unassigned = this.piecePicker.unregisterPeer(peerId);
          this.events.emit('peer:leave', { peerId, totalPeers });

          // Reassign any in-flight chunks that belonged to the disconnected peer
          for (const [assetId] of unassigned.entries()) {
            const totalChunks =
              this.piecePicker.getTotalChunks(assetId) ??
              this.chunkReceiver.getExpectedTotalChunks(assetId);
            if (totalChunks && this.assetResolvers.has(assetId)) {
              this.scheduleSwarmPieces(assetId, totalChunks);
            }
          }
        },
        onDataMessage: (data, peerId) => {
          void this.chunkReceiver.handleMessage(data, peerId);
        },
      }
    );

    this.swManager = new ServiceWorkerManager({
      onRequestAssetBlob: async (url: string) => {
        return this.requestAssetBlob(url);
      },
    });

    this.signalingClient.onMessage((msg) => {
      void this.meshManager.handleSignalingMessage(msg);
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
    if (this.destroyed) {
      throw new Error('[ShadowCast] Instance has been destroyed');
    }

    const targetRoom = (roomId || this.config.defaultRoom).trim();
    if (!targetRoom) {
      throw new Error('[ShadowCast] Room ID must be a non-empty string');
    }

    if (this.initialized && this.currentRoom === targetRoom && this.signalingClient.isConnected) {
      return;
    }

    if (this.connectingPromise && this.currentRoom === targetRoom) {
      return this.connectingPromise;
    }

    if (this.signalingClient.isConnected || this.meshManager.openPeersCount > 0) {
      this.cleanupMesh();
    }

    this.currentRoom = targetRoom;
    this.initialized = false;
    this.events.emit('connection:status', { state: 'connecting' });

    this.connectingPromise = this.signalingClient
      .connect(targetRoom, this.peerId)
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

  async requestAsset(rawUrl: string): Promise<string> {
    const url = normalizeAssetUrl(rawUrl);
    if (!url) {
      throw new Error('[ShadowCast] Asset URL must be a non-empty string');
    }

    const assetId = getAssetId(url);
    this.assetUrlsById.set(assetId, url);

    // 1. Cache hit check
    const cachedUrl = await this.cacheManager.getObjectUrl(url);
    if (cachedUrl) {
      this.totalCacheHits++;
      this.events.emit('cache:hit', { url });
      return cachedUrl;
    }

    // 2. Fetch or stream Blob (coalescing concurrent requests for the same URL)
    const blob = await this.resolveAssetBlobInternal(url, assetId);
    return (
      (await this.cacheManager.getObjectUrl(url)) ||
      (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(blob)
        : `blob:shadowcast/${assetId}`)
    );
  }

  async requestAssetBlob(rawUrl: string): Promise<Blob> {
    const url = normalizeAssetUrl(rawUrl);
    if (!url) {
      throw new Error('[ShadowCast] Asset URL must be a non-empty string');
    }

    const assetId = getAssetId(url);
    this.assetUrlsById.set(assetId, url);

    const cached = await this.cacheManager.get(url);
    if (cached) {
      this.totalCacheHits++;
      this.events.emit('cache:hit', { url });
      return cached;
    }

    return this.resolveAssetBlobInternal(url, assetId);
  }

  private resolveAssetBlobInternal(url: string, assetId: string): Promise<Blob> {
    const existing = this.inFlightBlobRequests.get(assetId);
    if (existing) {
      return existing;
    }

    const promise = this.performAssetTransfer(url, assetId).finally(() => {
      this.inFlightBlobRequests.delete(assetId);
    });

    this.inFlightBlobRequests.set(assetId, promise);
    return promise;
  }

  private async performAssetTransfer(url: string, assetId: string): Promise<Blob> {
    const startTime = performance.now();

    // Ensure connected to signaling; if signaling is unreachable, degrade gracefully to HTTP
    let hasPeers = false;
    try {
      await this.connect(this.currentRoom || this.config.defaultRoom);
      hasPeers = await this.waitForPeers({ timeout: this.config.peerWaitTimeout });
    } catch {
      hasPeers = false;
    }

    // Try P2P transfer if peers are available
    if (hasPeers) {
      return new Promise<Blob>((resolve, reject) => {
        this.events.emit('transfer:start', { url, source: 'p2p' });

        const timeoutId = setTimeout(() => {
          if (this.assetResolvers.has(assetId)) {
            this.assetResolvers.delete(assetId);
            this.piecePicker.clearAsset(assetId);
            this.chunkReceiver.clearAsset(assetId);
            this.fallbackToHttpBlob(url, startTime).then(resolve, reject);
          }
        }, this.config.p2pTimeout);

        this.assetResolvers.set(assetId, { url, startTime, timeoutId, resolve, reject });
        this.requestFromPeers(assetId, url);
      });
    }

    // Fallback to HTTP if no peers available
    return this.fallbackToHttpBlob(url, startTime);
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

  private async handlePeerAssetRequest(
    assetId: string,
    rawUrl: string,
    peerId: string,
    direct: boolean = false
  ): Promise<void> {
    const url = normalizeAssetUrl(rawUrl) || rawUrl;
    this.assetUrlsById.set(assetId, url);

    const blob = await this.cacheManager.get(url);
    if (!blob) return;

    if (direct) {
      await this.chunkSender.sendBlob(
        (data) => this.meshManager.sendToPeer(peerId, data),
        assetId,
        blob
      );
      return;
    }

    // Send swarm bitfield so requesting peer's PiecePicker can schedule non-overlapping chunks
    await this.chunkSender.sendBitfield(
      (data) => this.meshManager.sendToPeer(peerId, data),
      assetId,
      url,
      blob
    );
  }

  private handleSwarmBitfield(bitfield: SwarmBitfieldMessage, peerId: string): void {
    if (bitfield.url) {
      this.assetUrlsById.set(bitfield.assetId, normalizeAssetUrl(bitfield.url) || bitfield.url);
    }

    this.piecePicker.registerPeerChunks(
      bitfield.assetId,
      peerId,
      bitfield.availableChunks,
      bitfield.totalChunks
    );

    if (bitfield.totalChunks === 0) {
      const url = this.assetUrlsById.get(bitfield.assetId);
      const pieceReq: SwarmPieceRequestMessage = {
        type: 'swarm-piece-request',
        assetId: bitfield.assetId,
        url,
        indices: [],
      };
      this.meshManager.sendToPeer(peerId, JSON.stringify(pieceReq));
      return;
    }

    this.scheduleSwarmPieces(bitfield.assetId, bitfield.totalChunks);
  }

  private scheduleSwarmPieces(assetId: string, totalChunks: number): void {
    const received = this.chunkReceiver.getReceivedChunkIndices(assetId);
    const openPeers = this.meshManager.getOpenPeerIds();
    const url = this.assetUrlsById.get(assetId);

    const assignments = this.piecePicker.planPieceRequests(
      assetId,
      totalChunks,
      received,
      openPeers
    );

    for (const assignment of assignments) {
      const pieceReq: SwarmPieceRequestMessage = {
        type: 'swarm-piece-request',
        assetId,
        url,
        indices: assignment.indices,
      };
      this.meshManager.sendToPeer(assignment.peerId, JSON.stringify(pieceReq));
    }
  }

  private async handleSwarmPieceRequest(
    pieceReq: SwarmPieceRequestMessage,
    peerId: string
  ): Promise<void> {
    const rawUrl = pieceReq.url || this.assetUrlsById.get(pieceReq.assetId);
    if (!rawUrl) return;

    const url = normalizeAssetUrl(rawUrl) || rawUrl;
    this.assetUrlsById.set(pieceReq.assetId, url);

    const blob = await this.cacheManager.get(url);
    if (blob) {
      await this.chunkSender.sendBlob(
        (data) => this.meshManager.sendToPeer(peerId, data),
        pieceReq.assetId,
        blob,
        pieceReq.indices
      );
    }
  }

  private async handleAssetReassembled(assetId: string, blob: Blob): Promise<void> {
    const pending = this.assetResolvers.get(assetId);
    if (pending?.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    const url = pending?.url ?? this.assetUrlsById.get(assetId);
    const durationMs = pending ? Math.max(0, Math.round(performance.now() - pending.startTime)) : 0;

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
      pending.resolve(blob);
    }
  }

  private async fallbackToHttpBlob(
    url: string,
    startTime: number = performance.now()
  ): Promise<Blob> {
    const assetId = getAssetId(url);
    this.assetUrlsById.set(assetId, url);
    this.events.emit('transfer:start', { url, source: 'http' });

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`[ShadowCast] HTTP fallback failed: ${response.status} ${url}`);
      }
      const blob = await response.blob();
      const durationMs = Math.max(0, Math.round(performance.now() - startTime));

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

      return blob;
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
    this.destroyed = true;
    for (const pending of this.assetResolvers.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject?.(new Error('[ShadowCast] Instance destroyed during transfer'));
    }
    this.assetResolvers.clear();
    this.inFlightBlobRequests.clear();
    this.cleanupMesh();
    this.chunkReceiver.clear();
    void this.cacheManager.clear();
    this.piecePicker.clear();
    this.assetUrlsById.clear();
    this.events.removeAllListeners();
    void this.swManager.unregister();
  }
}
