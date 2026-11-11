import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SignalingClient } from '../signaling/SignalingClient.js';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: unknown[] = [];

  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function install(t: TestContext) {
  const original = globalThis.WebSocket;
  Socket.instances = [];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
}

test('Signaling reports connected after room acknowledgment and reuses the socket for room moves', async (t) => {
  install(t);
  const client = new SignalingClient('ws://localhost/ws');
  t.after(() => client.disconnect());
  const handler = t.mock.fn();
  client.onMessage(handler);
  const joining = client.connect('first', 'client-id');
  const socket = Socket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'join', room: 'first', from: 'client-id' }]);
  assert.equal(client.isConnected, false);
  socket.receive({ type: 'self-id', id: 'temporary-id' });
  assert.equal(handler.mock.callCount(), 0);
  socket.receive({ type: 'room-peers', id: 'client-id', room: 'first', peers: [] });
  await joining;
  assert.equal(client.isConnected, true);

  const moving = client.connect('second', 'client-id');
  assert.equal(client.isConnected, false);
  assert.equal(Socket.instances.length, 1);
  socket.receive({ type: 'room-peers', id: 'client-id', room: 'first', peers: [] });
  assert.equal(client.isConnected, false);
  socket.receive({ type: 'room-peers', id: 'client-id', room: 'second', peers: [] });
  await moving;
  assert.equal(client.isConnected, true);
  assert.equal(handler.mock.callCount(), 2);
});

test('Signaling propagates join rejection and cancels superseded or stalled attempts', async (t) => {
  install(t);
  const client = new SignalingClient('ws://localhost/ws', 30);
  t.after(() => client.disconnect());
  const first = assert.rejects(client.connect('first', 'client-id'), /canceled/);
  const second = assert.rejects(client.connect('second', 'client-id'), /Room is full/);
  assert.equal(Socket.instances[0].readyState, 3);
  const secondSocket = Socket.instances[1];
  secondSocket.open();
  secondSocket.receive({ type: 'error', error: 'Room is full' });
  await Promise.all([first, second]);
  assert.equal(secondSocket.readyState, 3);

  const stalled = client.connect('third', 'client-id');
  const thirdSocket = Socket.instances[2];
  thirdSocket.open();
  await assert.rejects(stalled, /Room join timed out/);
  assert.equal(thirdSocket.readyState, 3);
});
