import test from 'node:test';
import assert from 'node:assert/strict';
import { PiecePicker } from '../transfer/PiecePicker.js';

test('PiecePicker distributes chunk slices evenly across connected peers', () => {
  const picker = new PiecePicker();
  const assetId = 'asset-123';
  const totalChunks = 6;
  const alreadyReceived = new Set<number>();
  const availablePeers = ['peer-1', 'peer-2'];

  picker.registerPeerChunks(assetId, 'peer-1', [0, 1, 2, 3, 4, 5]);
  picker.registerPeerChunks(assetId, 'peer-2', [0, 1, 2, 3, 4, 5]);

  const assignments = picker.planPieceRequests(assetId, totalChunks, alreadyReceived, availablePeers);

  assert.equal(assignments.length, 2);
  const peer1 = assignments.find((a) => a.peerId === 'peer-1');
  const peer2 = assignments.find((a) => a.peerId === 'peer-2');

  assert.ok(peer1 !== undefined);
  assert.ok(peer2 !== undefined);
  if (peer1 && peer2) {
    assert.equal(peer1.indices.length, 3);
    assert.equal(peer2.indices.length, 3);
    assert.equal(peer1.indices.length + peer2.indices.length, 6);
  }
});

test('PiecePicker assigns chunks only to peers that actually possess those chunk indices', () => {
  const picker = new PiecePicker();
  const assetId = 'asset-partial';

  // peer-1 only has chunks [0, 1], peer-2 only has chunks [2, 3]
  picker.registerPeerChunks(assetId, 'peer-1', [0, 1], 4);
  picker.registerPeerChunks(assetId, 'peer-2', [2, 3], 4);

  const assignments = picker.planPieceRequests(assetId, 4, new Set(), ['peer-1', 'peer-2']);
  const peer1 = assignments.find((a) => a.peerId === 'peer-1');
  const peer2 = assignments.find((a) => a.peerId === 'peer-2');

  assert.deepEqual(peer1?.indices, [0, 1]);
  assert.deepEqual(peer2?.indices, [2, 3]);
});

test('PiecePicker unregisters disconnected peer and returns unassigned chunks', () => {
  const picker = new PiecePicker();
  const assetId = 'asset-456';
  picker.registerPeerChunks(assetId, 'peer-fail', [0, 1, 2]);

  picker.planPieceRequests(assetId, 3, new Set(), ['peer-fail']);
  const unassigned = picker.unregisterPeer('peer-fail');

  assert.ok(unassigned.has(assetId));
  assert.equal(unassigned.get(assetId)!.length, 3);
});
