'use client';

// /mis-alumnos — la vista de alumnos del profesor.
// Una card por alumno: compacta por defecto, con tabs al expandir.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calcCurrentClassNumber } from '@/lib/db';
import { loadStudentBundles, norm, type StudentBundle } from '@/lib/misAlumnos';
import type { GeneratedClassIA } from '@/lib/aiTypes';
import StudentCard from '@/components/alumnos/StudentCard';
import { PAGE_CSS, Toast, cardStyle } from '@/components/alumnos/ui';

function MisAlumnosContent() {
  const { user } = useAuth();
  const { teachers, assignments, reloadAll } = useTeachers();
  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  const [bundles, setBundles] = useState<StudentBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const myAssignments = useMemo(
    () => (teacher ? assignments.filter(a => a.teacherId === teacher.id) : []),
    [teacher, assignments],
  );

  const load = useCallback(async () => {
    if (!teacher) return;
    const data = await loadStudentBundles(myAssignments);
    setBundles(data);
    setLoading(false);
  }, [teacher, myAssignments]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!teacher) return;
      const data = await loadStudentBundles(myAssignments);
      if (!cancelled) { setBundles(data); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [teacher, myAssignments]);

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 3200);
  }

  // La clase generada ya viene persistida del endpoint: actualizamos el estado
  // local para no tener que recargar toda la página.
  function setLocalNextClass(key: string, nc: GeneratedClassIA) {
    setBundles(prev => prev.map(b => {
      const bKey = b.assignment.studentId || `name:${norm(b.assignment.studentName)}`;
      if (bKey !== key || !b.profile) return b;
      return { ...b, profile: { ...b.profile, next_class_content: nc } };
    }));
  }

  const filtered = query.trim()
    ? bundles.filter(b => norm(b.assignment.studentName).includes(norm(query)))
    : bundles;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      <NavBar />
      <PullToRefresh onRefresh={async () => { await reloadAll(); await load(); }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 16px 48px' }}>
          <header style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>
              Mis alumnos
            </h1>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0 }}>
              {loading ? 'Cargando…' : `${bundles.length} ${bundles.length === 1 ? 'alumno activo' : 'alumnos activos'}`}
            </p>
          </header>

          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar por nombre"
            aria-label="Buscar alumno por nombre"
            style={{
              width: '100%', padding: '11px 14px', borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--bg-surface)',
              fontFamily: 'inherit', fontSize: 14, color: 'var(--text-primary)',
              marginBottom: 24,
            }}
          />

          {loading ? (
            <Skeleton />
          ) : !teacher ? (
            <div style={{ ...cardStyle, color: 'var(--text-muted)', fontSize: 14 }}>
              No se encontró tu ficha de profesor.
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ ...cardStyle, color: 'var(--text-muted)', fontSize: 14 }}>
              {query.trim()
                ? `No hay alumnos que coincidan con “${query.trim()}”.`
                : 'Todavía no tienes alumnos asignados.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {filtered.map(b => {
                const key = b.assignment.studentId || `name:${norm(b.assignment.studentName)}`;
                return (
                  <StudentCard
                    key={b.assignment.id}
                    bundle={b}
                    studentKey={key}
                    teacherName={teacher.name}
                    classNumber={calcCurrentClassNumber(b.assignment)}
                    onToast={showToast}
                    onRefresh={load}
                    onLocalNextClass={setLocalNextClass}
                  />
                );
              })}
            </div>
          )}
        </div>
      </PullToRefresh>

      {toast && <Toast message={toast} />}
    </div>
  );
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style dangerouslySetInnerHTML={{ __html: '@keyframes alu-pulse{0%,100%{opacity:1}50%{opacity:0.45}}' }} />
      {[0, 1, 2].map(i => (
        <div key={i} style={{ ...cardStyle, padding: 16, animation: 'alu-pulse 1.4s ease-in-out infinite' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--bg-surface-2)', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ height: 12, width: '35%', background: 'var(--bg-surface-2)', borderRadius: 4, marginBottom: 8 }} />
              <div style={{ height: 10, width: '55%', background: 'var(--bg-surface-2)', borderRadius: 4 }} />
            </div>
            <div style={{ height: 32, width: 84, background: 'var(--bg-surface-2)', borderRadius: 8, flexShrink: 0 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MisAlumnosPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <MisAlumnosContent />
    </AuthGuard>
  );
}
