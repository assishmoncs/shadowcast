import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../core/events.js';

interface TestEvents {
  'peer:join': { peerId: string; totalPeers: number };
  status: { state: string };
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

test('EventEmitter once fires only once and can be removed via off(originalListener) before firing', () => {
  const ee = new EventEmitter<TestEvents>();
  let count = 0;

  const listener = ({ state }: { state: string }) => {
    count++;
    assert.equal(state, 'connected');
  };

  ee.once('status', listener);
  ee.emit('status', { state: 'connected' });
  ee.emit('status', { state: 'connected' });
  assert.equal(count, 1);

  // Register once again and remove via off(listener) before emitting
  ee.once('status', listener);
  assert.equal(ee.listenerCount('status'), 1);
  ee.off('status', listener);
  assert.equal(ee.listenerCount('status'), 0);
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

test('Async event listener rejections are isolated from other subscribers', async (t) => {
  const emitter = new EventEmitter<{ sample: string }>();
  const error = new Error('listener failed');
  const report = t.mock.method(console, 'error', () => {});
  const other = t.mock.fn();
  emitter.once('sample', async () => { throw error; });
  emitter.on('sample', other);
  emitter.emit('sample', 'one');
  emitter.emit('sample', 'two');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(other.mock.callCount(), 2);
  assert.equal(report.mock.callCount(), 1);
  assert.equal(report.mock.calls[0].arguments[1], error);
});
