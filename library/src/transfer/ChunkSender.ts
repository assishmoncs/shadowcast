/**
 * ShadowCast - Chunk Sender with SHA-256 Integrity Verification
 */

import { Chunk, DEFAULT_CHUNK_SIZE } from '../core/types.js';
import { hashBuffer, hashBlob } from '../utils/hash.js';

export class ChunkSender {
  constructor(private chunkSize: number = DEFAULT_CHUNK_SIZE) {}

  async sendBlob(
    sendFn: (data: string | ArrayBuffer) => boolean,
    assetId: string,
    blob: Blob,
    specificIndices?: number[]
  ): Promise<void> {
    const totalChunks = Math.ceil(blob.size / this.chunkSize);
    const assetHash = await hashBlob(blob);

    const indicesToSend =
      specificIndices && specificIndices.length > 0
        ? specificIndices.filter((idx) => idx >= 0 && idx < totalChunks)
        : Array.from({ length: totalChunks }, (_, i) => i);

    for (const i of indicesToSend) {
      const slice = blob.slice(i * this.chunkSize, (i + 1) * this.chunkSize);
      const buffer = await slice.arrayBuffer();
      const chunkHash = await hashBuffer(buffer);

      const meta: Chunk = {
        index: i,
        total: totalChunks,
        assetId,
        chunkHash,
        assetHash,
      };

      const metaSent = sendFn(JSON.stringify({ ...meta, type: 'chunk-meta' }));
      if (!metaSent) return;

      const dataSent = sendFn(buffer);
      if (!dataSent) return;
    }

    sendFn(
      JSON.stringify({
        type: 'chunk-done',
        assetId,
        assetHash,
        mimeType: blob.type,
      })
    );
  }

  async sendBitfield(
    sendFn: (data: string) => boolean,
    assetId: string,
    url: string,
    blob: Blob
  ): Promise<void> {
    const totalChunks = Math.ceil(blob.size / this.chunkSize);
    const assetHash = await hashBlob(blob);

    sendFn(
      JSON.stringify({
        type: 'swarm-bitfield',
        assetId,
        url,
        totalChunks,
        availableChunks: Array.from({ length: totalChunks }, (_, i) => i),
        assetHash,
        mimeType: blob.type,
      })
    );
  }
}
