/**
 * ShadowCast - PeerConnection Wrapper
 */

export interface PeerConnectionCallbacks {
  onIceCandidate: (candidate: RTCIceCandidate) => void;
  onDataChannelMessage: (data: ArrayBuffer | string) => void;
  onDataChannelOpen: () => void;
  onDataChannelClose: () => void;
  onDisconnect: () => void;
}

export class PeerConnection {
  public pc: RTCPeerConnection;
  public dc: RTCDataChannel | null = null;

  constructor(
    public readonly peerId: string,
    iceServers: RTCIceServer[],
    private callbacks: PeerConnectionCallbacks
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.setupPeerConnection();
  }

  private setupPeerConnection(): void {
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onIceCandidate(event.candidate);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) {
        this.callbacks.onDisconnect();
      }
    };

    this.pc.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };
  }

  createDataChannel(label: string = 'asset-transfer'): RTCDataChannel {
    if (!this.dc || this.dc.readyState === 'closed') {
      const channel = this.pc.createDataChannel(label);
      this.setupDataChannel(channel);
    }
    return this.dc!;
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    this.dc = channel;
    this.dc.binaryType = 'arraybuffer';

    this.dc.onopen = () => {
      this.callbacks.onDataChannelOpen();
    };

    this.dc.onmessage = (event) => {
      this.callbacks.onDataChannelMessage(event.data);
    };

    this.dc.onclose = () => {
      this.callbacks.onDataChannelClose();
    };

    this.dc.onerror = (err) => {
      console.error(`[ShadowCast] DataChannel error with ${this.peerId}:`, err);
    };
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription!;
  }

  async handleOffer(sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.pc.localDescription!;
  }

  async handleAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (this.pc.signalingState === 'stable') return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  send(data: string | ArrayBuffer): boolean {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(data as any);
      return true;
    }
    return false;
  }

  get isDataChannelOpen(): boolean {
    return this.dc !== null && this.dc.readyState === 'open';
  }

  close(): void {
    if (this.dc && this.dc.readyState !== 'closed') {
      this.dc.close();
    }
    this.dc = null;

    if (this.pc.signalingState !== 'closed') {
      this.pc.close();
    }
  }
}
