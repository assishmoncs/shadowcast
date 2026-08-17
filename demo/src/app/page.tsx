'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ShadowCast, TransferSource, ConnectionState } from 'shadowcast';
import PeerGraph from './components/PeerGraph';

interface TransferLogEntry {
  id: string;
  url: string;
  source: TransferSource;
  bytes: number;
  durationMs: number;
  timestamp: string;
}

const ASSET_PRESETS = [
  {
    name: 'Nebula Space',
    url: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?q=80&w=2072&auto=format&fit=crop',
  },
  {
    name: 'Mountain Lake',
    url: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?q=80&w=2070&auto=format&fit=crop',
  },
  {
    name: 'Cyber City',
    url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=2084&auto=format&fit=crop',
  },
];

const GALLERY_PRESETS = [
  'https://images.unsplash.com/photo-1451187580459-43490279c0fa?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1506744038136-46273834b3fb?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=800&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1534447677768-be436bb09401?q=80&w=800&auto=format&fit=crop',
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export default function ShadowCastDemo() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>('connecting');
  const [peersCount, setPeersCount] = useState(0);
  const [bandwidthSaved, setBandwidthSaved] = useState(0);
  const [cacheHits, setCacheHits] = useState(0);
  const [totalTransfers, setTotalTransfers] = useState(0);
  const [isSwRegistered, setIsSwRegistered] = useState(false);

  const [selectedUrl, setSelectedUrl] = useState(ASSET_PRESETS[0].url);
  const [assetUrl, setAssetUrl] = useState('');
  const [galleryUrls, setGalleryUrls] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [currentSource, setCurrentSource] = useState<TransferSource | null>(null);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [lastBytes, setLastBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [logs, setLogs] = useState<TransferLogEntry[]>([]);

  const scRef = useRef<ShadowCast | null>(null);

  useEffect(() => {
    const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL || 'ws://localhost:8080/ws';
    const sc = new ShadowCast({
      signalingUrl,
      cache: {
        driver: 'indexeddb',
        maxSizeBytes: 250 * 1024 * 1024,
      },
    });
    scRef.current = sc;

    // Connect to room
    sc.connect('shadowcast-global');

    // Subscribe to real telemetry events
    const unsubStatus = sc.on('connection:status', ({ state }) => {
      setConnectionStatus(state);
    });

    const unsubPeerJoin = sc.on('peer:join', ({ totalPeers }) => {
      setPeersCount(totalPeers);
    });

    const unsubPeerLeave = sc.on('peer:leave', ({ totalPeers }) => {
      setPeersCount(totalPeers);
    });

    const unsubProgress = sc.on('transfer:progress', ({ percent }) => {
      setProgressPercent(percent);
    });

    const unsubComplete = sc.on('transfer:complete', ({ url, source, durationMs, bytes }) => {
      setCurrentSource(source);
      setLastDurationMs(durationMs);
      setLastBytes(bytes);
      setProgressPercent(100);
      setTotalTransfers((prev) => prev + 1);

      setLogs((prev) => [
        {
          id: crypto.randomUUID(),
          url: url.slice(0, 45) + '...',
          source,
          bytes,
          durationMs,
          timestamp: new Date().toLocaleTimeString(),
        },
        ...prev.slice(0, 9),
      ]);
    });

    const unsubSaved = sc.on('bandwidth:saved', ({ cumulativeBytes }) => {
      setBandwidthSaved(cumulativeBytes);
    });

    const unsubCacheHit = () => {
      setCacheHits((prev) => prev + 1);
      setCurrentSource('cache');
    };
    const unsubHit = sc.on('cache:hit', unsubCacheHit);

    // Check if SW is already registered
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        setIsSwRegistered(!!reg);
      });
    }

    return () => {
      unsubStatus();
      unsubPeerJoin();
      unsubPeerLeave();
      unsubProgress();
      unsubComplete();
      unsubSaved();
      unsubHit();
      sc.destroy();
    };
  }, []);

  const handleToggleServiceWorker = async () => {
    if (!scRef.current) return;

    if (isSwRegistered) {
      const success = await scRef.current.unregisterServiceWorker();
      if (success) {
        setIsSwRegistered(false);
      }
    } else {
      const reg = await scRef.current.registerServiceWorker('/sw.js');
      if (reg) {
        setIsSwRegistered(true);
      }
    }
  };

  const handleClearCache = async () => {
    if (!scRef.current) return;
    await scRef.current.clearCache();
    setAssetUrl('');
    setGalleryUrls([]);
    setCurrentSource(null);
    setCacheHits(0);
  };

  const handleLoadAsset = async () => {
    if (!scRef.current || !selectedUrl) return;

    setIsLoading(true);
    setError(null);
    setProgressPercent(0);
    setCurrentSource(null);
    setLastDurationMs(null);
    setGalleryUrls([]);

    try {
      const blobUrl = await scRef.current.requestAsset(selectedUrl);
      setAssetUrl(blobUrl);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to transfer asset');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadSwarmGallery = async () => {
    if (!scRef.current) return;

    setIsLoading(true);
    setError(null);
    setProgressPercent(0);
    setCurrentSource(null);
    setAssetUrl('');

    try {
      const promises = GALLERY_PRESETS.map((url) => scRef.current!.requestAsset(url));
      const urls = await Promise.all(promises);
      setGalleryUrls(urls);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to transfer swarm gallery');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="dashboard-container">
      <div className="header">
        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <div className="header-badge" style={{ margin: 0 }}>
            ⚡ Real WebRTC Mesh CDN
          </div>
          <Link
            href="/playground"
            style={{
              padding: '0.35rem 0.85rem',
              background: 'rgba(56, 189, 248, 0.1)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              borderRadius: '9999px',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: 'var(--accent-blue)',
              textDecoration: 'none',
            }}
          >
            🛠️ Open API Playground →
          </Link>
        </div>
        <h1>ShadowCast</h1>
        <p>Decentralized client-side P2P static asset streaming engine</p>
      </div>

      <div className="tip-banner">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="16" x2="12" y2="12"></line>
          <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
        <span>
          <strong>Pro-Tip:</strong> Open this dashboard in two side-by-side tabs. Once connected, Tab A
          will stream cached asset chunks directly to Tab B over WebRTC DataChannels!
        </span>
      </div>

      <div className="grid">
        {/* Left Column: Network State & Controls */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
              Live Mesh Topology
            </div>
            <div className={`status-indicator ${connectionStatus}`}>
              <div className="status-dot" />
              {connectionStatus}
            </div>
          </div>

          {/* Interactive Animated Peer Graph */}
          <PeerGraph peersCount={peersCount} activeSource={currentSource} isStreaming={isLoading} />

          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Active Mesh Peers</div>
              <div className="stat-value blue">{peersCount}</div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Origin Bandwidth Saved</div>
              <div className="stat-value highlight">{formatBytes(bandwidthSaved)}</div>
            </div>

            <div className="stat-card">
              <div className="stat-label">IndexedDB Cache Hits</div>
              <div className="stat-value">{cacheHits}</div>
            </div>

            <div className="stat-card">
              <div className="stat-label">Total Transfers</div>
              <div className="stat-value">{totalTransfers}</div>
            </div>
          </div>

          {/* Service Worker & Cache Controls */}
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--panel-border)',
              borderRadius: '12px',
              padding: '0.85rem 1rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Persistent Cache & Interception</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                IndexedDB driver active (cross-session persistent)
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={handleClearCache}
                style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#f87171',
                  padding: '0.4rem 0.75rem',
                  borderRadius: '8px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Clear Cache
              </button>
              <button
                onClick={handleToggleServiceWorker}
                style={{
                  background: isSwRegistered ? 'rgba(0, 255, 159, 0.15)' : 'rgba(255, 255, 255, 0.08)',
                  border: `1px solid ${isSwRegistered ? 'rgba(0, 255, 159, 0.35)' : 'var(--panel-border)'}`,
                  color: isSwRegistered ? 'var(--accent-color)' : 'var(--text-secondary)',
                  padding: '0.4rem 0.75rem',
                  borderRadius: '8px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {isSwRegistered ? 'SW Active ✓' : 'Enable SW'}
              </button>
            </div>
          </div>

          <div className="url-controls">
            <div className="stat-label">Choose Preset or Enter Custom URL</div>
            <div className="preset-buttons">
              {ASSET_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  className={`preset-btn ${selectedUrl === preset.url ? 'active' : ''}`}
                  onClick={() => setSelectedUrl(preset.url)}
                >
                  {preset.name}
                </button>
              ))}
            </div>

            <div className="input-row">
              <input
                type="text"
                className="url-input"
                value={selectedUrl}
                onChange={(e) => setSelectedUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <button className="btn" onClick={handleLoadAsset} disabled={isLoading || !selectedUrl}>
              {isLoading ? 'Streaming Chunks...' : 'Request Single Asset'}
            </button>
            <button
              className="btn"
              onClick={handleLoadSwarmGallery}
              disabled={isLoading}
              style={{
                background: 'rgba(56, 189, 248, 0.15)',
                border: '1px solid rgba(56, 189, 248, 0.35)',
                color: 'var(--accent-blue)',
              }}
            >
              {isLoading ? 'Streaming...' : 'Parallel Swarm Gallery'}
            </button>
          </div>

          {isLoading && (
            <div className="progress-section">
              <div className="progress-header">
                <span>Transferring chunks</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="progress-bar-bg">
                <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {error && <div className="error-message">{error}</div>}

          {/* Activity Log */}
          {logs.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <div className="stat-label" style={{ marginBottom: '0.5rem' }}>
                Recent Transfer Activity
              </div>
              <table className="log-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Source</th>
                    <th>Size</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td style={{ color: 'var(--text-muted)' }}>{log.timestamp}</td>
                      <td>
                        <span className={`asset-meta-badge ${log.source}`}>{log.source}</span>
                      </td>
                      <td>{formatBytes(log.bytes)}</td>
                      <td>{log.durationMs}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right Column: Asset Preview */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              Resolved Asset Stream
            </div>

            {currentSource && (
              <span className={`asset-meta-badge ${currentSource}`}>
                Source: {currentSource === 'p2p' ? 'P2P Mesh ⚡' : currentSource === 'cache' ? 'IndexedDB Cache 💾' : 'HTTP Origin 🌐'}
              </span>
            )}
          </div>

          <div className="asset-preview-card">
            {galleryUrls.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                {galleryUrls.map((url, i) => (
                  <div
                    key={i}
                    style={{
                      height: '160px',
                      borderRadius: '10px',
                      overflow: 'hidden',
                      border: '1px solid var(--panel-border)',
                      background: 'rgba(0,0,0,0.3)',
                    }}
                  >
                    <img src={url} alt={`Gallery ${i}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="asset-container">
                {isLoading && <div className="loading-spinner" />}

                {!isLoading && !assetUrl && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    No asset requested yet. Click &quot;Request Single Asset&quot; or &quot;Parallel Swarm Gallery&quot;.
                  </span>
                )}

                {!isLoading && assetUrl && <img src={assetUrl} alt="Resolved from Mesh" />}
              </div>
            )}

            {lastBytes !== null && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                <span>Size: <strong>{formatBytes(lastBytes)}</strong></span>
                {lastDurationMs !== null && (
                  <span>Resolved in: <strong>{lastDurationMs} ms</strong></span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
