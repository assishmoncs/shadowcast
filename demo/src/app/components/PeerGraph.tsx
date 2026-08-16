'use client';

import React, { useEffect, useRef } from 'react';
import { TransferSource } from 'shadowcast';

interface PeerGraphProps {
  peersCount: number;
  activeSource: TransferSource | null;
  isStreaming: boolean;
}

export default function PeerGraph({ peersCount, activeSource, isStreaming }: PeerGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let particleOffset = 0;

    const render = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      // Handle Retina display pixel ratio
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) * 0.35;

      // Draw Origin CDN Node (top right corner)
      const originX = width - 40;
      const originY = 40;

      // Draw connection line to origin if downloading via HTTP
      if (activeSource === 'http') {
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(originX, originY);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw Origin Node
      ctx.beginPath();
      ctx.arc(originX, originY, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(168, 85, 247, 0.2)';
      ctx.fill();
      ctx.strokeStyle = '#a855f7';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#c084fc';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Origin', originX, originY + 24);

      // Determine display peer count (show at least 1 ghost peer if 0 to show topology)
      const displayPeers = Math.max(peersCount, 0);

      // Draw remote peer nodes around the center
      for (let i = 0; i < displayPeers; i++) {
        const angle = (i / displayPeers) * (Math.PI * 2) - Math.PI / 2;
        const peerX = centerX + Math.cos(angle) * radius;
        const peerY = centerY + Math.sin(angle) * radius;

        // Draw connecting link
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(peerX, peerY);
        ctx.strokeStyle =
          activeSource === 'p2p' && isStreaming
            ? 'rgba(0, 255, 159, 0.5)'
            : 'rgba(56, 189, 248, 0.2)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Draw animated data flow particles if streaming via P2P
        if (activeSource === 'p2p' && isStreaming) {
          const t = ((particleOffset + i * 0.3) % 1);
          const px = peerX + (centerX - peerX) * t;
          const py = peerY + (centerY - peerY) * t;

          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = '#00ff9f';
          ctx.shadowColor = '#00ff9f';
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // Draw peer node circle
        ctx.beginPath();
        ctx.arc(peerX, peerY, 12, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
        ctx.fill();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`P-${i + 1}`, peerX, peerY + 20);
      }

      // Draw Local Node (Center)
      ctx.beginPath();
      ctx.arc(centerX, centerY, 18, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 255, 159, 0.2)';
      ctx.fill();
      ctx.strokeStyle = '#00ff9f';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00ff9f';
      ctx.shadowBlur = isStreaming ? 16 : 8;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#00ff9f';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('You', centerX, centerY + 30);

      ctx.restore();

      particleOffset = (particleOffset + 0.015) % 1;
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [peersCount, activeSource, isStreaming]);

  return (
    <div style={{ width: '100%', height: '220px', position: 'relative' }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          borderRadius: '12px',
          background: 'rgba(0, 0, 0, 0.25)',
          border: '1px solid var(--panel-border)',
        }}
      />
    </div>
  );
}
