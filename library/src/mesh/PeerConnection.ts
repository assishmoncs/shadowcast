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
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private readonly writableWaiters = new Set<(writable: boolean) => void>();
  private closed = false;

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
      if (!this.closed && event.candidate) {
        this.callbacks.onIceCandidate(event.candidate);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (['failed', 'closed'].includes(this.pc.connectionState)) {
        this.callbacks.onDisconnect();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.closed) return;
      if (['failed', 'closed'].includes(this.pc.iceConnectionState)) {
        this.callbacks.onDisconnect();
      }
    };

    this.pc.ondatachannel = (event) => {
      if (!this.closed && event.channel) {
        this.setupDataChannel(event.channel);
      }
    };
  }

  createDataChannel(label: string = 'asset-transfer'): RTCDataChannel {
    if (!this.dc || this.dc.readyState === 'closed' || this.dc.readyState === 'closing') {
      const channel = this.pc.createDataChannel(label, { ordered: true });
      this.setupDataChannel(channel);
    }
    return this.dc!;
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    this.dc = channel;
    this.dc.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 512 * 1024;
    channel.onbufferedamountlow = () => this.notifyWritable(true);

    this.dc.onopen = () => {
      if (!this.closed) {
        this.callbacks.onDataChannelOpen();
      }
    };

    this.dc.onmessage = (event) => {
      if (!this.closed) {
        this.callbacks.onDataChannelMessage(event.data);
      }
    };

    this.dc.onclose = () => {
      if (!this.closed) {
        this.callbacks.onDataChannelClose();
      }
    };

    this.dc.onerror = (err) => {
      if (!this.closed) {
        console.error(`[ShadowCast] DataChannel error with ${this.peerId}:`, err);
      }
    };
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription || offer;
  }

  async handleOffer(sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const desc = typeof RTCSessionDescription !== 'undefined' ? new RTCSessionDescription(sdp) : sdp;
    await this.pc.setRemoteDescription(desc);
    await this.flushPendingIceCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.pc.localDescription || answer;
  }

  async handleAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (this.pc.signalingState === 'stable') return;
    const desc = typeof RTCSessionDescription !== 'undefined' ? new RTCSessionDescription(sdp) : sdp;
    await this.pc.setRemoteDescription(desc);
    await this.flushPendingIceCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed || this.pc.signalingState === 'closed') return;

    // Queue ICE candidates that arrive before remoteDescription is set
    if (!this.pc.remoteDescription) {
      if (this.pendingIceCandidates.length < 128) this.pendingIceCandidates.push(candidate);
      return;
    }

    try {
      const ice = typeof RTCIceCandidate !== 'undefined' ? new RTCIceCandidate(candidate) : candidate;
      await this.pc.addIceCandidate(ice);
    } catch (err) {
      console.warn(`[ShadowCast] Failed to add ICE candidate for ${this.peerId}:`, err);
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.pc.remoteDescription || this.pendingIceCandidates.length === 0) {
      return;
    }
    const candidates = this.pendingIceCandidates.splice(0, this.pendingIceCandidates.length);
    for (const candidate of candidates) {
      await this.addIceCandidate(candidate);
    }
  }

  send(data: string | ArrayBuffer): boolean {
    if (!this.closed && this.dc && this.dc.readyState === 'open') {
      try {
        if (typeof data === 'string') this.dc.send(data);
        else this.dc.send(data);
        return true;
      } catch (err) {
        console.warn(`[ShadowCast] Failed to send over DataChannel to ${this.peerId}:`, err);
        this.callbacks.onDisconnect();
        return false;
      }
    }
    return false;
  }

  async waitForWritable(bytes: number): Promise<boolean> {
    if (!this.isDataChannelOpen) return false;
    const maximum = this.pc.sctp?.maxMessageSize;
    if (maximum && bytes > maximum) return false;
    if (!(this.dc!.bufferedAmount > this.dc!.bufferedAmountLowThreshold)) return true;
    return new Promise<boolean>((resolve) => {
      const done = (writable: boolean) => {
        clearTimeout(timer);
        this.writableWaiters.delete(done);
        resolve(writable);
      };
      const timer = setTimeout(() => done(false), 5000);
      this.writableWaiters.add(done);
    });
  }

  private notifyWritable(writable: boolean): void {
    for (const waiter of this.writableWaiters) waiter(writable);
  }

  get isDataChannelOpen(): boolean {
    return !this.closed && this.dc !== null && this.dc.readyState === 'open';
  }

  close(): void {
    this.closed = true;
    this.notifyWritable(false);
    this.pendingIceCandidates = [];

    if (this.dc) {
      const channel = this.dc;
      this.dc = null;
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onbufferedamountlow = null;
      try {
        if (channel.readyState !== 'closed') {
          channel.close();
        }
      } catch {
        // Ignore close errors
      }
    }

    try {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.ondatachannel = null;
      if (this.pc.signalingState !== 'closed') {
        this.pc.close();
      }
    } catch {
      // Ignore close errors
    }
  }
}
