/**
 * ShadowCast - Chunk Sender with SHA-256 Integrity Verification
 */

import { Chunk, DEFAULT_CHUNK_SIZE } from '../core/types.js';
import { hashBuffer, hashBlob } from '../utils/hash.js';

export class ChunkSender {
  private readonly chunkSize: number;

  constructor(chunkSize: number = DEFAULT_CHUNK_SIZE) {
    this.chunkSize = chunkSize > 0 ? Math.floor(chunkSize) : DEFAULT_CHUNK_SIZE;
  }

  async sendBlob(
    sendFn: (data: string | ArrayBuffer) => boolean,
    assetId: string,
    blob: Blob,
    specificIndices?: number[]
  ): Promise<boolean> {
    const totalChunks = blob.size > 0 ? Math.ceil(blob.size / this.chunkSize) : 0;
    const assetHash = await hashBlob(blob);
    const mimeType = blob.type || 'application/octet-stream';

    const indicesToSend =
      specificIndices !== undefined
        ? Array.from(new Set(specificIndices)).filter((idx) => idx >= 0 && idx < totalChunks)
        : Array.from({ length: totalChunks }, (_, i) => i);

    for (const i of indicesToSend) {
      const slice = blob.slice(i * this.chunkSize, (i + 1) * this.chunkSize);
      const buffer = await slice.arrayBuffer();
      const chunkHash = await hashBuffer(buffer);

      const meta: Chunk = {
        index: i,
        total: totalChunks,
        assetId,
        mimeType,
        chunkHash,
        assetHash,
      };

      const metaSent = sendFn(JSON.stringify({ ...meta, type: 'chunk-meta' }));
      if (!metaSent) return false;

      const dataSent = sendFn(buffer);
      if (!dataSent) return false;
    }

    return sendFn(
      JSON.stringify({
        type: 'chunk-done',
        assetId,
        total: totalChunks,
        assetHash,
        mimeType,
      })
    );
  }

  async sendBitfield(
    sendFn: (data: string) => boolean,
    assetId: string,
    url: string,
    blob: Blob
  ): Promise<boolean> {
    const totalChunks = blob.size > 0 ? Math.ceil(blob.size / this.chunkSize) : 0;
    const assetHash = await hashBlob(blob);

    return sendFn(
      JSON.stringify({
        type: 'swarm-bitfield',
        assetId,
        url,
        totalChunks,
        availableChunks: Array.from({ length: totalChunks }, (_, i) => i),
        assetHash,
        mimeType: blob.type || 'application/octet-stream',
      })
    );
  }
}
