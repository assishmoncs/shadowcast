import {
  DEFAULT_ROOM,
  DEFAULT_SIGNALING_URL,
  DEFAULT_ICE_SERVERS,
  DEFAULT_CHUNK_SIZE,
  ShadowCastConfig,
  ShadowCastStats,
  AssetIntegrity,
  SwarmBitfieldMessage,
  SwarmPieceRequestMessage,
  MAX_SWARM_CHUNKS,
  MAX_SWARM_ASSET_BYTES,
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
import { hashBlob } from '../utils/hash.js';

interface SwarmTransfer {
  url: string;
  promise: Promise<Blob | undefined>;
  finish: (blob?: Blob) => void;
  total?: number;
  hash?: string;
  size?: number;
  chunkSize?: number;
  peers: Set<string>;
  finished: boolean;
  collectTimer?: ReturnType<typeof setTimeout>;
}

function assetUrl(rawUrl: string): string {
  const normalized = normalizeAssetUrl(rawUrl);
  if (!normalized) throw new Error('[ShadowCast] Asset URL is required');
  const url = new URL(normalized, typeof document !== 'undefined' ? document.baseURI : undefined);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('[ShadowCast] Asset URLs must use HTTP(S) without embedded credentials');
  }
  return url.href;
}

function duration(value: number | undefined, fallback: number, minimum = 1): number {
  return Number.isFinite(value) && value! >= minimum ? Math.min(value!, 2_147_483_647) : fallback;
}

function originExpiry(headers: Headers): number | undefined {
  const directives = headers.get('Cache-Control') ?? '';
  if (/(?:^|,)\s*(?:no-store|no-cache|private)\b/i.test(directives)) return 0;
  const vary = headers.get('Vary');
  if (vary && vary.trim().toLowerCase() !== 'accept-encoding') return 0;
  const maxAge = directives.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?=\s*(?:,|$))/i);
  const now = Date.now();
  if (maxAge) {
    const age = Number(headers.get('Age')) * 1000;
    const date = Date.parse(headers.get('Date') ?? '');
    const apparentAge = Number.isFinite(date) ? now - date : 0;
    return now + Number(maxAge[1]) * 1000 - Math.max(Number.isFinite(age) ? age : 0, apparentAge, 0);
  }
  const expires = Date.parse(headers.get('Expires') ?? '');
  return Number.isFinite(expires) ? expires : undefined;
}

export class ShadowCast {
  public readonly peerId: string = generateUUID();
  public readonly events = new EventEmitter<ShadowCastEventMap>();

  private readonly signalingClient: SignalingClient;
  private readonly meshManager: MeshManager;
  private readonly chunkSender: ChunkSender;
  private readonly chunkReceiver: ChunkReceiver;
  private readonly piecePicker: PiecePicker;
  private readonly cacheManager: CacheManager;
  private readonly swManager: ServiceWorkerManager;
  private readonly lifetime = new AbortController();
  private readonly integrity = new Map<string, AssetIntegrity>();

  private currentRoom = '';
  private connectingPromise: Promise<void> | null = null;
  private readonly swarmTransfers = new Map<string, SwarmTransfer>();
  private readonly requests = new Map<string, Promise<Blob>>();
  private readonly uploads = new Map<string, number>();
  private readonly objectUrls = new Set<string>();
  private readonly config: Required<Omit<ShadowCastConfig, 'cache' | 'assetIntegrity'>>;

  private totalSavedBandwidth = 0;
  private totalHttpBytesReceived = 0;
  private totalCacheHits = 0;
  private totalTransfers = 0;

