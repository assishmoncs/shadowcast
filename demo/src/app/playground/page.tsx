'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ShadowCast } from 'shadowcast';

export default function PlaygroundPage() {
  const [logs, setLogs] = useState<string[]>([]);
  const [statsJson, setStatsJson] = useState<string>('{}');
  const [inputUrl, setInputUrl] = useState(
    'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1200&auto=format&fit=crop'
  );
  const [inputRoom, setInputRoom] = useState('shadowcast-global');
  const [isRunning, setIsRunning] = useState(false);

  const scRef = useRef<ShadowCast | null>(null);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] ${msg}`, ...prev.slice(0, 49)]);
  };

  useEffect(() => {
    const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL || 'ws://localhost:8080/ws';
    const sc = new ShadowCast({
      signalingUrl,
      cache: { driver: 'indexeddb' },
    });
    scRef.current = sc;

    addLog(`Initialized ShadowCast instance (Peer ID: ${sc.peerId.slice(0, 8)}...)`);

    sc.on('connection:status', ({ state }) => addLog(`Event 'connection:status' -> ${state}`));
    sc.on('peer:join', ({ peerId, totalPeers }) =>
      addLog(`Event 'peer:join' -> Peer ${peerId.slice(0, 8)}... (Total: ${totalPeers})`)
    );
    sc.on('peer:leave', ({ peerId, totalPeers }) =>
      addLog(`Event 'peer:leave' -> Peer ${peerId.slice(0, 8)}... (Total: ${totalPeers})`)
    );
    sc.on('transfer:start', ({ url, source }) =>
      addLog(`Event 'transfer:start' -> source: ${source}, url: ${url.slice(0, 35)}...`)
    );
    sc.on('transfer:complete', ({ url, source, durationMs, bytes }) =>
      addLog(
        `Event 'transfer:complete' -> source: ${source}, bytes: ${bytes}, duration: ${durationMs}ms`
      )
    );
    sc.on('cache:hit', ({ url }) => addLog(`Event 'cache:hit' -> ${url.slice(0, 35)}...`));
    sc.on('bandwidth:saved', ({ bytes, cumulativeBytes }) =>
      addLog(`Event 'bandwidth:saved' -> saved: ${bytes} B, cumulative: ${cumulativeBytes} B`)
    );

    const interval = setInterval(() => {
      if (scRef.current) {
        setStatsJson(JSON.stringify(scRef.current.stats, null, 2));
      }
    }, 1000);

    return () => {
      clearInterval(interval);
      sc.destroy();
    };
  }, []);

  const handleConnect = async () => {
    if (!scRef.current) return;
    setIsRunning(true);
    try {
      addLog(`Executing: sc.connect("${inputRoom}")`);
      await scRef.current.connect(inputRoom);
      addLog(`Connected successfully to room "${inputRoom}"`);
    } catch (err: any) {
      addLog(`Error in connect: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleRequestAsset = async () => {
    if (!scRef.current || !inputUrl) return;
    setIsRunning(true);
    try {
      addLog(`Executing: await sc.requestAsset("${inputUrl.slice(0, 40)}...")`);
      const objectUrl = await scRef.current.requestAsset(inputUrl);
      addLog(`Resolved ObjectURL: ${objectUrl.slice(0, 35)}...`);
    } catch (err: any) {
      addLog(`Error in requestAsset: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleClearCache = async () => {
    if (!scRef.current) return;
    addLog(`Executing: await sc.clearCache()`);
    await scRef.current.clearCache();
    addLog(`Cache cleared successfully.`);
  };

  return (
    <div className="dashboard-container">
      <div className="header">
        <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: '1rem' }}>
          <Link href="/" className="preset-btn">
            ← Back to Mesh Dashboard
          </Link>
          <div className="header-badge" style={{ margin: 0 }}>
            🛠️ Interactive API Playground
          </div>
        </div>
        <h1>ShadowCast Playground</h1>
        <p>Test and inspect raw ShadowCast API methods and real-time events</p>
      </div>

      <div className="grid">
        {/* Controls Column */}
        <div className="panel">
          <div className="panel-title">Interactive API Controls</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <div className="stat-label" style={{ marginBottom: '0.4rem' }}>
                1. Room Connection (<code>sc.connect</code>)
              </div>
              <div className="input-row">
                <input
                  type="text"
                  className="url-input"
                  value={inputRoom}
                  onChange={(e) => setInputRoom(e.target.value)}
                  placeholder="room-name"
                />
                <button className="btn" style={{ padding: '0.6rem 1rem' }} onClick={handleConnect} disabled={isRunning}>
                  Connect
                </button>
              </div>
            </div>

            <div>
              <div className="stat-label" style={{ marginBottom: '0.4rem' }}>
                2. Request Asset (<code>sc.requestAsset</code>)
              </div>
              <div className="input-row">
                <input
                  type="text"
                  className="url-input"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  placeholder="https://..."
                />
                <button className="btn" style={{ padding: '0.6rem 1rem' }} onClick={handleRequestAsset} disabled={isRunning || !inputUrl}>
                  Request
                </button>
              </div>
            </div>

            <div>
              <div className="stat-label" style={{ marginBottom: '0.4rem' }}>
                3. Cache Actions (<code>sc.clearCache</code>)
              </div>
              <button
                onClick={handleClearCache}
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  color: '#f87171',
                  padding: '0.6rem 1rem',
                  borderRadius: '8px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Clear IndexedDB Cache
              </button>
            </div>

            <div>
              <div className="stat-label" style={{ marginBottom: '0.4rem' }}>
                Live Instance Stats (<code>sc.stats</code>)
              </div>
              <pre
                style={{
                  background: 'rgba(0, 0, 0, 0.4)',
                  padding: '0.85rem',
                  borderRadius: '10px',
                  border: '1px solid var(--panel-border)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '0.8rem',
                  color: 'var(--accent-color)',
                  overflowX: 'auto',
                }}
              >
                {statsJson}
              </pre>
            </div>
          </div>
        </div>

        {/* Live Console Output Column */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Real-Time Event & Execution Console</div>
            <button
              onClick={() => setLogs([])}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--panel-border)',
                color: 'var(--text-secondary)',
                padding: '0.25rem 0.6rem',
                borderRadius: '6px',
                fontSize: '0.75rem',
                cursor: 'pointer',
              }}
            >
              Clear Log
            </button>
          </div>

          <div
            style={{
              background: 'rgba(0, 0, 0, 0.5)',
              border: '1px solid var(--panel-border)',
              borderRadius: '12px',
              padding: '1rem',
              height: '420px',
              overflowY: 'auto',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: '0.8rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.35rem',
            }}
          >
            {logs.length === 0 && (
              <span style={{ color: 'var(--text-muted)' }}>Console is waiting for events...</span>
            )}
            {logs.map((log, i) => (
              <div key={i} style={{ color: log.includes('Error') ? '#f87171' : 'var(--text-primary)' }}>
                {log}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
