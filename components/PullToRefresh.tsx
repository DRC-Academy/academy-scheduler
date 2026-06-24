'use client';
import { useRef, useState, useCallback, useEffect } from 'react';

interface Props {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
}

const THRESHOLD = 80;
const MAX_PULL  = 110;

export function PullToRefresh({ onRefresh, children }: Props) {
  const [pullY, setPullY]       = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullYRef   = useRef(0);
  const startYRef  = useRef(0);
  const activeRef  = useRef(false);
  const refreshingRef = useRef(false);

  const onTouchStart = useCallback((e: TouchEvent) => {
    if (window.scrollY > 2) return;
    startYRef.current = e.touches[0].clientY;
    activeRef.current = true;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!activeRef.current || refreshingRef.current) return;
    const delta = e.touches[0].clientY - startYRef.current;
    if (delta <= 0 || window.scrollY > 2) {
      activeRef.current = false;
      pullYRef.current  = 0;
      setPullY(0);
      return;
    }
    e.preventDefault();
    const clamped = Math.min(delta, MAX_PULL);
    pullYRef.current = clamped;
    setPullY(clamped);
  }, []);

  const onTouchEnd = useCallback(async () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const captured = pullYRef.current;
    pullYRef.current = 0;
    setPullY(0);
    if (captured >= THRESHOLD && !refreshingRef.current) {
      refreshingRef.current = true;
      setRefreshing(true);
      try { await onRefresh(); } finally {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    }
  }, [onRefresh]);

  useEffect(() => {
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove',  onTouchMove,  { passive: false });
    document.addEventListener('touchend',   onTouchEnd);
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove',  onTouchMove);
      document.removeEventListener('touchend',   onTouchEnd);
    };
  }, [onTouchStart, onTouchMove, onTouchEnd]);

  const progress    = Math.min(pullY / THRESHOLD, 1);
  const showBanner  = refreshing || pullY > 8;
  const bannerOpacity = refreshing ? 1 : progress;

  return (
    <>
      {/* Refresh indicator — fixed, just below the sticky navbar */}
      {showBanner && (
        <div style={{
          position: 'fixed',
          top: 56,
          left: 0, right: 0,
          zIndex: 39,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '7px 0',
          background: 'var(--bg-base)',
          borderBottom: `1px solid ${refreshing ? '#1E9E3A' : 'var(--border)'}`,
          opacity: bannerOpacity,
          transition: 'opacity 0.2s',
          pointerEvents: 'none',
        }}>
          <div style={{
            width: 16, height: 16, borderRadius: '50%',
            border: '2.5px solid #1E9E3A',
            borderTopColor: 'transparent',
            flexShrink: 0,
            ...(refreshing
              ? { animation: 'ptr-spin 0.65s linear infinite' }
              : { transform: `rotate(${progress * 270}deg)`, transition: 'none' }),
          }} />
          <span style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 600 }}>
            {refreshing
              ? 'Actualizando...'
              : progress >= 1
                ? 'Soltá para actualizar'
                : 'Tirá para actualizar'}
          </span>
        </div>
      )}

      <style>{`@keyframes ptr-spin { to { transform: rotate(360deg); } }`}</style>

      {children}
    </>
  );
}