  constructor(configOrUrl: string | ShadowCastConfig = DEFAULT_SIGNALING_URL) {
    const config = typeof configOrUrl === 'string' ? { signalingUrl: configOrUrl } : configOrUrl;
    this.config = {
      signalingUrl: config.signalingUrl || DEFAULT_SIGNALING_URL,
      defaultRoom: config.defaultRoom || DEFAULT_ROOM,
      iceServers: config.iceServers ?? DEFAULT_ICE_SERVERS,
      chunkSize: config.chunkSize ?? DEFAULT_CHUNK_SIZE,
      p2pTimeout: duration(config.p2pTimeout, 5000),
      peerWaitTimeout: duration(config.peerWaitTimeout, 1500, 0),
      httpTimeout: duration(config.httpTimeout, 30_000),
      verifyIntegrity: config.verifyIntegrity ?? true,
      allowUnverifiedPeers: config.allowUnverifiedPeers ?? false,
    };
    for (const [url, metadata] of Object.entries(config.assetIntegrity ?? {})) {
      if (!/^[a-f0-9]{64}$/i.test(metadata.sha256) || !/^[\w.+-]+\/[\w.+-]+$/.test(metadata.mimeType)) {
        throw new Error('[ShadowCast] Asset integrity entries require a SHA-256 hex digest and MIME type');
      }
      this.integrity.set(assetUrl(url), { sha256: metadata.sha256.toLowerCase(), mimeType: metadata.mimeType });
    }

    // Keep anonymous, verified content separate from legacy and demo caches.
    const cacheName = this.config.allowUnverifiedPeers ? 'shadowcast_demo_assets' : 'shadowcast_public_assets';
    this.cacheManager = new CacheManager(config.cache, cacheName);
    this.chunkSender = new ChunkSender(this.config.chunkSize);
    this.piecePicker = new PiecePicker(this.config.p2pTimeout);
    this.signalingClient = new SignalingClient(this.config.signalingUrl);
    this.chunkReceiver = new ChunkReceiver({
      onAssetRequested: (assetId, url, peerId, direct) => {
        this.servePeer(assetId, url, peerId, direct ? [] : undefined, Boolean(direct));
      },
      onSwarmBitfieldReceived: (bitfield, peerId) => this.handleSwarmBitfield(bitfield, peerId),
      onSwarmPieceRequested: ({ assetId, url, indices }, peerId) => {
        if (url) this.servePeer(assetId, url, peerId, indices);
      },
      acceptChunk: (assetId, peerId, total, hash) => {
        const transfer = this.swarmTransfers.get(assetId);
        return Boolean(transfer?.peers.has(peerId) && transfer.total === total && transfer.hash === hash);
      },
      onAssetComplete: (assetId, blob) => this.swarmTransfers.get(assetId)?.finish(blob),
      onChunkReceived: (assetId, index) => this.piecePicker.markChunkCompleted(assetId, index),
      onChunkProgress: (assetId, received, total, bytesReceived) => {
        const transfer = this.swarmTransfers.get(assetId);
        if (transfer && total > 0) {
          this.events.emit('transfer:progress', {
            url: transfer.url,
            source: 'p2p',
            bytesReceived,
            totalBytes: transfer.size ?? Math.ceil(bytesReceived * total / received),
            percent: Math.round(received / total * 100),
          });
        }
      },
      onIntegrityError: (assetId, reason) => {
        const transfer = this.swarmTransfers.get(assetId);
        if (transfer) {
          this.events.emit('transfer:error', { url: transfer.url, error: new Error(reason) });
          transfer.finish();
        }
      },
    }, this.config.verifyIntegrity);

    this.meshManager = new MeshManager(this.peerId, this.signalingClient, this.config.iceServers, {
      onPeerJoin: (peerId, totalPeers) => this.events.emit('peer:join', { peerId, totalPeers }),
      onPeerLeave: (peerId, totalPeers) => {
        this.chunkReceiver.clearPeer(peerId);
        for (const transfer of this.swarmTransfers.values()) transfer.peers.delete(peerId);
        for (const [assetId] of this.piecePicker.unregisterPeer(peerId)) this.scheduleSwarmPieces(assetId);
        if (totalPeers === 0) this.finishSwarmTransfers();
        this.events.emit('peer:leave', { peerId, totalPeers });
      },
      onDataMessage: (data, peerId) => {
        void this.chunkReceiver.handleMessage(data, peerId).catch((error) => {
          console.warn('[ShadowCast] Failed to process peer message:', error);
        });
      },
    });

    this.swManager = new ServiceWorkerManager({
      onRequestAssetBlob: (url) => this.requestInterceptedAsset(url),
      assetUrls: Array.from(this.integrity.keys()),
    });

    this.signalingClient.onMessage((msg) => { void this.meshManager.handleSignalingMessage(msg); });
    this.signalingClient.onClose(() => {
      this.resetMesh();
      this.events.emit('connection:status', { state: 'disconnected' });
    });
  }

  on<K extends keyof ShadowCastEventMap>(event: K, listener: EventListener<ShadowCastEventMap[K]>): () => void {
    return this.events.on(event, listener);
  }

  once<K extends keyof ShadowCastEventMap>(event: K, listener: EventListener<ShadowCastEventMap[K]>): () => void {
    return this.events.once(event, listener);
  }

  off<K extends keyof ShadowCastEventMap>(event: K, listener: EventListener<ShadowCastEventMap[K]>): void {
    this.events.off(event, listener);
  }

