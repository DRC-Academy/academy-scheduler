'use client';
// ── "Mis clases" del profesor (/clases) ───────────────────────────────────────
//
// Sección propia, con su botón en el header. Es la agenda que hasta ahora era una
// pestaña dentro del Calendario (/teacher → "Mis clases"): el panel es EL MISMO
// componente (components/MisClasesPanel), solo que ahora vive en su ruta.
//
// Esta página es únicamente el contenedor: trae los datos que el panel necesita
// (alumnos del grid, grid, índice de formularios) y lo monta. Toda la lógica de
// la agenda está en el panel.
import { useState, useEffect, useCallback } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { getTeacherAssignments, dbGetTeacherGrid, dbSaveTeacherGrid } from '@/lib/db';
import { fetchFormTokensIndex } from '@/lib/formClient';
import { MisClasesPanel, type FormIndex } from '@/components/MisClasesPanel';
import type { Assignment, Grid } from '@/types';

const EMPTY_FORM_INDEX: FormIndex = { byId: new Map(), byName: new Map() };

function ClasesContent() {
  const { user } = useAuth();
  const {
    teachers, students, classRecords, classAnalyses, classJoinLogs,
    updateMeetLink, logClassJoin, addRescheduleRecord, registerClassRecord,
    loadFinanceData, reloadAll,
  } = useTeachers();

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  const [myAssignments, setMyAssignments] = useState<Assignment[]>([]);
  const [grid, setGrid] = useState<Grid>({});
  const [formIndex, setFormIndex] = useState<FormIndex>(EMPTY_FORM_INDEX);
  const [loading, setLoading] = useState(true);

  // Los alumnos salen del GRID (getTeacherAssignments), nunca de filtrar
  // `assignments` por teacherId: esa es la única función que decide qué alumnos
  // son de este profesor. El grid además aporta las recuperaciones puntuales.
  useEffect(() => {
    if (!teacher) return;
    let cancelled = false;
    Promise.all([getTeacherAssignments(teacher), dbGetTeacherGrid(teacher.id)])
      .then(([rows, g]) => {
        if (cancelled) return;
        setMyAssignments(rows);
        setGrid(g);
      })
      .catch(err => console.error('[clases] No se pudieron cargar las clases:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // Por ID, no por el objeto `teacher`: la lista se recarga cada 60 s y su
  // identidad cambia en cada recarga, lo que relanzaría la lectura en bucle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id]);

  const refreshFormIndex = useCallback(() => {
    fetchFormTokensIndex().then(setFormIndex).catch(() => {});
  }, []);

  // classRecords (cancelaciones/reprogramaciones) y classAnalyses (transcripts
  // ya subidos) llegan por el contexto de finanzas.
  useEffect(() => {
    loadFinanceData();
    refreshFormIndex();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guardar el grid: el panel lo toca al reprogramar una clase (marca la celda
  // original y crea la de recuperación).
  const handleGridChange = useCallback(async (g: Grid) => {
    if (!teacher) return;
    setGrid(g);
    await dbSaveTeacherGrid(teacher.id, g);
  }, [teacher?.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f2' }}>
      <NavBar />
      <PullToRefresh onRefresh={async () => { await reloadAll(); await loadFinanceData(); }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 16px 48px' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#8b8e88' }}>
              <span className="mc-dot" style={{ background: '#16a34a' }} />
              <LastUpdated />
            </span>
          </div>

          {!teacher || loading ? (
            <div className="mc">
              <div className="mc-empty">Cargando tus clases…</div>
            </div>
          ) : (
            <MisClasesPanel
              teacher={teacher}
              myAssignments={myAssignments}
              students={students}
              classRecords={classRecords}
              classAnalyses={classAnalyses}
              classJoinLogs={classJoinLogs}
              grid={grid}
              onGridChange={handleGridChange}
              updateMeetLink={updateMeetLink}
              logClassJoin={logClassJoin}
              addRescheduleRecord={addRescheduleRecord}
              registerClassRecord={registerClassRecord}
              onDataChanged={loadFinanceData}
              formIndex={formIndex}
              refreshFormIndex={refreshFormIndex}
            />
          )}
        </div>
      </PullToRefresh>
    </div>
  );
}

export default function ClasesPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <ClasesContent />
    </AuthGuard>
  );
}
