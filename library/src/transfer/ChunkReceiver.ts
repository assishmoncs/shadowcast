/**
 * ShadowCast - Chunk Receiver and Reassembly with SHA-256 Validation
 */

import { Chunk, ChunkBuffer, SwarmBitfieldMessage, SwarmPieceRequestMessage } from '../core/types.js';
import { hashBuffer, hashBlob } from '../utils/hash.js';

export interface ChunkReceiverCallbacks {
  onAssetRequested?: (assetId: string, url: string, peerId: string, direct?: boolean) => void;
  onSwarmBitfieldReceived?: (bitfield: SwarmBitfieldMessage, peerId: string) => void;
  onSwarmPieceRequested?: (request: SwarmPieceRequestMessage, peerId: string) => void;
  onAssetComplete: (assetId: string, blob: Blob) => void;
  onChunkReceived?: (assetId: string, chunkIndex: number, peerId: string) => void;
  onChunkProgress?: (assetId: string, receivedChunks: number, totalChunks: number) => void;
  onIntegrityError?: (assetId: string, reason: string) => void;
}

interface PendingChunkMeta {
  assetId: string;
  index: number;
  total: number;
  mimeType?: string;
  chunkHash?: string;
  assetHash?: string;
}

export class ChunkReceiver {
  private chunkBuffers: Map<string, ChunkBuffer> = new Map();
  private pendingChunkMetaQueue: Map<string, PendingChunkMeta[]> = new Map();
  private reassemblingAssets: Set<string> = new Set();

  constructor(
    private callbacks: ChunkReceiverCallbacks,
    private verifyIntegrity: boolean = true
  ) {}

  async handleMessage(data: ArrayBuffer | ArrayBufferView | string, peerId: string): Promise<void> {
    if (typeof data === 'string') {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (!msg || typeof msg.type !== 'string') {
        return;
      }

      switch (msg.type) {
        case 'asset-request': {
          const { assetId, url, direct } = msg as { assetId?: string; url?: string; direct?: boolean };
          if (typeof assetId === 'string' && typeof url === 'string' && assetId && url) {
            this.callbacks.onAssetRequested?.(assetId, url, peerId, Boolean(direct));
          }
          break;
        }

        case 'swarm-bitfield': {
          const bitfield = msg as unknown as SwarmBitfieldMessage;
          if (
            typeof bitfield.assetId === 'string' &&
            typeof bitfield.totalChunks === 'number' &&
            Array.isArray(bitfield.availableChunks)
          ) {
            this.callbacks.onSwarmBitfieldReceived?.(bitfield, peerId);
          }
          break;
        }

        case 'swarm-piece-request': {
          const pieceReq = msg as unknown as SwarmPieceRequestMessage;
          if (typeof pieceReq.assetId === 'string' && Array.isArray(pieceReq.indices)) {
            this.callbacks.onSwarmPieceRequested?.(pieceReq, peerId);
          }
          break;
        }

        case 'chunk-meta': {
          const { assetId, index, total, mimeType, chunkHash, assetHash } = msg as unknown as Chunk & {
            type: string;
          };
          if (
            typeof assetId !== 'string' ||
            !assetId ||
            typeof index !== 'number' ||
            typeof total !== 'number' ||
            index < 0 ||
            total <= 0 ||
            index >= total
          ) {
            return;
          }

          if (!this.chunkBuffers.has(assetId)) {
            this.chunkBuffers.set(assetId, {
              received: new Map(),
              total,
              mimeType: mimeType || 'application/octet-stream',
              assetHash,
              chunkHashes: new Map(),
            });
          }

          const buf = this.chunkBuffers.get(assetId)!;
          if (mimeType && buf.mimeType === 'application/octet-stream') {
            buf.mimeType = mimeType;
          }
          if (assetHash && !buf.assetHash) {
            buf.assetHash = assetHash;
          }
          if (chunkHash) {
            buf.chunkHashes.set(index, chunkHash);
          }

          if (!this.pendingChunkMetaQueue.has(peerId)) {
            this.pendingChunkMetaQueue.set(peerId, []);
          }
          this.pendingChunkMetaQueue.get(peerId)!.push({
            assetId,
            index,
            total,
            mimeType,
            chunkHash,
            assetHash,
          });
          break;
        }

        case 'chunk-done': {
          const { assetId, mimeType, assetHash, total } = msg as {
            assetId?: string;
            mimeType?: string;
            assetHash?: string;
            total?: number;
          };
          if (typeof assetId !== 'string' || !assetId) {
            return;
          }

          // Handle 0-byte Blob transfers where no chunk-meta messages were sent
          if (total === 0 && !this.chunkBuffers.has(assetId)) {
            this.chunkBuffers.set(assetId, {
              received: new Map(),
              total: 0,
              mimeType: mimeType || 'application/octet-stream',
              assetHash,
              chunkHashes: new Map(),
            });
          }

          const buf = this.chunkBuffers.get(assetId);
          if (buf) {
            if (mimeType) {
              buf.mimeType = mimeType;
            }
            if (assetHash) {
              buf.assetHash = assetHash;
            }
            await this.tryReassemble(assetId);
          }
          break;
        }
      }
      return;
    }

    const rawBuffer: ArrayBuffer = ArrayBuffer.isView(data)
      ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      : data;

    await this.storeBinaryChunk(rawBuffer, peerId);
  }

