import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../core/events.js';

interface TestEvents {
  'peer:join': { peerId: string; totalPeers: number };
  'status': { state: string };
}

test('EventEmitter on and emit dispatches payloads correctly', () => {
  const ee = new EventEmitter<TestEvents>();
  let called = false;
  let receivedPeerId = '';

  ee.on('peer:join', ({ peerId, totalPeers }) => {
    called = true;
    receivedPeerId = peerId;
    assert.equal(totalPeers, 3);
  });

  ee.emit('peer:join', { peerId: 'peer-abc', totalPeers: 3 });

  assert.equal(called, true);
  assert.equal(receivedPeerId, 'peer-abc');
});

test('EventEmitter once fires only once', () => {
  const ee = new EventEmitter<TestEvents>();
  let count = 0;

  ee.once('status', ({ state }) => {
    count++;
    assert.equal(state, 'connected');
  });

  ee.emit('status', { state: 'connected' });
  ee.emit('status', { state: 'connected' });

  assert.equal(count, 1);
});

test('EventEmitter off removes listener', () => {
  const ee = new EventEmitter<TestEvents>();
  let count = 0;
  const listener = () => {
    count++;
  };

  const unsub = ee.on('status', listener);
  ee.emit('status', { state: 'connecting' });
  assert.equal(count, 1);

  unsub();
  ee.emit('status', { state: 'connected' });
  assert.equal(count, 1);
});
