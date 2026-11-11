import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkSender } from '../transfer/ChunkSender.js';
import { ChunkReceiver } from '../transfer/ChunkReceiver.js';

test('ChunkSender and ChunkReceiver slice, stream, and reassemble Blobs with MIME type intact', async () => {
  const originalText = 'ShadowCast P2P asset delivery engine integrity verification test payload!';
  const encoder = new TextEncoder();
  const rawBytes = encoder.encode(originalText);
  const originalBlob = new Blob([rawBytes], { type: 'text/plain' });

  const assetId = 'test-asset-id';
  let reassembledBlob: Blob | undefined;
  const progressEvents: Array<{ received: number; total: number }> = [];

  const receiver = new ChunkReceiver({
    onAssetComplete: (_id, blob) => {
      reassembledBlob = blob;
    },
    onChunkProgress: (_id, received, total) => {
      progressEvents.push({ received, total });
    },
  });

  const sender = new ChunkSender(16); // 16 bytes per chunk to force multiple chunks

  await sender.sendBlob(
    (data) => {
      void receiver.handleMessage(data, 'peer-sender-1');
      return true;
    },
    assetId,
    originalBlob
  );

  // Give the async microtask queue time to finish hash verification & reassembly
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(reassembledBlob !== undefined, 'Blob should have been reassembled');
  assert.equal(reassembledBlob!.type, 'text/plain', 'MIME type must be preserved');
  assert.ok(progressEvents.length > 0, 'Progress events should have fired');

  const reassembledBuffer = await reassembledBlob!.arrayBuffer();
  const decoder = new TextDecoder();
  const reassembledText = decoder.decode(reassembledBuffer);

  assert.equal(reassembledText, originalText);
});

test('ChunkSender and ChunkReceiver handle 0-byte empty Blobs cleanly', async () => {
  const emptyBlob = new Blob([], { type: 'application/json' });
  let completedBlob: Blob | undefined;

  const receiver = new ChunkReceiver({
    onAssetComplete: (_id, blob) => {
      completedBlob = blob;
    },
  });

  const sender = new ChunkSender(64);
  await sender.sendBlob(
    (data) => {
      void receiver.handleMessage(data, 'peer-empty');
      return true;
    },
    'empty-asset',
    emptyBlob
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(completedBlob !== undefined);
  assert.equal(completedBlob!.size, 0);
  assert.equal(completedBlob!.type, 'application/json');
});

test('ChunkReceiver detects corrupted chunk SHA-256 and recovers when valid chunk arrives', async () => {
  const originalBlob = new Blob([new TextEncoder().encode('ABCDEFGHIJKLMNOP')], {
    type: 'text/plain',
  });
  let integrityErrors = 0;
  let completedBlob: Blob | undefined;

  const receiver = new ChunkReceiver({
    onAssetComplete: (_id, blob) => {
      completedBlob = blob;
    },
    onIntegrityError: () => {
      integrityErrors++;
    },
  });

  const sender = new ChunkSender(8); // 2 chunks of 8 bytes
  const capturedMessages: Array<string | ArrayBuffer> = [];

  await sender.sendBlob(
    (data) => {
      capturedMessages.push(data);
      return true;
    },
    'corrupt-test',
    originalBlob
  );

  // Corrupt the binary payload of chunk 0 (capturedMessages[1])
  const validMeta0 = capturedMessages[0] as string;
  const validBuf0 = capturedMessages[1] as ArrayBuffer;
  const corruptedBuf0 = validBuf0.slice(0);
  new Uint8Array(corruptedBuf0)[0] ^= 0xff;

  await receiver.handleMessage(validMeta0, 'peer-bad');
  await receiver.handleMessage(corruptedBuf0, 'peer-bad');

  assert.equal(integrityErrors, 1, 'Should flag corrupted chunk');
  assert.equal(completedBlob, undefined);

  // Now replay all valid messages from a good peer
  for (const msg of capturedMessages) {
    await receiver.handleMessage(msg, 'peer-good');
  }

  assert.ok(completedBlob !== undefined, 'Should complete after receiving valid chunks');
  assert.equal(await (completedBlob as Blob).text(), 'ABCDEFGHIJKLMNOP');
});
