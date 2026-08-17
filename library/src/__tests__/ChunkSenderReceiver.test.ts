import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkSender } from '../transfer/ChunkSender.js';
import { ChunkReceiver } from '../transfer/ChunkReceiver.js';

test('ChunkSender and ChunkReceiver slice, stream, and reassemble Blobs identically', async () => {
  const originalText = 'ShadowCast P2P asset delivery engine integrity verification test payload!';
  const encoder = new TextEncoder();
  const rawBytes = encoder.encode(originalText);
  const originalBlob = new Blob([rawBytes], { type: 'text/plain' });

  const assetId = 'test-asset-id';
  let reassembledBlob: Blob | undefined;

  const receiver = new ChunkReceiver({
    onAssetComplete: (_id, blob) => {
      reassembledBlob = blob;
    },
  });

  const sender = new ChunkSender(16); // 16 bytes per chunk to force multiple chunks

  await sender.sendBlob(
    (data) => {
      // Async handle message
      receiver.handleMessage(data, 'peer-sender-1');
      return true;
    },
    assetId,
    originalBlob
  );

  // Give the async microtask queue time to finish hash verification & reassembly
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(reassembledBlob !== undefined, 'Blob should have been reassembled');
  const reassembledBuffer = await (reassembledBlob as Blob).arrayBuffer();
  const decoder = new TextDecoder();
  const reassembledText = decoder.decode(reassembledBuffer);

  assert.equal(reassembledText, originalText);
});
