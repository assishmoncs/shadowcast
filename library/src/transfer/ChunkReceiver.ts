/**
 * ShadowCast - Chunk Receiver and Reassembly with SHA-256 Validation
 */

import { Chunk, ChunkBuffer, SwarmBitfieldMessage, SwarmPieceRequestMessage } from '../core/types.js';
import { hashBuffer, hashBlob } from '../utils/hash.js';

export interface ChunkReceiverCallbacks {
  onAssetRequested?: (assetId: string, url: string, peerId: string) => void;
  onSwarmBitfieldReceived?: (bitfield: SwarmBitfieldMessage, peerId: string) => void;
  onSwarmPieceRequested?: (request: SwarmPieceRequestMessage, peerId: string) => void;
  onAssetComplete: (assetId: string, blob: Blob) => void;
  onChunkProgress?: (assetId: string, receivedChunks: number, totalChunks: number) => void;
  onIntegrityError?: (assetId: string, reason: string) => void;
}

export class ChunkReceiver {
  private chunkBuffers: Map<string, ChunkBuffer> = new Map();
  private pendingChunkMeta: Map<string, { assetId: string; index: number; chunkHash?: string; assetHash?: string }> =
    new Map();

  constructor(
    private callbacks: ChunkReceiverCallbacks,
    private verifyIntegrity: boolean = true
  ) {}

  async handleMessage(data: ArrayBuffer | string, peerId: string): Promise<void> {
    if (typeof data === 'string') {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'asset-request': {
          const { assetId, url } = msg as { assetId: string; url: string };
          this.callbacks.onAssetRequested?.(assetId, url, peerId);
          break;
        }

        case 'swarm-bitfield': {
          const bitfield = msg as unknown as SwarmBitfieldMessage;
          this.callbacks.onSwarmBitfieldReceived?.(bitfield, peerId);
          break;
        }

        case 'swarm-piece-request': {
          const pieceReq = msg as unknown as SwarmPieceRequestMessage;
          this.callbacks.onSwarmPieceRequested?.(pieceReq, peerId);
          break;
        }

        case 'chunk-meta': {
          const { assetId, index, total, chunkHash, assetHash } = msg as unknown as Chunk & { type: string };
          if (!this.chunkBuffers.has(assetId)) {
            this.chunkBuffers.set(assetId, {
              received: new Map(),
              total,
              mimeType: 'application/octet-stream',
              assetHash,
              chunkHashes: new Map(),
            });
          }

          const buf = this.chunkBuffers.get(assetId)!;
          if (assetHash && !buf.assetHash) {
            buf.assetHash = assetHash;
          }
          if (chunkHash) {
            buf.chunkHashes.set(index, chunkHash);
          }

          this.pendingChunkMeta.set(peerId, { assetId, index, chunkHash, assetHash });
          break;
        }

        case 'chunk-done': {
          const { assetId, mimeType, assetHash } = msg as { assetId: string; mimeType: string; assetHash?: string };
          const buf = this.chunkBuffers.get(assetId);
          if (buf) {
            buf.mimeType = mimeType;
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

    await this.storeBinaryChunk(data, peerId);
  }

  private async storeBinaryChunk(buffer: ArrayBuffer, peerId: string): Promise<void> {
    const meta = this.pendingChunkMeta.get(peerId);
    if (!meta) return;

    const buf = this.chunkBuffers.get(meta.assetId);
    if (!buf) return;

    // Deduplication check: ignore if chunk index is already accepted
    if (buf.received.has(meta.index)) {
      this.pendingChunkMeta.delete(peerId);
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
        this.pendingChunkMeta.delete(peerId);
        return;
      }
    }

    buf.received.set(meta.index, buffer);
    this.pendingChunkMeta.delete(peerId);

    this.callbacks.onChunkProgress?.(meta.assetId, buf.received.size, buf.total);
    await this.tryReassemble(meta.assetId);
  }

  private async tryReassemble(assetId: string): Promise<void> {
    const buf = this.chunkBuffers.get(assetId);
    if (!buf || buf.received.size < buf.total) return;

    const parts: ArrayBuffer[] = [];
    for (let i = 0; i < buf.total; i++) {
      const chunk = buf.received.get(i);
      if (!chunk) return;
      parts.push(chunk);
    }

    const blob = new Blob(parts, { type: buf.mimeType });

    // End-to-end full asset integrity verification
    if (this.verifyIntegrity && buf.assetHash) {
      const fullHash = await hashBlob(blob);
      if (fullHash !== buf.assetHash) {
        this.callbacks.onIntegrityError?.(
          assetId,
          `Full asset SHA-256 mismatch (expected ${buf.assetHash}, got ${fullHash})`
        );
        return;
      }
    }

    this.chunkBuffers.delete(assetId);
    this.callbacks.onAssetComplete(assetId, blob);
  }

  getReceivedChunkIndices(assetId: string): Set<number> {
    const buf = this.chunkBuffers.get(assetId);
    if (!buf) return new Set();
    return new Set(buf.received.keys());
  }

  clear(): void {
    this.chunkBuffers.clear();
    this.pendingChunkMeta.clear();
  }
}
