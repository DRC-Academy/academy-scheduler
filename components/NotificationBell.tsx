'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { supabase } from '@/lib/supabase';
import {
  dbGetNotificationsForUser,
  dbMarkNotificationRead,
  dbMarkAllNotificationsRead,
  dbUpsertTeacherAlerts,
} from '@/lib/db';
import { AppNotification } from '@/types';
import { Bell } from 'lucide-react';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(isoDate: string): string {
  const now     = new Date();
  const date    = new Date(isoDate);
  const diffMs  = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffH   = Math.floor(diffMin / 60);
  const diffD   = Math.floor(diffH / 24);

  if (diffMin < 1)   return 'ahora';
  if (diffMin < 60)  return `hace ${diffMin} min`;
  if (diffH < 24)    return `hace ${diffH} h`;
  if (diffD === 1)   return 'ayer';
  if (diffD < 7)     return `hace ${diffD} días`;
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

function notifIcon(type: string): string {
  if (type === 'clase15')              return '🎬';
  if (type === 'bono6m')               return '🎁';
  if (type === 'new_student')          return '📚';
  if (type === 'new_assignment')       return '📚';
  if (type === 'student_removed')      return '❌';
  if (type === 'subscription_cancelled') return '❌';
  return '📢';
}

// ─── Main component ───────────────────────────────────────────────────────────

// `compact` = campana de línea + punto rojo (sin contador). Es opt-in para que
// el resto de los roles conserve la campana actual con el número.
export function NotificationBell({ compact = false }: { compact?: boolean } = {}) {
  const { user }        = useAuth();
  const { assignments } = useTeachers();
  const router          = useRouter();

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open,          setOpen]          = useState(false);
  const [loading,       setLoading]       = useState(false);
  const [shaking,       setShaking]       = useState(false);
  const bellRef         = useRef<HTMLDivElement>(null);
  const alertsDone      = useRef(false);

  if (!user) return null;

  // For teachers use teacherId so it matches target_user set by admin
  const userId = user.teacherId ?? user.id;
  const role   = user.role;

  const unread = notifications.filter(n => !n.readBy.includes(userId));
  const unreadCount = unread.length;

  // ── Load notifications ─────────────────────────────────────────────────────
  async function load() {
    setLoading(true);
    const data = await dbGetNotificationsForUser(userId, role);
    setNotifications(data);
    setLoading(false);
  }

  // Initial load
  useEffect(() => { load(); }, [userId]);

  // Generate system alerts for teachers (once per session, after assignments load)
  useEffect(() => {
    if (user.role !== 'teacher' || !user.teacherId || alertsDone.current) return;
    const mine = assignments.filter(a => a.teacherId === user.teacherId);
    if (mine.length === 0) return;
    alertsDone.current = true;
    dbUpsertTeacherAlerts(user.teacherId, mine).then(load);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.teacherId, assignments.length]);

  // ── Supabase Realtime ──────────────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel(`bell_${user.id}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on('postgres_changes' as any, {
        event:  'INSERT',
        schema: 'public',
        table:  'notifications',
      }, (payload: any) => {
        const row = payload.new;
        const relevant = row.target_user === userId || row.target_role === role;
        if (!relevant) return;

        const fresh: AppNotification = {
          id:         row.id,
          targetUser: row.target_user  ?? undefined,
          targetRole: row.target_role  ?? undefined,
          title:      row.title,
          body:       row.body,
          type:       row.type,
          readBy:     row.read_by      ?? [],
          createdAt:  row.created_at,
          createdBy:  row.created_by,
        };
        setNotifications(prev => {
          if (prev.some(n => n.id === fresh.id)) return prev;
          return [fresh, ...prev];
        });
        setShaking(true);
        setTimeout(() => setShaking(false), 1200);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, role]);

  // ── Close on outside click ─────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // ── Actions ────────────────────────────────────────────────────────────────
  async function markOne(notifId: string) {
    await dbMarkNotificationRead(notifId, userId);
    setNotifications(prev => prev.map(n =>
      n.id === notifId && !n.readBy.includes(userId)
        ? { ...n, readBy: [...n.readBy, userId] }
        : n,
    ));
  }

  async function markAll() {
    await dbMarkAllNotificationsRead(userId, role);
    setNotifications(prev => prev.map(n => ({
      ...n,
      readBy: n.readBy.includes(userId) ? n.readBy : [...n.readBy, userId],
    })));
  }

  // Lleva a la sección de avisos del rol. El `?tab=notifications` es lo que hace
  // que se aterrice en la pestaña correcta: sin él las páginas abren en su
  // pestaña por defecto (calendario / resumen) y el aviso queda sin verse.
  function goToNotifications() {
    setOpen(false);
    if (role === 'teacher')     router.push('/teacher?tab=notifications');
    else if (role === 'admin')  router.push('/admin?tab=notifications');
  }

  // Click en un aviso: marcarlo leído y llevar a la sección de avisos.
  function openNotification(notifId: string, isRead: boolean) {
    if (!isRead) markOne(notifId);
    goToNotifications();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Shake keyframe — injected once when component mounts */}
      <style>{`
        @keyframes bell-shake {
          0%,100% { transform: rotate(0deg); }
          20%     { transform: rotate(-14deg); }
          40%     { transform: rotate(14deg); }
          60%     { transform: rotate(-8deg); }
          80%     { transform: rotate(8deg); }
        }
        .bell-animated { animation: bell-shake 0.55s ease-in-out; }
      `}</style>

      <div ref={bellRef} style={{ position: 'relative', flexShrink: 0 }}>

        {/* ── Bell button ── */}
        <button
          onClick={() => setOpen(v => !v)}
          className={shaking ? 'bell-animated' : ''}
          aria-label="Notificaciones"
          style={{
            position: 'relative',
            width: 40, height: 40,
            borderRadius: '50%',
            border: 'none',
            background: open ? 'rgba(30,158,58,0.12)' : 'transparent',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18,
            transition: 'background 0.15s',
          }}
        >
          {compact ? <Bell size={19} strokeWidth={1.75} color="#5f6360" /> : '🔔'}

          {/* Unread badge — punto simple en compacto, contador en el resto. */}
          {unreadCount > 0 && (compact ? (
            <span aria-label={`${unreadCount} sin leer`} style={{
              position: 'absolute', top: 7, right: 8,
              width: 8, height: 8, borderRadius: '50%',
              background: '#ef4444', boxShadow: '0 0 0 2px #fff',
              pointerEvents: 'none',
            }} />
          ) : (
            <span style={{
              position: 'absolute',
              top: 4, right: 4,
              minWidth: 17, height: 17,
              borderRadius: 9,
              background: '#ef4444',
              color: 'white',
              fontSize: 10, fontWeight: 800,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 3px',
              lineHeight: 1,
              boxShadow: '0 0 0 2px var(--bg-surface)',
              fontFamily: 'inherit',
              pointerEvents: 'none',
            }}>
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ))}
        </button>

        {/* ── Dropdown panel ── */}
        {open && (
          <div style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 'clamp(300px, 90vw, 360px)',
            maxHeight: '80vh',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
            zIndex: 200,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>

            {/* Panel header */}
            <div style={{
              padding: '14px 18px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
              background: 'var(--bg-surface)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
                  Notificaciones
                </span>
                {unreadCount > 0 && (
                  <span style={{
                    fontSize: 11, padding: '1px 8px', borderRadius: 10,
                    background: 'rgba(239,68,68,0.1)', color: '#ef4444', fontWeight: 700,
                  }}>
                    {unreadCount} nueva{unreadCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              {unreadCount > 0 && (
                <button onClick={markAll} style={{
                  background: 'none', border: 'none',
                  color: '#1E9E3A', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                  padding: '3px 6px', borderRadius: 6,
                  whiteSpace: 'nowrap',
                }}>
                  ✓ Marcar todas
                </button>
              )}
            </div>

            {/* Notification list */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {loading ? (
                <div style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  Cargando...
                </div>
              ) : notifications.length === 0 ? (
                <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                  <div style={{ fontSize: 34, marginBottom: 10 }}>🔔</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                    No tienes notificaciones
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Te avisaremos cuando haya novedades
                  </div>
                </div>
              ) : (
                notifications.map(n => {
                  const isRead = n.readBy.includes(userId);
                  return (
                    <button
                      key={n.id}
                      onClick={() => openNotification(n.id, isRead)}
                      style={{
                        width: '100%', textAlign: 'left',
                        padding: '11px 16px',
                        borderBottom: '1px solid var(--border)',
                        background: isRead ? 'transparent' : 'rgba(30,158,58,0.045)',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex', gap: 10, alignItems: 'flex-start',
                        fontFamily: 'inherit',
                        transition: 'background 0.12s',
                      }}
                    >
                      {/* Unread indicator dot */}
                      <div style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: isRead ? 'transparent' : '#1E9E3A',
                        flexShrink: 0, marginTop: 7,
                      }} />

                      {/* Type icon */}
                      <div style={{ fontSize: 20, flexShrink: 0, lineHeight: '1.4' }}>
                        {notifIcon(n.type)}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontWeight: isRead ? 500 : 700,
                          fontSize: 13,
                          color: 'var(--text-primary)',
                          marginBottom: 3,
                          lineHeight: 1.35,
                        }}>
                          {n.title}
                        </div>
                        <div style={{
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          lineHeight: 1.45,
                          overflow: 'hidden',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}>
                          {n.body}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                          {timeAgo(n.createdAt)}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Panel footer */}
            {notifications.length > 0 && (
              <button onClick={goToNotifications} style={{
                padding: '11px',
                borderTop: '1px solid var(--border)',
                background: 'var(--bg-surface-2)',
                border: 'none',
                borderBottomLeftRadius: 14,
                borderBottomRightRadius: 14,
                color: '#1E9E3A',
                fontSize: 13, fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                width: '100%',
                flexShrink: 0,
              }}>
                Ver todas las notificaciones →
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