  private async storeBinaryChunk(buffer: ArrayBuffer, peerId: string): Promise<void> {
    // Synchronously dequeue the matching metadata before any async await to prevent race conditions
    const queue = this.pendingChunkMetaQueue.get(peerId);
    if (!queue || queue.length === 0) return;

    const meta = queue.shift()!;
    if (queue.length === 0) {
      this.pendingChunkMetaQueue.delete(peerId);
    }

    const initialBuf = this.chunkBuffers.get(meta.assetId);
    if (!initialBuf) return;

    // Deduplication check: ignore if chunk index is already accepted
    if (initialBuf.received.has(meta.index)) {
      return;
    }

    // SHA-256 chunk integrity verification
    if (this.verifyIntegrity && meta.chunkHash) {
      const calculatedHash = await hashBuffer(buffer);
      if (calculatedHash !== meta.chunkHash) {
        this.callbacks.onIntegrityError?.(
          meta.assetId,
          `Chunk ${meta.index} hash mismatch (expected ${meta.chunkHash}, got ${calculatedHash})`
        );
        return;
      }
    }

    // Re-verify buffer existence after async hash verification
    const buf = this.chunkBuffers.get(meta.assetId);
    if (!buf || buf.received.has(meta.index)) {
      return;
    }

    if (meta.mimeType && buf.mimeType === 'application/octet-stream') {
      buf.mimeType = meta.mimeType;
    }

    buf.received.set(meta.index, buffer);

    this.callbacks.onChunkReceived?.(meta.assetId, meta.index, peerId);
    this.callbacks.onChunkProgress?.(meta.assetId, buf.received.size, buf.total);
    await this.tryReassemble(meta.assetId);
  }

  private async tryReassemble(assetId: string): Promise<void> {
    if (this.reassemblingAssets.has(assetId)) {
      return;
    }

    const buf = this.chunkBuffers.get(assetId);
    if (!buf || buf.received.size < buf.total) {
      return;
    }

    const parts: ArrayBuffer[] = [];
    for (let i = 0; i < buf.total; i++) {
      const chunk = buf.received.get(i);
      if (!chunk) return;
      parts.push(chunk);
    }

    this.reassemblingAssets.add(assetId);

    try {
      const blob = new Blob(parts, { type: buf.mimeType });

      // End-to-end full asset integrity verification
      if (this.verifyIntegrity && buf.assetHash) {
        const fullHash = await hashBlob(blob);
        if (fullHash !== buf.assetHash) {
          this.chunkBuffers.delete(assetId);
          this.callbacks.onIntegrityError?.(
            assetId,
            `Full asset SHA-256 mismatch (expected ${buf.assetHash}, got ${fullHash})`
          );
          return;
        }
      }

      this.chunkBuffers.delete(assetId);
      this.callbacks.onAssetComplete(assetId, blob);
    } finally {
      this.reassemblingAssets.delete(assetId);
    }
  }

  getReceivedChunkIndices(assetId: string): Set<number> {
    const buf = this.chunkBuffers.get(assetId);
    if (!buf) return new Set();
    return new Set(buf.received.keys());
  }

  getExpectedTotalChunks(assetId: string): number | undefined {
    return this.chunkBuffers.get(assetId)?.total;
  }

  clearAsset(assetId: string): void {
    this.chunkBuffers.delete(assetId);
    this.reassemblingAssets.delete(assetId);
  }

  clear(): void {
    this.chunkBuffers.clear();
    this.pendingChunkMetaQueue.clear();
    this.reassemblingAssets.clear();
  }
}
