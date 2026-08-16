/**
 * ShadowCast - Service Worker Interception Types
 */

export interface ServiceWorkerOptions {
  scope?: string;
  includePatterns?: (string | RegExp)[];
  excludePatterns?: (string | RegExp)[];
  timeoutMs?: number;
}

export interface SWAssetRequestMessage {
  type: 'SHADOWCAST_SW_REQUEST';
  id: string;
  url: string;
}

export interface SWAssetResponseMessage {
  type: 'SHADOWCAST_SW_RESPONSE';
  id: string;
  success: boolean;
  blob?: Blob;
  mimeType?: string;
  error?: string;
}

export const DEFAULT_SW_INCLUDE_PATTERNS: RegExp[] = [
  /\.(png|jpe?g|gif|webp|svg|avif|ico|mp4|webm|mp3|wasm|woff2?)$/i,
];
