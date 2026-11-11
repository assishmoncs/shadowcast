# ShadowCast

ShadowCast is a browser library for sharing public static assets over WebRTC DataChannels. It looks for a local cached copy, tries eligible peers in the same signaling room, and fetches from the HTTP origin when the swarm cannot supply the asset.

The repository contains the ESM library in `library/`, the Go WebSocket signaling service in `signaling/`, and a Next.js dashboard and API playground in `demo/`. The signaling service exchanges connection setup messages. Asset bytes travel over WebRTC or HTTP.

## Run locally

### Docker Compose

```sh
docker compose up --build
```

Open the [dashboard](http://localhost:3000) or the [API playground](http://localhost:3000/playground). The stack publishes the demo on port 3000 and signaling on port 8080, both on loopback. Set `SHADOWCAST_DEMO_PORT` before starting Compose to use a different dashboard port.

To see peer delivery, open the dashboard in two separate browser profiles or in a regular window and a private window. In the first window, choose **Local Sample** and click **Request Single Asset**. Wait for both windows to show a connected peer, then request the same asset in the second window. The second window should show **P2P Mesh**. In either window, enable the service worker and request `/sample.png` with an ordinary same-origin browser fetch to exercise the interception path.

### Develop from source

Install Node.js 24 and Go 1.27.4 or a later 1.27 patch release. From the repository root, install the npm workspaces using the root lockfile.

```sh
npm ci
```

Run the signaling service in one terminal and the demo in another. Set `ALLOWED_ORIGIN` in the signaling process to match the demo's browser origin.

```sh
# Bash
cd signaling
ALLOWED_ORIGIN=http://localhost:3000 go run .
```

```powershell
# PowerShell
Set-Location signaling
$env:ALLOWED_ORIGIN = 'http://localhost:3000'
go run .
```

```sh
# Repository root
npm run dev:demo
```

`npm run dev:library` watches the TypeScript library. `npm run build` produces library JavaScript and declarations, copies the library service worker into the demo, and builds the demo. Run the production demo locally with `npm start -w demo`. Set `NEXT_PUBLIC_SIGNALING_URL` before building when the browser should use a different WebSocket endpoint.

## Use the library

Import `ShadowCast` from the ESM package. For each public immutable asset that peers may serve, provide its SHA-256 digest and MIME type from a trusted build manifest. Generate the digest from the bytes you deploy to the origin. A new asset version should use a new URL or updated manifest entry.

```ts
import { ShadowCast } from 'shadowcast';
import { assetIntegrity } from './generated-asset-manifest.js';

// assetIntegrity maps URLs to { sha256: '<64 hex characters>', mimeType: 'image/webp' }.
const client = new ShadowCast({
  signalingUrl: 'wss://signal.example.com/ws',
  defaultRoom: 'site-assets-v1',
  assetIntegrity,
});

const unsubscribe = client.on('transfer:complete', ({ source, bytes, durationMs }) => {
  console.info({ source, bytes, durationMs });
});

// Optional. A pinned asset request attempts to connect automatically.
await client.connect();

// Use the Blob directly when you manage the asset lifecycle yourself.
const blob = await client.requestAssetBlob('/assets/banner.webp?v=2');

// Each requestAsset call returns an ObjectURL owned by this client.
const objectUrl = await client.requestAsset('/assets/banner.webp?v=2');
const image = document.querySelector<HTMLImageElement>('#banner')!;
image.src = objectUrl;

// When the image is removed or replaced
client.releaseAsset(objectUrl);
unsubscribe();
client.destroy();
```

`connect(room)` resolves after the signaling service accepts the room. Calling it with a different room closes the previous room's peer connections. `waitForPeers({ timeout })` resolves to a boolean that indicates whether a DataChannel opened. `stats` reports peer count, connection state, origin and peer bytes, cache hits, and completed network transfers.

Concurrent requests for the same normalized URL share the Blob transfer. HTTP requests omit credentials, and cross-origin assets must allow the calling origin through CORS. URL fragments are stripped, and query strings remain part of the asset identity. The cache applies its configured TTL and respects origin `max-age`, `Age`, and `Expires` where visible. Responses marked private, requiring revalidation through `no-cache`, or disallowing storage are skipped, as are responses with `Vary` fields beyond `Accept-Encoding`. IndexedDB failures switch the instance to memory storage.

`clearCache()` clears the active cache and revokes ObjectURLs owned by the client. `destroy()` cancels connection setup and transfers, detaches the service-worker message handler, and revokes ObjectURLs. Persistent entries remain available across instances. Use `unregisterServiceWorker()` to remove the browser registration explicitly.

### Service worker

Copy the exported worker to a same-origin URL. This example writes to a typical web application's public directory.

```sh
node -e "require('node:fs').copyFileSync(require.resolve('shadowcast/sw'), 'public/sw.js')"
```

Register it from the page instance that owns the asset manifest.

```ts
await client.registerServiceWorker('/sw.js', {
  scope: '/',
  includePatterns: [/\.(webp|png)$/i],
  timeoutMs: 8000,
});
```

The module worker uses the requesting tab's configuration and asks that tab for a pinned asset from its cache or swarm. It forwards the original request to HTTP when interception cannot fulfill it. Navigation, cross-origin, authorization, Range, conditional, integrity-bearing, and non-default cache-mode requests follow the browser's normal fetch path. Serve the worker over HTTPS or loopback. Give it a dedicated scope if the application already has another worker.

### Client configuration

| Option | Default | Behavior |
| --- | --- | --- |
| `signalingUrl` | `ws://localhost:8080/ws` | WebSocket endpoint |
| `defaultRoom` | `shadowcast-global` | Initial signaling room |
| `iceServers` | Public Google STUN servers | RTC configuration. Supply TURN servers for relay connectivity |
| `assetIntegrity` | Empty | Public asset URL to SHA-256 and MIME type mapping |
| `allowUnverifiedPeers` | `false` | Demo mode for unpinned P2P assets. Peer-provided digests detect corruption but cannot establish authenticity |
| `verifyIntegrity` | `true` | Verify per-chunk and full-asset peer digests. Manifest verification is always enforced |
| `chunkSize` | 64 KiB | Positive integer chunk size, capped at 64 KiB |
| `peerWaitTimeout` | 1,500 ms | Time to wait for a DataChannel after joining. Zero skips the wait |
| `p2pTimeout` | 5,000 ms | Time to collect advertisements and receive an asset once peers are available |
| `httpTimeout` | 30,000 ms | HTTP request and body-read deadline |
| `cache.driver` | `indexeddb` | Persistent IndexedDB or in-memory storage |
| `cache.maxSizeBytes` | 250 MiB | Cache byte budget |
| `cache.maxEntries` | 500 | Cache entry budget |
| `cache.ttlMs` | 7 days | Maximum local age. Zero disables the local TTL while preserving origin expiry |

The swarm accepts assets up to 64 MiB and 4,096 chunks per asset, with up to eight simultaneous downloads per client. Larger assets can still use HTTP. Compatible advertisements share the same digest and chunk layout. The scheduler distributes requested pieces across available peers and reassigns their unfinished pieces when they disconnect.

## Deploy signaling

Run the signaling binary behind a TLS proxy that supports WebSocket upgrades and keeps idle connections open across 30-second pings. Set `ALLOWED_ORIGIN` to the exact browser origins and configure `wss://` in the client. Use versioned immutable public assets and a deployment-controlled manifest. Keep the demo's unverified-peer mode confined to public test assets.

Use a TURN service with short-lived credentials for users behind restrictive NATs or firewalls. Supply the credentials through `iceServers`. The Compose stack runs the demo and signaling service.

Rooms live in the signaling process. When running multiple replicas, route all connections for a room to the same instance. The service applies admission and relay limits, and disconnects peers that cannot consume the bounded outbound queue.

| Variable | Default | Behavior |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and WebSocket listening port |
| `ALLOWED_ORIGIN` | Same-host browser origins | Comma-separated origin allowlist. `*` accepts any origin |
| `AUTH_TOKEN` | Empty | Shared secret accepted as `X-Auth-Token` or `?token=`. Browser WebSockets use the query option |
| `MAX_CONNECTIONS` | `1000` | Total WebSocket connection limit, including clients outside rooms |
| `MAX_ROOMS` | `1000` | Concurrent room limit |
| `MAX_CLIENTS_PER_ROOM` | `100` | Room membership limit |
| `RATE_LIMIT_PER_SEC` | `50` | Message refill rate per client, with burst capacity up to twice that rate |
| `READ_LIMIT_BYTES` | `65536` | Maximum incoming WebSocket message size |

Use `GET /healthz` for liveness, `GET /ready` for readiness and current counts, and `GET /metrics` for Prometheus metrics. Put the probes and metrics behind the appropriate network boundary. If using query-string authentication, redact tokens in proxy access logs. Room names are routing identifiers. A deployment that needs per-user room authorization should enforce it at its signaling boundary.

## Verify changes

From the repository root:

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The TypeScript suite covers hashing, URL identity, IndexedDB migration and concurrent eviction, peer scheduling, cancellation, cache policy, and simulated mesh transfers. The Chromium suite builds the real dashboard, starts Go signaling and Next.js on ports 8080 and 3100, and exercises WebRTC transfer across separate browser contexts and service-worker fetch behavior.

From `signaling/`:

```sh
go mod verify
go vet ./...
go test -race -cover ./...
go build -mod=readonly ./...
```

The Go suite uses real loopback WebSockets for admission, relay, isolation, capacity, authentication, and shutdown tests. CI also runs the npm audit and builds and smoke-tests the Compose images.

## Upgrade notes

- Configure `assetIntegrity` to enable trusted peer delivery. Unpinned asset requests use anonymous HTTP and local cache by default.
- Copy the worker from `shadowcast/sw` when updating the library. The worker now serves pinned assets through the initiating page and delegates HTTP fallback to the original request.
- The client starts with a separate cache namespace for anonymous assets. The standalone `IndexedDBCache` API migrates existing version 1 databases in place.
- Release each ObjectURL after use, or let `destroy()` revoke the URLs for that instance.

## License

MIT. See [LICENSE](LICENSE).
