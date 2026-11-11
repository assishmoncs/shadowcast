import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerConnection } from '../mesh/PeerConnection.js';
import { MeshManager } from '../mesh/MeshManager.js';
import { SignalingClient } from '../signaling/SignalingClient.js';

// Mock WebRTC globals for deterministic unit testing in Node.js
function installWebRTCMocks() {
  class MockRTCDataChannel {
    label: string;
    readyState: string = 'connecting';
    binaryType: string = 'arraybuffer';
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: any }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((err: any) => void) | null = null;
    sentMessages: any[] = [];

    constructor(label: string) {
      this.label = label;
    }

    send(data: any) {
      this.sentMessages.push(data);
    }

    close() {
      this.readyState = 'closed';
      this.onclose?.();
    }
  }

  class MockRTCPeerConnection {
    signalingState: string = 'stable';
    connectionState: string = 'new';
    iceConnectionState: string = 'new';
    localDescription: any = null;
    remoteDescription: any = null;
    addedCandidates: any[] = [];
    onicecandidate: ((ev: any) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    ondatachannel: ((ev: any) => void) | null = null;

    createDataChannel(label: string) {
      return new MockRTCDataChannel(label);
    }

    async createOffer() {
      return { type: 'offer', sdp: 'mock-offer-sdp' };
    }

    async createAnswer() {
      return { type: 'answer', sdp: 'mock-answer-sdp' };
    }

    async setLocalDescription(desc: any) {
      this.localDescription = desc;
      if (desc.type === 'offer') {
        this.signalingState = 'have-local-offer';
      } else if (desc.type === 'answer') {
        this.signalingState = 'stable';
      }
    }

    async setRemoteDescription(desc: any) {
      this.remoteDescription = desc;
      if (desc.type === 'offer') {
        this.signalingState = 'have-remote-offer';
      } else if (desc.type === 'answer') {
        this.signalingState = 'stable';
      }
    }

    async addIceCandidate(candidate: any) {
      if (!this.remoteDescription) {
        throw new Error('InvalidStateError: Remote description is not set');
      }
      this.addedCandidates.push(candidate);
    }

    close() {
      this.signalingState = 'closed';
      this.connectionState = 'closed';
    }
  }

  (globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
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
}

test('PeerConnection queues ICE candidates arriving before setRemoteDescription and flushes them after', async () => {
  installWebRTCMocks();

  const peer = new PeerConnection('remote-peer-1', [], {
    onIceCandidate: () => {},
    onDataChannelMessage: () => {},
    onDataChannelOpen: () => {},
    onDataChannelClose: () => {},
    onDisconnect: () => {},
  });

  // Add 2 candidates BEFORE remoteDescription is set — must not throw!
  await peer.addIceCandidate({ candidate: 'cand-1', sdpMid: '0', sdpMLineIndex: 0 });
  await peer.addIceCandidate({ candidate: 'cand-2', sdpMid: '0', sdpMLineIndex: 0 });
  assert.equal((peer.pc as any).addedCandidates.length, 0);

  // Now set remote offer — queued candidates should be flushed automatically
  await peer.handleOffer({ type: 'offer', sdp: 'remote-offer' });
  assert.equal((peer.pc as any).addedCandidates.length, 2);
});

test('MeshManager initiates offers deterministically and resolves waitForPeers on cleanup', async () => {
  installWebRTCMocks();

  const sentOffers: string[] = [];
  const fakeSignaling = {
    sendOffer: (target: string) => {
      sentOffers.push(target);
      return true;
    },
    sendAnswer: () => true,
    sendIceCandidate: () => true,
  } as unknown as SignalingClient;

  const mesh = new MeshManager('peer-b', fakeSignaling, [], {
    onDataMessage: () => {},
  });

  // 'peer-b' < 'peer-c' is true, 'peer-b' < 'peer-a' is false
  await mesh.handleSignalingMessage({
    type: 'room-peers',
    peers: ['peer-a', 'peer-c'],
  });

  assert.deepEqual(sentOffers, ['peer-c']);

  // waitForPeers should resolve false immediately when cleanup() is called
  const waitPromise = mesh.waitForPeers(10000);
  mesh.cleanup();
  const ready = await waitPromise;
  assert.equal(ready, false);
});
