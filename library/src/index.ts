/**
 * ShadowCast - P2P WebRTC Asset Delivery Client
 * Public API Entry Point
 */

export { ShadowCast } from './core/ShadowCast.js';
export { EventEmitter } from './core/events.js';
export type { ShadowCastEventMap, EventListener } from './core/events.js';
export { CacheManager } from './cache/CacheManager.js';
export { MemoryCache } from './cache/MemoryCache.js';
export { IndexedDBCache } from './cache/IndexedDBCache.js';
export { LRUPolicy } from './cache/LRUPolicy.js';
export type {
  CacheConfig,
  CacheEntry,
  CacheEntryMetadata,
  CacheStore,
} from './cache/types.js';
export {
  DEFAULT_MAX_CACHE_SIZE,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_CACHE_TTL,
} from './cache/types.js';

export { SignalingClient } from './signaling/SignalingClient.js';
export { MeshManager } from './mesh/MeshManager.js';
export { PeerConnection } from './mesh/PeerConnection.js';
export { ChunkSender } from './transfer/ChunkSender.js';
export { ChunkReceiver } from './transfer/ChunkReceiver.js';
export { PiecePicker } from './transfer/PiecePicker.js';
export { ServiceWorkerManager } from './interception/ServiceWorkerManager.js';
export type { ServiceWorkerOptions, SWAssetRequestMessage, SWAssetResponseMessage } from './interception/types.js';
export { hashBuffer, hashBlob, hashString } from './utils/hash.js';
export { getAssetId } from './utils/url.js';
export type {
  Chunk,
  ChunkBuffer,
  PendingAsset,
  ShadowCastConfig,
  ShadowCastStats,
  SignalingMessagePayload,
  SwarmBitfieldMessage,
  SwarmPieceRequestMessage,
  ConnectionState,
  TransferSource,
} from './core/types.js';
export {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_ROOM,
  DEFAULT_SIGNALING_URL,
  DEFAULT_ICE_SERVERS,
} from './core/types.js';
