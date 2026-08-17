/**
 * ShadowCast - Core Types and Interfaces
 */

import { CacheConfig } from '../cache/types.js';

export interface Chunk {
  index: number;
  total: number;
  assetId: string;
  chunkHash?: string;
  assetHash?: string;
  data?: string;
}

export interface ChunkBuffer {
  received: Map<number, ArrayBuffer>;
  total: number;
  mimeType: string;
  assetHash?: string;
  chunkHashes: Map<number, string>;
}

export interface PendingAsset {
  url: string;
  startTime: number;
  resolve: (url: string) => void;
  reject?: (error: Error) => void;
}

export interface ShadowCastConfig {
  signalingUrl?: string;
  defaultRoom?: string;
  iceServers?: RTCIceServer[];
  chunkSize?: number;
  p2pTimeout?: number;
  peerWaitTimeout?: number;
  verifyIntegrity?: boolean;
  cache?: CacheConfig;
}

export interface SignalingMessagePayload {
  type: string;
  room?: string;
  from?: string;
  target?: string;
  id?: string;
  peers?: string[];
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  [key: string]: unknown;
}

export interface SwarmBitfieldMessage {
  type: 'swarm-bitfield';
  assetId: string;
  url: string;
  totalChunks: number;
  availableChunks: number[];
  assetHash: string;
  mimeType: string;
}

export interface SwarmPieceRequestMessage {
  type: 'swarm-piece-request';
  assetId: string;
  indices: number[];
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type TransferSource = 'p2p' | 'http' | 'cache';

export interface ShadowCastStats {
  peersCount: number;
  isConnected: boolean;
  cumulativeBandwidthSaved: number;
  totalP2PBytes: number;
  totalHttpBytes: number;
  cacheHits: number;
  transfersCount: number;
}

export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KB
export const DEFAULT_ROOM = 'shadowcast-global';
export const DEFAULT_SIGNALING_URL = 'ws://localhost:8080/ws';
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
