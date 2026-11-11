import {
  DEFAULT_CHUNK_SIZE, MAX_SWARM_ASSET_BYTES, MAX_SWARM_CHUNKS,
  SwarmBitfieldMessage, SwarmPieceRequestMessage,
} from '../core/types.js';
import { hashBuffer, hashBlob } from '../utils/hash.js';

export interface ChunkReceiverCallbacks {
  onAssetRequested?: (assetId: string, url: string, peerId: string, direct?: boolean) => void;
  onSwarmBitfieldReceived?: (bitfield: SwarmBitfieldMessage, peerId: string) => void;
  onSwarmPieceRequested?: (request: SwarmPieceRequestMessage, peerId: string) => void;
  acceptChunk?: (assetId: string, peerId: string, total: number, hash?: string) => boolean;
  onAssetComplete: (assetId: string, blob: Blob) => void;
  onChunkReceived?: (assetId: string, chunkIndex: number, peerId: string) => void;
  onChunkProgress?: (assetId: string, received: number, total: number, bytesReceived: number) => void;
  onIntegrityError?: (assetId: string, reason: string) => void;
}

interface TransferBuffer {
  parts: Map<number, ArrayBuffer>;
  total: number;
  size: number;
  mimeType: string;
  hash?: string;
  reassembling: boolean;
}

interface ChunkMeta {
  assetId: string;
  index: number;
  chunkHash?: string;
  transfer: TransferBuffer;
}

