'use client';

// /mis-alumnos — la vista de alumnos del profesor.
// Cuadrícula compacta con búsqueda por nombre y filtros rápidos por nivel /
// "sin ficha". Los tres números (activos, sin ficha, contador de cada chip)
// salen del dato real, no de constantes.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { Toast } from '@/components/alumnos/ui';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { getTeacherAssignments } from '@/lib/db';
import { regenerateFicha } from '@/lib/aiClient';
import { loadStudentBundles, norm, type StudentBundle } from '@/lib/misAlumnos';
import StudentCard, { fichaStateOf, levelOf } from '@/components/alumnos/StudentCard';

// 'all' | 'sin-ficha' | un nivel CEFR concreto.
type Filter = string;

function MisAlumnosContent() {
  const { user } = useAuth();
  const { teachers, reloadAll } = useTeachers();
  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  const [bundles, setBundles] = useState<StudentBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Los alumnos salen del GRID del profesor, no de `assignments`. Filtrar
  // assignments por teacherId mostraba acá alumnos que ya no estaban con él (sin
  // ninguna celda en su calendario): es el agujero que reportó una profesora.
  // La pertenencia la decide getTeacherAssignments y nadie más.
  const load = useCallback(async () => {
    if (!teacher) return;
    const data = await loadStudentBundles(await getTeacherAssignments(teacher));
    setBundles(data);
    setLoading(false);
  }, [teacher]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!teacher) return;
      const data = await loadStudentBundles(await getTeacherAssignments(teacher));
      if (!cancelled) { setBundles(data); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [teacher]);

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 3200);
  }

  // Genera la ficha desde las respuestas ya guardadas del formulario. Es la
  // misma acción que ofrece la página del alumno (regenerateFicha).
  async function handleGenerate(b: StudentBundle) {
    if (!b.profile || !teacher) return;
    setGeneratingId(b.assignment.id);
    try {
      await regenerateFicha({
        profileId: b.profile.id,
        teacherName: teacher.name,
        plan: b.assignment.plan,
        level: b.assignment.studentLevel,
      });
      await load();
      showToast(`Ficha de ${b.assignment.studentName} generada`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'No se pudo generar la ficha.');
    } finally {
      setGeneratingId(null);
    }
  }

  const sinFicha = bundles.filter(b => fichaStateOf(b) !== 'ready').length;

  // Los chips de nivel salen de los niveles que REALMENTE tienen los alumnos.
  const levels = useMemo(() => {
    const set = new Set<string>();
    for (const b of bundles) {
      const l = levelOf(b.assignment.studentLevel);
      if (l) set.add(l);
    }
    return [...set].sort();
  }, [bundles]);

  const matchesFilter = useCallback((b: StudentBundle) => {
    if (filter === 'all') return true;
    if (filter === 'sin-ficha') return fichaStateOf(b) !== 'ready';
    return levelOf(b.assignment.studentLevel) === filter;
  }, [filter]);

  const filtered = useMemo(() => {
    const q = query.trim();
    return bundles
      .filter(matchesFilter)
      .filter(b => !q || norm(b.assignment.studentName).includes(norm(q)));
  }, [bundles, query, matchesFilter]);

  const chips: Array<{ id: Filter; label: string; count: number }> = [
    { id: 'all', label: 'Todos', count: bundles.length },
    ...levels.map(l => ({
      id: l,
      label: l,
      count: bundles.filter(b => levelOf(b.assignment.studentLevel) === l).length,
    })),
    { id: 'sin-ficha', label: 'Sin ficha', count: sinFicha },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f2' }}>
      <NavBar />
      <PullToRefresh onRefresh={async () => { await reloadAll(); await load(); }}>
        <div className="alu">
          <header>
            <h1 className="alu-title">Mis alumnos</h1>
            <p className="alu-sub">
              {loading ? 'Cargando…' : (
                <>
                  {bundles.length} {bundles.length === 1 ? 'activo' : 'activos'}
                  {sinFicha > 0 && (
                    <> · <span className="is-warn">{sinFicha} sin ficha de IA</span></>
                  )}
                </>
              )}
            </p>
          </header>

          <div className="alu-search">
            <span className="alu-search-icon" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar por nombre"
              aria-label="Buscar alumno por nombre"
            />
          </div>

          <div className="alu-chips" role="group" aria-label="Filtrar alumnos">
            {chips.map(c => (
              <button
                key={c.id}
                className="alu-chip"
                aria-pressed={filter === c.id}
                onClick={() => setFilter(c.id)}
              >
                {c.label} <span className="alu-chip-count">{c.count}</span>
              </button>
            ))}
          </div>

          {loading ? (
            <Skeleton />
          ) : !teacher ? (
            <div className="alu-empty">No se encontró tu ficha de profesor.</div>
          ) : filtered.length === 0 ? (
            <div className="alu-empty">
              {query.trim()
                ? `No hay alumnos que coincidan con “${query.trim()}”.`
                : filter !== 'all'
                  ? 'Ningún alumno cumple este filtro.'
                  : 'Todavía no tienes alumnos asignados.'}
            </div>
          ) : (
            <div className="alu-grid">
              {filtered.map(b => (
                <StudentCard
                  key={b.assignment.id}
                  bundle={b}
                  studentKey={b.assignment.studentId || `name:${norm(b.assignment.studentName)}`}
                  generating={generatingId === b.assignment.id}
                  onGenerate={handleGenerate}
                />
              ))}
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
    <div className="alu-grid">
      <style dangerouslySetInnerHTML={{ __html: '@keyframes alu-pulse{0%,100%{opacity:1}50%{opacity:0.45}}' }} />
      {[0, 1, 2, 3, 4, 5].map(i => (
        <div key={i} className="alu-card" style={{ animation: 'alu-pulse 1.4s ease-in-out infinite' }}>
          <div className="alu-card-top">
            <div className="alu-avatar" style={{ background: '#eceeea' }} />
            <div style={{ flex: 1 }}>
              <div style={{ height: 11, width: '60%', background: '#eceeea', borderRadius: 4, marginBottom: 8 }} />
              <div style={{ height: 9, width: '40%', background: '#eceeea', borderRadius: 4 }} />
            </div>
          </div>
          <div style={{ height: 9, width: '50%', background: '#eceeea', borderRadius: 4 }} />
          <div style={{ height: 32, background: '#f4f5f2', borderRadius: 9, marginTop: 4 }} />
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
