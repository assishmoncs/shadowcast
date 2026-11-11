import test from 'node:test';
import assert from 'node:assert/strict';
import { ShadowCast } from '../core/ShadowCast.js';

/**
 * In-memory virtual WebSocket + WebRTC DataChannel network bus
 * for deterministic, fast end-to-end multi-peer testing in Node.js.
 */
class VirtualNetworkEnvironment {
  private socketsByPeer: Map<string, any> = new Map();
  private rooms: Map<string, Set<string>> = new Map();
  public peerConnections: Map<string, any> = new Map();
  public signalingOnline = true;
  public httpRequestsCount = 0;
  public httpAssets: Map<string, Blob> = new Map();

  install() {
    const env = this;

    class VirtualWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = VirtualWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: ((err: any) => void) | null = null;
      onclose: (() => void) | null = null;
      peerId = '';
      room = '';

      constructor(_url: string) {
        queueMicrotask(() => {
          if (!env.signalingOnline) {
            this.readyState = VirtualWebSocket.CLOSED;
            this.onerror?.(new Error('Connection refused'));
            return;
          }
          this.readyState = VirtualWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.type === 'join') {
          this.peerId = msg.from;
          this.room = msg.room;
          env.socketsByPeer.set(this.peerId, this);
          if (!env.rooms.has(this.room)) {
            env.rooms.set(this.room, new Set());
          }
          const roomSet = env.rooms.get(this.room)!;
          const existing = Array.from(roomSet).filter((id) => id !== this.peerId);
          roomSet.add(this.peerId);

          queueMicrotask(() => {
            this.onmessage?.({
              data: JSON.stringify({ type: 'room-peers', peers: existing }),
            });
            for (const otherId of existing) {
              env.socketsByPeer.get(otherId)?.onmessage?.({
                data: JSON.stringify({ type: 'peer-joined', id: this.peerId }),
              });
            }
          });
        } else if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
          const targetWs = env.socketsByPeer.get(msg.target);
          if (targetWs && targetWs.readyState === VirtualWebSocket.OPEN) {
            queueMicrotask(() => {
              targetWs.onmessage?.({ data: JSON.stringify(msg) });
            });
          }
        }
      }

      close() {
        this.readyState = VirtualWebSocket.CLOSED;
        if (this.room && env.rooms.has(this.room)) {
          const roomSet = env.rooms.get(this.room)!;
          roomSet.delete(this.peerId);
          for (const otherId of roomSet) {
            env.socketsByPeer.get(otherId)?.onmessage?.({
              data: JSON.stringify({ type: 'peer-left', id: this.peerId }),
            });
          }
        }
        env.socketsByPeer.delete(this.peerId);
        this.onclose?.();
      }
    }

    class VirtualRTCDataChannel {
      readyState = 'connecting';
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: any }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((err: any) => void) | null = null;
      remoteChannel: VirtualRTCDataChannel | null = null;

      constructor(public label: string) {}

      send(data: any) {
        if (this.readyState !== 'open' || !this.remoteChannel) {
          throw new Error('DataChannel not open');
        }
        const target = this.remoteChannel;
        queueMicrotask(() => {
          if (target.readyState === 'open') {
            target.onmessage?.({ data });
          }
        });
      }