const digest = /^[a-f0-9]{64}$/;
const indexInRange = (value: unknown, length: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length;

export class ChunkReceiver {
  private readonly buffers = new Map<string, TransferBuffer>();
  private readonly pendingMetadata = new Map<string, (ChunkMeta | undefined)[]>();
  private readonly verificationBytes = new Map<string, number>();

  constructor(private readonly callbacks: ChunkReceiverCallbacks, private readonly verifyIntegrity = true) {}

  async handleMessage(data: ArrayBuffer | ArrayBufferView | string, peerId: string): Promise<void> {
    if (typeof data !== 'string') {
      await this.storeBinaryChunk(data, peerId);
      return;
    }
    if (data.length > DEFAULT_CHUNK_SIZE) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg) return;
    const { assetId, url } = msg;
    if (msg.type === 'chunk-meta') {
      this.queueMetadata(peerId, this.parseMetadata(msg, peerId));
      return;
    }
    if (typeof assetId !== 'string' || !assetId || assetId.length > 128) return;

    switch (msg.type) {
      case 'asset-request':
        if (typeof url === 'string' && url) this.callbacks.onAssetRequested?.(assetId, url, peerId, msg.direct === true);
        break;
      case 'swarm-bitfield':
        if (typeof url === 'string' && indexInRange(msg.totalChunks, MAX_SWARM_CHUNKS + 1) &&
            this.validLayout(msg) &&
            Array.isArray(msg.availableChunks) && msg.availableChunks.length <= MAX_SWARM_CHUNKS &&
            msg.availableChunks.every((index) => indexInRange(index, msg.totalChunks as number)) &&
            typeof msg.assetHash === 'string' && digest.test(msg.assetHash) &&
            typeof msg.mimeType === 'string') {
          this.callbacks.onSwarmBitfieldReceived?.(msg as unknown as SwarmBitfieldMessage, peerId);
        }
        break;
      case 'swarm-piece-request':
        if ((url === undefined || typeof url === 'string') && Array.isArray(msg.indices) &&
            msg.indices.length <= MAX_SWARM_CHUNKS && msg.indices.every((index) => indexInRange(index, MAX_SWARM_CHUNKS))) {
          this.callbacks.onSwarmPieceRequested?.(msg as unknown as SwarmPieceRequestMessage, peerId);
        }
        break;
      case 'chunk-done':
        if (msg.total === 0 && !this.buffers.has(assetId)) {
          const transfer = this.getTransfer(assetId, peerId, 0, msg.assetHash, msg.mimeType);
          if (transfer) await this.tryReassemble(assetId, transfer);
        }
        break;
    }
  }

  private validLayout({ sizeBytes, chunkSize, totalChunks }: Record<string, unknown>): boolean {
    if (sizeBytes === undefined && chunkSize === undefined) return true;
    return indexInRange(sizeBytes, MAX_SWARM_ASSET_BYTES + 1) &&
      indexInRange(chunkSize, DEFAULT_CHUNK_SIZE + 1) && chunkSize > 0 &&
      Math.ceil(sizeBytes / chunkSize) === totalChunks;
  }

  private parseMetadata(msg: Record<string, unknown>, peerId: string): ChunkMeta | undefined {
    const { assetId, index, total, assetHash, chunkHash, mimeType } = msg;
    if (typeof assetId !== 'string' || !assetId || assetId.length > 128 ||
        !indexInRange(total, MAX_SWARM_CHUNKS + 1) || !indexInRange(index, total)) return;
    const hash = typeof chunkHash === 'string' && digest.test(chunkHash) ? chunkHash : undefined;
    if (this.verifyIntegrity && !hash) return;
    const transfer = this.getTransfer(assetId, peerId, total, assetHash, mimeType);
    if (transfer) return { assetId, index, chunkHash: hash, transfer };
  }

  private getTransfer(assetId: string, peerId: string, total: number, assetHash: unknown, mimeType: unknown) {
    const hash = typeof assetHash === 'string' && digest.test(assetHash) ? assetHash : undefined;
    if (this.verifyIntegrity && !hash) return;
    if (this.callbacks.acceptChunk && !this.callbacks.acceptChunk(assetId, peerId, total, hash)) return;
    const existing = this.buffers.get(assetId);
    if (existing) return existing.total === total && existing.hash === hash ? existing : undefined;
    if (this.buffers.size >= 8) return;
    const transfer: TransferBuffer = {
      total, hash, parts: new Map(), size: 0, reassembling: false,
      mimeType: typeof mimeType === 'string' && mimeType.length <= 128 ? mimeType : 'application/octet-stream',
    };
    this.buffers.set(assetId, transfer);
    return transfer;
  }

  private queueMetadata(peerId: string, metadata: ChunkMeta | undefined): void {
    const queue = this.pendingMetadata.get(peerId) ?? [];
    // Keep a placeholder for rejected metadata so it still consumes its associated binary frame.
    if (queue.length < 32) queue.push(metadata);
    else queue.fill(undefined);
    this.pendingMetadata.set(peerId, queue);
  }

  private async storeBinaryChunk(data: ArrayBuffer | ArrayBufferView, peerId: string): Promise<void> {
    const queue = this.pendingMetadata.get(peerId);
    const meta = queue?.shift();
    if (queue?.length === 0) this.pendingMetadata.delete(peerId);
    if (!meta || data.byteLength === 0 || data.byteLength > DEFAULT_CHUNK_SIZE) return;

    const { assetId, index, transfer } = meta;
    if (this.buffers.get(assetId) !== transfer || transfer.parts.has(index)) return;
    const pending = this.verificationBytes.get(peerId) ?? 0;
    if (pending + data.byteLength > 8 * 1024 * 1024) return;
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
      : data;
    this.verificationBytes.set(peerId, pending + bytes.byteLength);
    try {
      const matches = !this.verifyIntegrity || await hashBuffer(bytes) === meta.chunkHash;
      if (this.buffers.get(assetId) !== transfer || transfer.parts.has(index)) return;
      if (this.callbacks.acceptChunk && !this.callbacks.acceptChunk(assetId, peerId, transfer.total, transfer.hash)) return;
      if (!matches) {
        this.callbacks.onIntegrityError?.(assetId, `Chunk ${index} SHA-256 mismatch`);
        return;
      }
      if (transfer.size + bytes.byteLength > MAX_SWARM_ASSET_BYTES) {
        this.clearAsset(assetId);
        this.callbacks.onIntegrityError?.(assetId, 'Swarm asset exceeds the size limit');
        return;
      }

      transfer.size += bytes.byteLength;
      transfer.parts.set(index, bytes);
      this.callbacks.onChunkReceived?.(assetId, index, peerId);
      this.callbacks.onChunkProgress?.(assetId, transfer.parts.size, transfer.total, transfer.size);
      await this.tryReassemble(assetId, transfer);
    } finally {
      const remaining = this.verificationBytes.get(peerId)! - bytes.byteLength;
      if (remaining > 0) this.verificationBytes.set(peerId, remaining);
      else this.verificationBytes.delete(peerId);
    }
  }

  private async tryReassemble(assetId: string, transfer: TransferBuffer): Promise<void> {
    if (transfer.reassembling || transfer.parts.size !== transfer.total || this.buffers.get(assetId) !== transfer) return;
    transfer.reassembling = true;
    const parts = Array.from({ length: transfer.total }, (_, i) => transfer.parts.get(i)!);
    const blob = new Blob(parts, { type: transfer.mimeType });
    try {
      const matches = !this.verifyIntegrity || await hashBlob(blob) === transfer.hash;
      if (this.buffers.get(assetId) !== transfer) return;
      this.clearAsset(assetId);
      if (matches) this.callbacks.onAssetComplete(assetId, blob);
      else this.callbacks.onIntegrityError?.(assetId, 'Full asset SHA-256 mismatch');
    } finally {
      transfer.reassembling = false;
    }
  }

  getReceivedChunkIndices(assetId: string): Set<number> {
    return new Set(this.buffers.get(assetId)?.parts.keys());
  }

  getExpectedTotalChunks(assetId: string): number | undefined {
    return this.buffers.get(assetId)?.total;
  }

  clearAsset(assetId: string): void {
    this.buffers.delete(assetId);
    for (const queue of this.pendingMetadata.values()) {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i]?.assetId === assetId) queue[i] = undefined;
      }
    }
  }

  clearPeer(peerId: string): void {
    this.pendingMetadata.delete(peerId);
  }

  clear(): void {
    this.buffers.clear();
    this.pendingMetadata.clear();
  }
}