  async init(roomId: string = this.config.defaultRoom): Promise<void> {
    return this.connect(roomId);
  }

  async connect(roomId: string = this.config.defaultRoom): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const targetRoom = (roomId || this.config.defaultRoom).trim();
    if (!targetRoom) throw new Error('[ShadowCast] Room ID is required');
    if (this.currentRoom === targetRoom) {
      if (this.connectingPromise) return this.connectingPromise;
      if (this.isConnected) return;
    }

    this.currentRoom = targetRoom;
    const connection = this.signalingClient.connect(targetRoom, this.peerId);
    this.connectingPromise = connection;
    this.resetMesh();
    this.events.emit('connection:status', { state: 'connecting' });
    try {
      await connection;
      if (this.connectingPromise === connection && this.isConnected) {
        this.events.emit('connection:status', { state: 'connected' });
      }
    } catch (error) {
      if (this.connectingPromise === connection) {
        this.events.emit('connection:status', { state: 'disconnected' });
      }
      throw error;
    } finally {
      if (this.connectingPromise === connection) this.connectingPromise = null;
    }
  }

  waitForPeers({ timeout }: { timeout?: number } = {}): Promise<boolean> {
    return this.meshManager.waitForPeers(duration(timeout, this.config.peerWaitTimeout, 0));
  }

  async requestAsset(rawUrl: string): Promise<string> {
    const blob = await this.requestAssetBlob(rawUrl);
    this.lifetime.signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    this.objectUrls.add(url);
    return url;
  }

  releaseAsset(objectUrl: string): void {
    if (this.objectUrls.delete(objectUrl)) URL.revokeObjectURL(objectUrl);
  }

  async requestAssetBlob(rawUrl: string): Promise<Blob> {
    this.lifetime.signal.throwIfAborted();
    const url = assetUrl(rawUrl);
    const existing = this.requests.get(url);
    if (existing) return existing;

    const request = this.performAssetTransfer(url).finally(() => this.requests.delete(url));
    this.requests.set(url, request);
    return request;
  }

  private async readCached(url: string): Promise<Blob | undefined> {
    const cached = await this.cacheManager.get(this.cacheKey(url));
    this.lifetime.signal.throwIfAborted();
    if (cached) {
      this.totalCacheHits++;
      this.events.emit('cache:hit', { url });
    }
    return cached;
  }

  private cacheKey(url: string): string {
    const integrity = this.integrity.get(url);
    return integrity ? `shadowcast:${integrity.sha256}/${encodeURIComponent(integrity.mimeType)}/${encodeURIComponent(url)}` : url;
  }

  private async performAssetTransfer(url: string): Promise<Blob> {
    const start = performance.now();
    try {
      const cached = await this.readCached(url);
      if (cached) return cached;
      const peerBlob = await this.requestFromSwarm(url);
      if (peerBlob) return peerBlob;
      this.lifetime.signal.throwIfAborted();

      this.events.emit('transfer:start', { url, source: 'http' });
      const controller = new AbortController();
      const onDestroy = () => controller.abort(this.lifetime.signal.reason);
      this.lifetime.signal.addEventListener('abort', onDestroy, { once: true });
      if (this.lifetime.signal.aborted) onDestroy();
      const timer = setTimeout(() => controller.abort(new Error('[ShadowCast] HTTP request timed out')), this.config.httpTimeout);
      try {
        const response = await fetch(url, { credentials: 'omit', cache: 'no-cache', signal: controller.signal });
        if (!response.ok || response.status === 206) {
          throw new Error(`[ShadowCast] Origin returned HTTP ${response.status} for ${url}`);
        }
        const blob = await this.verifyAsset(url, await response.blob());
        controller.signal.throwIfAborted();
        const expiresAt = originExpiry(response.headers);
        return await this.completeTransfer(url, blob, 'http', start, expiresAt);
      } finally {
        clearTimeout(timer);
        this.lifetime.signal.removeEventListener('abort', onDestroy);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.events.emit('transfer:error', { url, error });
      throw error;
    }
  }

  private async requestInterceptedAsset(rawUrl: string): Promise<Blob> {
    this.lifetime.signal.throwIfAborted();
    const url = assetUrl(rawUrl);
    if (!this.integrity.has(url)) throw new Error('[ShadowCast] Service worker requires a pinned asset');
    const blob = await this.readCached(url) ?? await this.requestFromSwarm(url);
    if (!blob) throw new Error('[ShadowCast] Asset is unavailable in cache and swarm');
    return blob;
  }

  private async requestFromSwarm(url: string): Promise<Blob | undefined> {
    if ((!this.integrity.has(url) && !this.config.allowUnverifiedPeers) ||
        typeof RTCPeerConnection === 'undefined' || typeof WebSocket === 'undefined') return;
    const room = this.currentRoom || this.config.defaultRoom;
    try {
      await this.connect(room);
    } catch {
      return;
    }
    if (!await this.waitForPeers() || room !== this.currentRoom || this.lifetime.signal.aborted) return;

    const id = getAssetId(url);
    const current = this.swarmTransfers.get(id);
    if (current) return current.url === url ? current.promise : undefined;
    if (this.swarmTransfers.size >= 8) return;

    let resolve!: (blob?: Blob) => void;
    const result = new Promise<Blob | undefined>((done) => { resolve = done; });
    const start = performance.now();
    const transfer: SwarmTransfer = {
      url,
      peers: new Set(),
      finished: false,
      promise: result.then(async (blob) => {
        if (!blob) return;
        try {
          const verified = await this.verifyAsset(url, blob);
          return await this.completeTransfer(url, verified, 'p2p', start);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          this.events.emit('transfer:error', { url, error });
          return undefined;
        }
      }).finally(() => {
        if (this.swarmTransfers.get(id) === transfer) this.swarmTransfers.delete(id);
      }),
      finish: (blob) => {
        if (transfer.finished) return;
        transfer.finished = true;
        clearTimeout(timer);
        clearTimeout(transfer.collectTimer);
        this.piecePicker.clearAsset(id);
        this.chunkReceiver.clearAsset(id);
        transfer.peers.clear();
        resolve(blob);
      },
    };
    const timer = setTimeout(transfer.finish, this.config.p2pTimeout);
    this.swarmTransfers.set(id, transfer);
    this.events.emit('transfer:start', { url, source: 'p2p' });
    if (!this.meshManager.broadcast(JSON.stringify({ type: 'asset-request', assetId: id, url }))) {
      transfer.finish();
    }
    return transfer.promise;
  }

  private async verifyAsset(url: string, blob: Blob): Promise<Blob> {
    const integrity = this.integrity.get(url);
    if (!integrity) return blob;
    if (await hashBlob(blob) !== integrity.sha256) {
      throw new Error(`[ShadowCast] Asset did not match its pinned SHA-256 digest: ${url}`);
    }
    return blob.type === integrity.mimeType ? blob : blob.slice(0, blob.size, integrity.mimeType);
  }

  private async completeTransfer(
    url: string, blob: Blob, source: 'http' | 'p2p', start: number, expiresAt?: number
  ): Promise<Blob> {
    this.lifetime.signal.throwIfAborted();
    if (expiresAt === undefined || expiresAt > Date.now()) {
      const key = this.cacheKey(url);
      await this.cacheManager.set(key, blob, { expiresAt });
      const stored = await this.cacheManager.has(key);
      this.lifetime.signal.throwIfAborted();
      if (stored) this.events.emit('cache:store', { url, bytes: blob.size });
    }
    this.totalTransfers++;
    if (source === 'p2p') {
      this.totalSavedBandwidth += blob.size;
      this.events.emit('bandwidth:saved', { bytes: blob.size, cumulativeBytes: this.totalSavedBandwidth });
    } else {
      this.totalHttpBytesReceived += blob.size;
    }
    this.events.emit('transfer:complete', {
      url, source, bytes: blob.size, durationMs: Math.round(performance.now() - start),
    });
    return blob;
  }

  private servePeer(assetId: string, rawUrl: string, peerId: string, indices?: number[], direct = false): void {
    const count = this.uploads.get(peerId) ?? 0;
    if (count >= 4 || this.uploads.size >= 32 && count === 0) return;
    let url: string;
    try {
      url = assetUrl(rawUrl);
    } catch {
      return;
    }
    if (getAssetId(url) !== assetId || (!this.integrity.has(url) && !this.config.allowUnverifiedPeers)) return;

    this.uploads.set(peerId, count + 1);
    void (async () => {
      const blob = await this.cacheManager.get(this.cacheKey(url));
      if (!blob || blob.size > MAX_SWARM_ASSET_BYTES || this.lifetime.signal.aborted) return;
      if (indices || direct) {
        await this.chunkSender.sendBlob(
          (data) => this.meshManager.sendToPeer(peerId, data), assetId, blob, direct ? undefined : indices,
          (bytes) => this.meshManager.waitForWritablePeer(peerId, bytes)
        );
      } else {
        await this.chunkSender.sendBitfield((data) => this.meshManager.sendToPeer(peerId, data), assetId, url, blob);
      }
    })().catch((error) => {
      console.warn('[ShadowCast] Failed to serve peer asset:', error);
    }).finally(() => {
      const remaining = (this.uploads.get(peerId) ?? 1) - 1;
      if (remaining > 0) this.uploads.set(peerId, remaining);
      else this.uploads.delete(peerId);
    });
  }

  private handleSwarmBitfield(bitfield: SwarmBitfieldMessage, peerId: string): void {
    const { assetId, url, assetHash, totalChunks, availableChunks, sizeBytes, chunkSize } = bitfield;
    const transfer = this.swarmTransfers.get(assetId);
    if (!transfer || transfer.finished || transfer.url !== url || totalChunks > MAX_SWARM_CHUNKS) return;
    const pin = this.integrity.get(url);
    if (pin && pin.sha256 !== assetHash) return;
    if (transfer.total !== undefined &&
        (transfer.total !== totalChunks || transfer.hash !== assetHash ||
          transfer.size !== sizeBytes || transfer.chunkSize !== chunkSize)) return;

    transfer.total = totalChunks;
    transfer.hash = assetHash;
    transfer.size = sizeBytes;
    transfer.chunkSize = chunkSize;
    transfer.peers.add(peerId);
    this.piecePicker.registerPeerChunks(assetId, peerId, availableChunks, totalChunks);
    if (totalChunks === 0) {
      this.requestPieces(assetId, url, peerId, []);
      return;
    }
    // Give concurrent advertisements a short window to share the initial assignments.
    if (!transfer.collectTimer) {
      transfer.collectTimer = setTimeout(() => {
        transfer.collectTimer = undefined;
        this.scheduleSwarmPieces(assetId);
      }, Math.min(25, this.config.p2pTimeout / 4));
    }
  }

  private scheduleSwarmPieces(assetId: string): void {
    const transfer = this.swarmTransfers.get(assetId);
    if (!transfer?.total) return;
    const assignments = this.piecePicker.planPieceRequests(
      assetId, transfer.total, this.chunkReceiver.getReceivedChunkIndices(assetId), this.meshManager.getOpenPeerIds()
    );
    for (const { peerId, indices } of assignments) this.requestPieces(assetId, transfer.url, peerId, indices);
  }

  private requestPieces(assetId: string, url: string, peerId: string, indices: number[]): void {
    const request: SwarmPieceRequestMessage = { type: 'swarm-piece-request', assetId, url, indices };
    this.meshManager.sendToPeer(peerId, JSON.stringify(request));
  }

  private finishSwarmTransfers(): void {
    for (const transfer of this.swarmTransfers.values()) transfer.finish();
  }

  private resetMesh(): void {
    this.finishSwarmTransfers();
    this.chunkReceiver.clear();
    this.piecePicker.clear();
    this.meshManager.cleanup();
  }

  async clearCache(): Promise<void> {
    for (const url of this.objectUrls) this.releaseAsset(url);
    await this.cacheManager.clear();
  }

  async registerServiceWorker(scriptUrl = '/sw.js', options?: ServiceWorkerOptions): Promise<ServiceWorkerRegistration | null> {
    this.lifetime.signal.throwIfAborted();
    return this.swManager.register(scriptUrl, options);
  }

  async unregisterServiceWorker(): Promise<boolean> {
    return this.swManager.unregister();
  }

  get isConnected(): boolean { return this.signalingClient.isConnected; }
  get peersCount(): number { return this.meshManager.openPeersCount; }
  get cumulativeBandwidthSaved(): number { return this.totalSavedBandwidth; }

  get stats(): ShadowCastStats {
    return {
      peersCount: this.peersCount,
      isConnected: this.isConnected,
      cumulativeBandwidthSaved: this.totalSavedBandwidth,
      totalP2PBytes: this.totalSavedBandwidth,
      totalHttpBytes: this.totalHttpBytesReceived,
      cacheHits: this.totalCacheHits,
      transfersCount: this.totalTransfers,
    };
  }

  destroy(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error('[ShadowCast] Instance has been destroyed'));
    this.events.removeAllListeners();
    this.signalingClient.disconnect();
    this.resetMesh();
    this.swManager.detach();
    this.cacheManager.close();
    for (const url of this.objectUrls) this.releaseAsset(url);
  }
}