      close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.onclose?.();
        if (this.remoteChannel && this.remoteChannel.readyState !== 'closed') {
          this.remoteChannel.readyState = 'closed';
          this.remoteChannel.onclose?.();
        }
      }
    }

    class VirtualRTCPeerConnection {
      signalingState = 'stable';
      connectionState = 'new';
      iceConnectionState = 'new';
      localDescription: any = null;
      remoteDescription: any = null;
      onicecandidate: ((ev: any) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      ondatachannel: ((ev: any) => void) | null = null;
      localChannel: VirtualRTCDataChannel | null = null;
      pcId = Math.random().toString(36).slice(2);

      constructor() {
        env.peerConnections.set(this.pcId, this);
      }

      createDataChannel(label: string) {
        this.localChannel = new VirtualRTCDataChannel(label);
        return this.localChannel;
      }

      async createOffer() {
        return { type: 'offer', sdp: this.pcId };
      }

      async createAnswer() {
        return { type: 'answer', sdp: this.pcId };
      }

      async setLocalDescription(desc: any) {
        this.localDescription = desc;
        this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
      }

      async setRemoteDescription(desc: any) {
        this.remoteDescription = desc;
        this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';

        if (desc.type === 'answer') {
          const answererPc = env.peerConnections.get(desc.sdp);
          if (answererPc && this.localChannel) {
            const remoteChan = new VirtualRTCDataChannel(this.localChannel.label);
            this.localChannel.remoteChannel = remoteChan;
            remoteChan.remoteChannel = this.localChannel;

            answererPc.ondatachannel?.({ channel: remoteChan });

            queueMicrotask(() => {
              this.connectionState = 'connected';
              answererPc.connectionState = 'connected';
              this.localChannel!.readyState = 'open';
              remoteChan.readyState = 'open';
              this.localChannel!.onopen?.();
              remoteChan.onopen?.();
            });
          }
        }
      }

      async addIceCandidate() {}

      close() {
        this.signalingState = 'closed';
        this.connectionState = 'closed';
        this.localChannel?.close();
      }
    }

    (globalThis as any).WebSocket = VirtualWebSocket;
    (globalThis as any).RTCPeerConnection = VirtualRTCPeerConnection;
    (globalThis as any).RTCSessionDescription = class {
      constructor(init: any) {
        Object.assign(this, init);
      }
    };
    (globalThis as any).RTCIceCandidate = class {
      constructor(init: any) {
        Object.assign(this, init);
      }
    };

    (globalThis as any).fetch = async (url: string) => {
      env.httpRequestsCount++;
      const blob = env.httpAssets.get(url);
      if (!blob) {
        return { ok: false, status: 404, blob: async () => new Blob([]) };
      }
      return {
        ok: true,
        status: 200,
        blob: async () => blob,
      };
    };
  }
}

test('End-to-End: Peer A fetches via HTTP, Peer B streams asset from Peer A over WebRTC P2P Mesh, and subsequent requests hit local cache', async () => {
  const net = new VirtualNetworkEnvironment();
  net.install();

  const testUrl = 'https://cdn.example.com/models/avatar.bin';
  const payloadText = 'ShadowCast E2E Mesh Transfer Payload '.repeat(40);
  const expectedBlob = new Blob([new TextEncoder().encode(payloadText)], {
    type: 'application/octet-stream',
  });
  net.httpAssets.set(testUrl, expectedBlob);

  const peerA = new ShadowCast({
    signalingUrl: 'ws://virtual/ws',
    chunkSize: 128,
    peerWaitTimeout: 50,
    p2pTimeout: 1000,
    cache: { driver: 'memory' },
  });

  const peerB = new ShadowCast({
    signalingUrl: 'ws://virtual/ws',
    chunkSize: 128,
    peerWaitTimeout: 200,
    p2pTimeout: 1000,
    cache: { driver: 'memory' },
  });

  try {
    // 1. Peer A connects alone and fetches asset (resolves via HTTP fallback)
    await peerA.connect('e2e-room');
    const blobA = await peerA.requestAssetBlob(testUrl);
    assert.equal(await blobA.text(), payloadText);
    assert.equal(net.httpRequestsCount, 1);
    assert.equal(peerA.stats.totalHttpBytes, expectedBlob.size);

    // 2. Peer B connects to the same room and establishes WebRTC DataChannel with Peer A
    await peerB.connect('e2e-room');
    const connected = await peerB.waitForPeers({ timeout: 500 });
    assert.equal(connected, true, 'Peer B should establish open DataChannel with Peer A');
    assert.equal(peerB.peersCount, 1);

    let p2pCompleteSource = '';
    peerB.on('transfer:complete', ({ source }) => {
      p2pCompleteSource = source;
    });

    // 3. Peer B requests the asset -> streamed 100% over P2P from Peer A without touching HTTP!
    const blobB = await peerB.requestAssetBlob(testUrl);
    assert.equal(await blobB.text(), payloadText);
    assert.equal(p2pCompleteSource, 'p2p');
    assert.equal(net.httpRequestsCount, 1, 'Origin HTTP server must not be hit by Peer B');
    assert.equal(peerB.cumulativeBandwidthSaved, expectedBlob.size);

    // 4. Subsequent request on Peer B hits local cache
    await peerB.requestAsset(testUrl);
    assert.equal(peerB.stats.cacheHits, 1);
  } finally {
    peerA.destroy();
    peerB.destroy();
  }
});

