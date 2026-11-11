import { DEFAULT_CHUNK_SIZE, MAX_SWARM_ASSET_BYTES, MAX_SWARM_CHUNKS } from '../core/types.js';
import { hashBuffer, hashBlob } from '../utils/hash.js';

export class ChunkSender {
  private readonly chunkSize: number;

  constructor(chunkSize: number = DEFAULT_CHUNK_SIZE) {
    this.chunkSize = Number.isSafeInteger(chunkSize) && chunkSize > 0
      ? Math.min(chunkSize, DEFAULT_CHUNK_SIZE)
      : DEFAULT_CHUNK_SIZE;
  }

  async sendBlob(
    send: (data: string | ArrayBuffer) => boolean,
    assetId: string,
    blob: Blob,
    specificIndices?: number[],
    waitForWritable?: (bytes: number) => Promise<boolean>
  ): Promise<boolean> {
    const total = Math.ceil(blob.size / this.chunkSize);
    if (total > MAX_SWARM_CHUNKS || blob.size > MAX_SWARM_ASSET_BYTES) return false;

    const assetHash = await hashBlob(blob);
    const mimeType = blob.type || 'application/octet-stream';
    const indices = specificIndices === undefined
      ? Array.from({ length: total }, (_, i) => i)
      : Array.from(new Set(specificIndices)).filter((i) => Number.isInteger(i) && i >= 0 && i < total);

    for (const index of indices) {
      const bytes = await blob.slice(index * this.chunkSize, (index + 1) * this.chunkSize).arrayBuffer();
      const chunkHash = await hashBuffer(bytes);
      if (waitForWritable && !await waitForWritable(bytes.byteLength)) return false;

      const meta = { type: 'chunk-meta', assetId, index, total, assetHash, chunkHash, mimeType };
      if (!send(JSON.stringify(meta)) || !send(bytes)) return false;
    }
    return send(JSON.stringify({ type: 'chunk-done', assetId, total, assetHash, mimeType }));
  }

  async sendBitfield(send: (data: string) => boolean, assetId: string, url: string, blob: Blob): Promise<boolean> {
    const totalChunks = Math.ceil(blob.size / this.chunkSize);
    if (totalChunks > MAX_SWARM_CHUNKS || blob.size > MAX_SWARM_ASSET_BYTES) return false;
    return send(JSON.stringify({
      type: 'swarm-bitfield',
      assetId,
      url,
      totalChunks,
      sizeBytes: blob.size,
      chunkSize: this.chunkSize,
      availableChunks: Array.from({ length: totalChunks }, (_, i) => i),
      assetHash: await hashBlob(blob),
      mimeType: blob.type || 'application/octet-stream',
    }));
  }
}