test('End-to-End: Multi-peer swarm parallel transfer across 3 connected peers', async () => {
  const net = new VirtualNetworkEnvironment();
  net.install();

  const testUrl = 'https://cdn.example.com/video/segment.mp4';
  const payloadText = 'MultiPeerSwarmChunkData_'.repeat(30);
  const expectedBlob = new Blob([new TextEncoder().encode(payloadText)], {
    type: 'video/mp4',
  });
  net.httpAssets.set(testUrl, expectedBlob);

  const seeder1 = new ShadowCast({
    signalingUrl: 'ws://virtual/ws',
    chunkSize: 64,
    peerWaitTimeout: 30,
    p2pTimeout: 1000,
    cache: { driver: 'memory' },
  });

  const seeder2 = new ShadowCast({
    signalingUrl: 'ws://virtual/ws',
    chunkSize: 64,
    peerWaitTimeout: 150,
    p2pTimeout: 1000,
    cache: { driver: 'memory' },
  });

  const leecher = new ShadowCast({
    signalingUrl: 'ws://virtual/ws',
    chunkSize: 64,
    peerWaitTimeout: 150,
    p2pTimeout: 1000,
    cache: { driver: 'memory' },
  });

  try {
    await seeder1.connect('swarm-room');
    await seeder1.requestAssetBlob(testUrl);
    assert.equal(net.httpRequestsCount, 1);

    await seeder2.connect('swarm-room');
    await seeder2.waitForPeers({ timeout: 300 });
    await seeder2.requestAssetBlob(testUrl);
    assert.equal(net.httpRequestsCount, 1);

    await leecher.connect('swarm-room');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(leecher.peersCount, 2);

    const downloaded = await leecher.requestAssetBlob(testUrl);
    assert.equal(await downloaded.text(), payloadText);
    assert.equal(downloaded.type, 'video/mp4');
    assert.equal(net.httpRequestsCount, 1, 'Leecher must download from swarm without HTTP');
  } finally {
    seeder1.destroy();
    seeder2.destroy();
    leecher.destroy();
  }
});

test('End-to-End: P2P timeout falls back cleanly to HTTP when peers do not have the asset', async () => {
  const net = new VirtualNetworkEnvironment();
  net.install();

  const uncachedUrl = 'https://cdn.example.com/assets/rare.wasm';
  const expectedBlob = new Blob([new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])], {
    type: 'application/wasm',
  });
  net.httpAssets.set(uncachedUrl, expectedBlob);

  const peerA = new ShadowCast({
    signalingUrl: 'ws://virtual/ws',
    peerWaitTimeout: 50,
    p2pTimeout: 80, // Short P2P timeout for fast test
    cache: { driver: 'memory' },
  });

  const peerB = new ShadowCast({
    signalingUrl: 'ws://virtual/ws',
    peerWaitTimeout: 50,
    p2pTimeout: 80,
    cache: { driver: 'memory' },
  });

  try {
    await peerA.connect('timeout-room');
    await peerB.connect('timeout-room');
    await peerB.waitForPeers({ timeout: 200 });

    // Neither Peer A nor Peer B has uncachedUrl; Peer B requests it -> times out P2P after 80ms -> falls back to HTTP
    const blob = await peerB.requestAssetBlob(uncachedUrl);
    assert.equal(blob.size, 8);
    assert.equal(net.httpRequestsCount, 1);
    assert.equal(peerB.stats.totalHttpBytes, 8);
  } finally {
    peerA.destroy();
    peerB.destroy();
  }
});

test('End-to-End: Graceful HTTP fallback when signaling server is unreachable and request coalescing for concurrent calls', async () => {
  const net = new VirtualNetworkEnvironment();
  net.signalingOnline = false; // Simulate signaling outage
  net.install();

  const testUrl = 'https://cdn.example.com/images/banner.jpg';
  const expectedBlob = new Blob([new TextEncoder().encode('Banner Image Data')], {
    type: 'image/jpeg',
  });
  net.httpAssets.set(testUrl, expectedBlob);

  const client = new ShadowCast({
    signalingUrl: 'ws://offline-server/ws',
    cache: { driver: 'memory' },
  });

  try {
    // Issue 3 concurrent requests for the same URL while signaling is offline
    const [url1, url2, url3] = await Promise.all([
      client.requestAsset(testUrl),
      client.requestAsset(testUrl),
      client.requestAsset(testUrl),
    ]);

    assert.equal(url1, url2);
    assert.equal(url2, url3);
    assert.equal(
      net.httpRequestsCount,
      1,
      'Concurrent requests for the same asset must be coalesced into a single transfer'
    );
    assert.equal(client.stats.totalHttpBytes, expectedBlob.size);
  } finally {
    client.destroy();
  }
});
